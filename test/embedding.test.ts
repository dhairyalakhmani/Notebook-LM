import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as config from "../src/config.ts";
import { EmbeddingCache } from "../src/embedding/cache.ts";
import { HfApiEmbedder } from "../src/embedding/hfApiEmbedder.ts";
import { isUnitLength, normalize } from "../src/embedding/shared.ts";
import { checkBudget, estimateModelTokens, findOversized } from "../src/embedding/limits.ts";
import { VectorStore } from "../src/search/vectorStore.ts";

const TOKEN = "test-token";
const DIMS = config.EMBEDDING_DIMENSIONS;

function fakeVector(seed: number, scale = 1): number[] {
  return Array.from({ length: DIMS }, (_, i) => scale * Math.sin(seed + i));
}

interface StubOptions {
  failures?: number[];
  body?: (inputs: string[]) => unknown;
  headers?: Record<string, string>;
}

function stubFetch(options: StubOptions = {}) {
  const calls: { inputs: string[] }[] = [];
  const failures = [...(options.failures ?? [])];

  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(init?.body as string) as { inputs: string[] };
    calls.push({ inputs: parsed.inputs });

    const status = failures.shift();
    if (status !== undefined) {
      return new Response("upstream said no", {
        status,
        headers: options.headers ?? {},
      });
    }
    const body =
      options.body?.(parsed.inputs) ?? parsed.inputs.map((_, index) => fakeVector(index + 1));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function embedder(fetchImpl: typeof fetch, cache: EmbeddingCache | null = null) {
  return new HfApiEmbedder({ token: TOKEN, fetchImpl, cache });
}

function freshCache(): EmbeddingCache {
  return new EmbeddingCache(mkdtempSync(join(tmpdir(), "nblm-emb-")));
}

describe("HfApiEmbedder - contract", () => {
  it("reports its model, dimensions and input limit", () => {
    const e = embedder(stubFetch().impl);
    assert.equal(e.modelId, config.HF_EMBEDDING_MODEL);
    assert.equal(e.dimensions, DIMS);
    assert.equal(e.maxInputTokens, 512);
  });

  it("refuses to construct without a token", () => {
    const saved = process.env["HF_TOKEN"];
    delete process.env["HF_TOKEN"];
    try {
      assert.throws(() => new HfApiEmbedder({ cache: null }), /HF_TOKEN not found/);
    } finally {
      if (saved !== undefined) process.env["HF_TOKEN"] = saved;
    }
  });

  it("sends the bearer token", async () => {
    let auth: string | null = null;
    const impl = (async (_u: unknown, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify([fakeVector(1)]), { status: 200 });
    }) as unknown as typeof fetch;
    await embedder(impl).embedDocuments(["one"]);
    assert.equal(auth, `Bearer ${TOKEN}`);
  });
});

describe("HfApiEmbedder - response shapes", () => {
  it("accepts one vector per input", async () => {
    const vectors = await embedder(stubFetch().impl).embedDocuments(["a", "b", "c"]);
    assert.equal(vectors.length, 3);
    assert.ok(vectors.every((v) => v.length === DIMS));
  });

  it("accepts a flat vector for a single input", async () => {
    const { impl } = stubFetch({ body: () => fakeVector(1) });
    const vectors = await embedder(impl).embedDocuments(["only one"]);
    assert.equal(vectors.length, 1);
    assert.equal(vectors[0]!.length, DIMS);
  });

  it("takes [CLS] when a single input returns a token matrix", async () => {
    // The endpoint can return per-token embeddings instead of a pooled vector.
    const cls = fakeVector(9);
    const { impl } = stubFetch({ body: () => [cls, fakeVector(2), fakeVector(3)] });
    const vectors = await embedder(impl).embedDocuments(["one input"]);
    assert.equal(vectors.length, 1, "one input must yield one vector");
    assert.deepEqual(vectors[0], normalize(cls), "row 0 is the CLS token");
  });

  it("takes [CLS] from each of a batch of token matrices", async () => {
    const { impl } = stubFetch({
      body: (inputs) => inputs.map((_, i) => [fakeVector(i + 1), fakeVector(99)]),
    });
    const vectors = await embedder(impl).embedDocuments(["a", "b"]);
    assert.equal(vectors.length, 2);
    assert.deepEqual(vectors[0], normalize(fakeVector(1)));
  });

  it("always returns unit-length vectors, even from an unnormalised API", async () => {
    const { impl } = stubFetch({ body: (i) => i.map((_, n) => fakeVector(n + 1, 37)) });
    const vectors = await embedder(impl).embedDocuments(["a", "b"]);
    for (const vector of vectors) {
      assert.ok(isUnitLength(vector), "vectorStore's dot product needs unit vectors");
    }
  });

  it("rejects the wrong number of dimensions", async () => {
    const { impl } = stubFetch({ body: () => [[1, 2, 3]] });
    await assert.rejects(() => embedder(impl).embedDocuments(["a"]), /expected 384 dimensions/);
  });

  it("rejects a vector count that does not match the inputs", async () => {
    const { impl } = stubFetch({ body: () => [fakeVector(1)] });
    await assert.rejects(
      () => embedder(impl).embedDocuments(["a", "b", "c"]),
      /asked for 3 vectors, got 1/,
    );
  });

  it("rejects non-finite numbers", async () => {
    const { impl } = stubFetch({
      body: () => [Array.from({ length: DIMS }, (_, i) => (i === 5 ? Number.NaN : 0.1))],
    });
    await assert.rejects(() => embedder(impl).embedDocuments(["a"]), /non-finite/);
  });

  it("rejects a non-array response", async () => {
    const { impl } = stubFetch({ body: () => ({ error: "loading" }) });
    await assert.rejects(() => embedder(impl).embedDocuments(["a"]), /expected an array/);
  });
});

describe("HfApiEmbedder - retries", () => {
  it("retries a 503 cold model and succeeds", async () => {
    const { impl, calls } = stubFetch({ failures: [503] });
    const vectors = await embedder(impl).embedDocuments(["a"]);
    assert.equal(calls.length, 2, "one failure, one success");
    assert.equal(vectors.length, 1);
  });

  it("retries a 429 rate limit", async () => {
    const { impl, calls } = stubFetch({ failures: [429], headers: { "retry-after": "0" } });
    await embedder(impl).embedDocuments(["a"]);
    assert.equal(calls.length, 2);
  });

  it("does not retry a 401 - it would never succeed", async () => {
    const { impl, calls } = stubFetch({ failures: [401] });
    await assert.rejects(() => embedder(impl).embedDocuments(["a"]), /401/);
    assert.equal(calls.length, 1, "a bad token must fail immediately");
  });

  it("does not retry a 404 for an unserved model", async () => {
    const { impl, calls } = stubFetch({ failures: [404] });
    await assert.rejects(() => embedder(impl).embedDocuments(["a"]), /404/);
    assert.equal(calls.length, 1);
  });

  it("gives up after the attempt limit, saying so", async () => {
    const { impl, calls } = stubFetch({
      failures: Array(config.HF_MAX_ATTEMPTS + 2).fill(503),
      headers: { "retry-after": "0" },
    });
    await assert.rejects(
      () => embedder(impl).embedDocuments(["a"]),
      new RegExp(`failed after ${config.HF_MAX_ATTEMPTS} attempts`),
    );
    assert.equal(calls.length, config.HF_MAX_ATTEMPTS);
  });
});

describe("HfApiEmbedder - batching", () => {
  it("batches by count", async () => {
    const { impl, calls } = stubFetch();
    const texts = Array.from({ length: config.HF_BATCH_SIZE * 2 + 5 }, (_, i) => `text ${i}`);
    const vectors = await embedder(impl).embedDocuments(texts);
    assert.equal(vectors.length, texts.length);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.inputs.length <= config.HF_BATCH_SIZE));
  });

  it("batches by payload size as well as count", async () => {
    const { impl, calls } = stubFetch();
    // Four texts, each a quarter of the byte budget plus change: cannot all fit.
    const big = "x".repeat(Math.floor(config.HF_BATCH_BYTES / 3));
    await embedder(impl).embedDocuments([big, big, big, big]);
    assert.ok(calls.length > 1, "the byte cap must force a split before the count cap");
  });

  it("keeps the caller's order across batches", async () => {
    // Vector n encodes its input's index, so a reordering would be visible.
    const { impl } = stubFetch({
      body: (inputs) => inputs.map((text) => fakeVector(Number(text.split(" ")[1]) + 1)),
    });
    const texts = Array.from({ length: 70 }, (_, i) => `text ${i}`);
    const vectors = await embedder(impl).embedDocuments(texts);
    for (const [index] of texts.entries()) {
      assert.deepEqual(vectors[index], normalize(fakeVector(index + 1)), `index ${index}`);
    }
  });

  it("returns an empty array for no input, calling nothing", async () => {
    const { impl, calls } = stubFetch();
    assert.deepEqual(await embedder(impl).embedDocuments([]), []);
    assert.equal(calls.length, 0);
  });

  it("never sends empty text, and zero-fills its slot", async () => {
    const { impl, calls } = stubFetch();
    const vectors = await embedder(impl).embedDocuments(["real text", "   ", "more text"]);
    assert.equal(vectors.length, 3);
    assert.ok(calls.every((c) => c.inputs.every((t) => t.trim().length > 0)));
    assert.ok(
      vectors[1]!.every((x) => x === 0),
      "blank text gets a zero vector",
    );
  });
});

describe("HfApiEmbedder - queries", () => {
  it("prefixes the query and not the passages", async () => {
    const { impl, calls } = stubFetch();
    const e = embedder(impl);
    await e.embedDocuments(["a passage"]);
    await e.embedQuery("a question");
    assert.equal(calls[0]!.inputs[0], "a passage", "passages are sent bare");
    assert.match(calls[1]!.inputs[0]!, /^Represent this sentence for searching/);
  });

  it("refuses an empty query", async () => {
    await assert.rejects(() => embedder(stubFetch().impl).embedQuery("  "), /empty query/);
  });
});

describe("EmbeddingCache", () => {
  it("returns nothing for unseen text", () => {
    assert.equal(freshCache().get("m", ["never seen"]).size, 0);
  });

  it("round-trips a vector", () => {
    const cache = freshCache();
    const vector = normalize(fakeVector(3));
    cache.put("m", [{ text: "hello", vector }]);
    const got = cache.get("m", ["hello"]).get(0)!;
    // float32 storage, so compare with tolerance rather than deep-equal.
    for (const [i, value] of vector.entries()) {
      assert.ok(Math.abs(value - got[i]!) < 1e-6);
    }
  });

  it("never serves one model's vector for another", () => {
    const cache = freshCache();
    cache.put("model-a", [{ text: "hello", vector: fakeVector(1) }]);
    assert.equal(cache.get("model-b", ["hello"]).size, 0, "keys include the model id");
  });

  it("spares the API for text it already knows", async () => {
    const cache = freshCache();
    const { impl, calls } = stubFetch();
    const e = embedder(impl, cache);

    await e.embedDocuments(["alpha", "beta"]);
    const firstCallCount = calls.length;
    const again = await e.embedDocuments(["alpha", "beta"]);

    assert.equal(calls.length, firstCallCount, "the second call must hit the cache only");
    assert.equal(again.length, 2);
    assert.ok(again.every((v) => v.length === DIMS));
  });

  it("only asks for the texts it does not already have", async () => {
    const cache = freshCache();
    const { impl, calls } = stubFetch();
    const e = embedder(impl, cache);

    await e.embedDocuments(["known"]);
    calls.length = 0;
    await e.embedDocuments(["known", "unknown"]);

    assert.deepEqual(
      calls.flatMap((c) => c.inputs),
      ["unknown"],
    );
  });
});

describe("truncation guard", () => {
  const fake = (maxInputTokens: number) => ({
    modelId: "fake/model",
    dimensions: DIMS,
    maxInputTokens,
    embedDocuments: async () => [],
    embedQuery: async () => [],
  });

  it("accepts the shipped budget", () => {
    // 350 tiktoken * 1.35 = 473, under bge-small's 512.
    assert.equal(checkBudget(fake(512)), null);
  });

  it("rejects a budget the model cannot read, and says what to set", () => {
    const problem = checkBudget(fake(256));
    assert.match(problem!, /silently discarded/);
    assert.match(problem!, /Lower CHILD_MAX_TOKENS to about \d+/);
  });

  it("converts tiktoken counts to a worst-case model count", () => {
    assert.equal(estimateModelTokens(100), Math.ceil(100 * config.MODEL_TOKEN_RATIO));
  });

  it("flags only the chunks actually at risk", () => {
    const chunk = (chunkId: string, tokenCount: number) =>
      ({ chunkId, tokenCount }) as Parameters<typeof findOversized>[0][number];
    const found = findOversized(
      // 380 * 1.35 = 513, one token over. 379 would land exactly on 512 and pass.
      [chunk("safe", 100), chunk("risky", 500), chunk("edge", 380)],
      fake(512),
    );
    assert.deepEqual(
      found.map((c) => c.chunkId),
      ["risky", "edge"],
    );
  });

  it("finds nothing when every chunk fits", () => {
    const chunk = (chunkId: string, tokenCount: number) =>
      ({ chunkId, tokenCount }) as Parameters<typeof findOversized>[0][number];
    assert.deepEqual(findOversized([chunk("a", 50), chunk("b", 200)], fake(512)), []);
  });
});

describe("a notebook is never allowed to mix models", () => {
  const chunk = (chunkId: string) =>
    ({
      chunkId,
      documentId: "d",
      parentId: "p",
      text: "t",
      tokenCount: 1,
      pageStart: 1,
      pageEnd: 1,
      headingPath: [],
      sectionTitle: null,
      chunkIndex: 0,
      previousChunkId: null,
      nextChunkId: null,
      blockKinds: ["paragraph"],
      boundaryReason: "structural",
    }) as Parameters<VectorStore["add"]>[1][number];
  const unit = () => Array.from({ length: DIMS }, (_, i) => (i === 0 ? 1 : 0));
  const store = () => new VectorStore(mkdtempSync(join(tmpdir(), "nblm-vs-")));

  it("records which model produced each vector", () => {
    const vs = store();
    vs.add("nb", [chunk("c1")], [unit()], "BAAI/bge-small-en-v1.5");
    assert.deepEqual(vs.modelsIn("nb"), ["BAAI/bge-small-en-v1.5"]);
  });

  it("rejects an ingest with a different model, leaving the notebook intact", () => {
    const vs = store();
    vs.add("nb", [chunk("c1")], [unit()], "BAAI/bge-small-en-v1.5");
    assert.throws(
      () => vs.add("nb", [chunk("c2")], [unit()], "Xenova/bge-small-en-v1.5"),
      /not comparable/,
    );
    assert.equal(vs.count(), 1, "the bad write must not land");
    assert.deepEqual(vs.modelsIn("nb"), ["BAAI/bge-small-en-v1.5"]);
  });

  it("allows adding more sources with the same model", () => {
    const vs = store();
    vs.add("nb", [chunk("c1")], [unit()], "BAAI/bge-small-en-v1.5");
    vs.add("nb", [chunk("c2")], [unit()], "BAAI/bge-small-en-v1.5");
    assert.equal(vs.count(), 2);
  });

  it("keeps notebooks independent of one another", () => {
    const vs = store();
    vs.add("a", [chunk("c1")], [unit()], "BAAI/bge-small-en-v1.5");
    vs.add("b", [chunk("c2")], [unit()], "some-other/model");
    assert.deepEqual(vs.modelsIn("a"), ["BAAI/bge-small-en-v1.5"]);
    assert.deepEqual(vs.modelsIn("b"), ["some-other/model"]);
  });

  it("refuses to search with a model the notebook was not embedded with", () => {
    const vs = store();
    vs.add("nb", [chunk("c1")], [unit()], "BAAI/bge-small-en-v1.5");
    assert.throws(() => vs.search("nb", unit(), 5, "Xenova/bge-small-en-v1.5"), /not comparable/);
    assert.equal(vs.search("nb", unit(), 5, "BAAI/bge-small-en-v1.5").length, 1);
  });
});
