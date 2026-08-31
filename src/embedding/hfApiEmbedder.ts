import "dotenv/config";
import * as config from "../config.ts";
import { EmbeddingCache } from "./cache.ts";
import { QUERY_PREFIX, isEmbeddable, isUnitLength, normalize } from "./shared.ts";
import type { Embedder } from "./base.ts";

/**
 * Embeddings from the hosted HuggingFace Inference API.
 *
 * The API call itself is one POST. Everything else in this file exists because a
 * network sits between us and the model, which introduces four failure modes
 * that in-process inference simply does not have:
 *
 *  - **The endpoint is cold.** A model that has not been used recently returns
 *    503 while it loads. `wait_for_model` asks it to block instead, and retries
 *    cover the rest.
 *  - **Rate limits.** A 300-page PDF is thousands of chunks. 429 is expected,
 *    not exceptional, so backoff is mandatory rather than defensive.
 *  - **Partial failure.** A request can fail after minutes of successful work.
 *    The cache means a retry does not re-pay for what already succeeded.
 *  - **The response shape is not guaranteed.** See `toVectors` - this is the
 *    part most likely to bite, because getting it wrong produces plausible
 *    numbers rather than an error.
 */

/** Statuses worth trying again. 429 is rate limiting, 503 is a cold model. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

interface HfRequest {
  inputs: string[];
  options: { wait_for_model: boolean };
}

export interface HfApiEmbedderOptions {
  modelId?: string;
  token?: string;
  cache?: EmbeddingCache | null;
  /** Injectable for tests, so the suite never touches the network. */
  fetchImpl?: typeof fetch;
}

export class HfApiEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimensions = config.EMBEDDING_DIMENSIONS;
  readonly maxInputTokens = 512;

  private token: string;
  private url: string;
  private cache: EmbeddingCache | null;
  private fetchImpl: typeof fetch;
  /** Warn once, not once per batch. */
  private warnedUnnormalised = false;

  constructor(options: HfApiEmbedderOptions = {}) {
    const token = options.token ?? process.env["HF_TOKEN"];
    if (!token) {
      throw new Error(
        "HF_TOKEN not found. Add it to a .env file in the project root, or set " +
          "EMBEDDING_PROVIDER = \"local\" in src/config.ts to embed offline.",
      );
    }
    this.token = token;
    this.modelId = options.modelId ?? config.HF_EMBEDDING_MODEL;
    this.url = config.HF_API_URL.replace("{model}", this.modelId);
    this.cache =
      options.cache === undefined
        ? config.CACHE_EMBEDDINGS
          ? new EmbeddingCache()
          : null
        : options.cache;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * One request, with retries.
   *
   * Retryable failures back off exponentially with jitter; `Retry-After` is
   * honoured when the server sends it. Authentication and "no such model"
   * failures are fatal and reported immediately, because retrying them just
   * wastes a minute before showing the same message.
   */
  private async post(inputs: string[]): Promise<unknown> {
    const body: HfRequest = { inputs, options: { wait_for_model: true } };
    let lastError: unknown;

    for (let attempt = 1; attempt <= config.HF_MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.HF_TIMEOUT_MS);
      try {
        const response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.ok) return await response.json();

        const detail = (await response.text().catch(() => "")).slice(0, 200);
        if (!RETRYABLE.has(response.status)) {
          throw new Error(
            `HuggingFace API ${response.status} for ${this.modelId}: ${detail}`,
          );
        }
        lastError = new Error(`HuggingFace API ${response.status}: ${detail}`);
        await this.wait(attempt, response.headers.get("retry-after"));
      } catch (error) {
        // A fatal status was rethrown above; do not swallow it into a retry.
        if (error instanceof Error && /HuggingFace API \d+ for /.test(error.message)) {
          throw error;
        }
        lastError = error;
        if (attempt < config.HF_MAX_ATTEMPTS) await this.wait(attempt, null);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(
      `HuggingFace API failed after ${config.HF_MAX_ATTEMPTS} attempts: ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private async wait(attempt: number, retryAfter: string | null): Promise<void> {
    const advised = retryAfter ? Number(retryAfter) * 1000 : Number.NaN;
    // Jitter matters: without it, a burst of parallel requests all retry in
    // lockstep and trip the rate limit again together.
    const backoff = config.HF_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
    const delay = Number.isFinite(advised) ? Math.max(advised, backoff) : backoff;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * Turns whatever the API returned into one unit vector per input.
   *
   * The shape genuinely varies. A sentence-transformers model usually returns
   * one pooled vector per input, but the same endpoint can return the full token
   * matrix instead, and a single input may or may not be wrapped in an array. So
   * the nesting depth is measured rather than assumed:
   *
   *   number[]       one vector
   *   number[][]     a batch of vectors, OR one input's token matrix
   *   number[][][]   a batch of token matrices
   *
   * Where a token matrix appears, row 0 is the [CLS] token - which is the
   * pooling bge is built for, and what the local path uses.
   */
  private toVectors(payload: unknown, expected: number): number[][] {
    const fail = (why: string): never => {
      throw new Error(
        `Unexpected embedding response from ${this.modelId}: ${why}. ` +
          "Run `npm run notebook -- embed-check` to inspect what the API returns.",
      );
    };

    if (!Array.isArray(payload)) return fail(`expected an array, got ${typeof payload}`);
    if (payload.length === 0) return fail("empty response");

    let rows: number[][];
    if (typeof payload[0] === "number") {
      // One flat vector. Only valid when one input was sent.
      rows = [payload as number[]];
    } else if (Array.isArray(payload[0]) && typeof (payload[0] as unknown[])[0] === "number") {
      const matrix = payload as number[][];
      rows =
        expected === 1 && matrix.length !== 1
          ? [matrix[0]!] // one input, token matrix -> [CLS]
          : matrix; // one vector per input
    } else if (Array.isArray(payload[0])) {
      // A batch of token matrices: take each one's [CLS].
      rows = (payload as number[][][]).map((matrix) => matrix[0]!);
    } else {
      return fail("could not identify the nesting");
    }

    if (rows.length !== expected) {
      return fail(`asked for ${expected} vectors, got ${rows.length}`);
    }
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== this.dimensions) {
        return fail(`expected ${this.dimensions} dimensions, got ${row?.length}`);
      }
      if (row.some((value) => !Number.isFinite(value))) {
        return fail("response contained non-finite numbers");
      }
    }

    // The API makes no promise about normalisation, and the vector store's dot
    // product is only a cosine for unit vectors. Normalise regardless, and say
    // so once, because it is a useful thing to know about your endpoint.
    if (!this.warnedUnnormalised && rows[0] && !isUnitLength(rows[0])) {
      console.log("  note: API returned unnormalised vectors - normalising locally");
      this.warnedUnnormalised = true;
    }
    return rows.map(normalize);
  }

  /** Splits texts into batches bounded by both count and payload bytes. */
  private batches(texts: string[]): number[][] {
    const batches: number[][] = [];
    let current: number[] = [];
    let bytes = 0;

    for (const [index, text] of texts.entries()) {
      const size = Buffer.byteLength(text, "utf8");
      if (
        current.length > 0 &&
        (current.length >= config.HF_BATCH_SIZE || bytes + size > config.HF_BATCH_BYTES)
      ) {
        batches.push(current);
        current = [];
        bytes = 0;
      }
      current.push(index);
      bytes += size;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const vectors: number[][] = new Array(texts.length);

    // Anything already embedded for this exact model is free.
    const cached = this.cache?.get(this.modelId, texts) ?? new Map<number, number[]>();
    for (const [index, vector] of cached) vectors[index] = vector;

    const pending = texts
      .map((_, index) => index)
      .filter((index) => !cached.has(index) && isEmbeddable(texts[index]!));

    // Empty text would embed to a valid-looking vector that matches queries.
    for (const [index, text] of texts.entries()) {
      if (!cached.has(index) && !isEmbeddable(text)) {
        vectors[index] = new Array(this.dimensions).fill(0);
      }
    }

    const batches = this.batches(pending.map((index) => texts[index]!)).map((batch) =>
      batch.map((offset) => pending[offset]!),
    );

    // Bounded concurrency: several requests in flight for throughput, few enough
    // that the endpoint does not start refusing them.
    let next = 0;
    const fresh: { text: string; vector: number[] }[] = [];
    const workers = Array.from(
      { length: Math.min(config.HF_CONCURRENCY, batches.length) },
      async () => {
        while (true) {
          const mine = next++;
          const batch = batches[mine];
          if (!batch) return;
          const inputs = batch.map((index) => texts[index]!);
          const produced = this.toVectors(await this.post(inputs), inputs.length);
          for (const [position, index] of batch.entries()) {
            vectors[index] = produced[position]!;
            fresh.push({ text: texts[index]!, vector: produced[position]! });
          }
        }
      },
    );
    await Promise.all(workers);

    this.cache?.put(this.modelId, fresh);
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    if (!isEmbeddable(text)) throw new Error("cannot embed an empty query");
    // The prefix is part of the query, so it is part of the cache key too.
    const prefixed = QUERY_PREFIX + text;
    const cached = this.cache?.get(this.modelId, [prefixed]);
    const hit = cached?.get(0);
    if (hit) return hit;

    const vector = this.toVectors(await this.post([prefixed]), 1)[0]!;
    this.cache?.put(this.modelId, [{ text: prefixed, vector }]);
    return vector;
  }
}
