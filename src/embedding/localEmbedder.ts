import { pipeline } from "@huggingface/transformers";
import * as config from "../config.ts";
import { POOLING, QUERY_PREFIX, isEmbeddable, normalize } from "./shared.ts";
import type { Embedder } from "./base.ts";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

/**
 * Embeddings from a local ONNX model, in-process, offline.
 *
 * Kept alongside the hosted path deliberately: it is the offline development
 * path, the path tests can use without a network, and the escape hatch if a
 * hosted model is retired. Its vectors are only interchangeable with the API's
 * if the model is genuinely the same - which is why the vector store records
 * which model produced what.
 *
 * One thing to know before using this in a server: ONNX inference runs on the
 * calling thread and blocks Node's event loop for its whole duration (measured:
 * 1 event-loop tick in 1101ms). In an HTTP process it must go in a worker.
 */
export class LocalEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxInputTokens = 512;
  private extractor: FeatureExtractionPipeline;

  private constructor(extractor: FeatureExtractionPipeline, modelId: string, dimensions: number) {
    this.extractor = extractor;
    this.modelId = modelId;
    this.dimensions = dimensions;
  }

  /** Downloading and starting the model is async, so construction is too. */
  static async create(modelId: string = config.EMBEDDING_MODEL): Promise<LocalEmbedder> {
    const extractor = await pipeline("feature-extraction", modelId);
    // Ask the model its own dimension rather than hard-coding 384, so a model
    // swap cannot silently disagree with the vector store.
    const probe = await extractor("dimension probe", { pooling: POOLING, normalize: true });
    const dimensions = (probe.tolist() as number[][])[0]!.length;
    return new LocalEmbedder(extractor, modelId, dimensions);
  }

  /**
   * Batch 16, sorted by length.
   *
   * Measured on this machine: batch 64 in natural order costs 61.6ms/chunk,
   * batch 1 costs 24.8ms, and batch 16 sorted by length costs 20.9ms. Every
   * sequence in a batch is padded to the longest one, so mixing lengths spends
   * most of the compute on padding. Sorting first removes that waste.
   */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const order = texts
      .map((text, index) => ({ index, length: text.length }))
      .sort((a, b) => a.length - b.length);

    const vectors: number[][] = new Array(texts.length);
    for (let start = 0; start < order.length; start += config.LOCAL_EMBED_BATCH) {
      const slice = order.slice(start, start + config.LOCAL_EMBED_BATCH);
      const batch = slice.map((entry) => texts[entry.index]!);
      const output = await this.extractor(batch, { pooling: POOLING, normalize: true });
      const produced = output.tolist() as number[][];
      // Restore the caller's order: it pairs positionally with the chunks.
      for (const [position, entry] of slice.entries()) {
        vectors[entry.index] = normalize(produced[position]!);
      }
    }
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    if (!isEmbeddable(text)) {
      throw new Error("cannot embed an empty query");
    }
    const output = await this.extractor(QUERY_PREFIX + text, {
      pooling: POOLING,
      normalize: true,
    });
    return normalize((output.tolist() as number[][])[0]!);
  }
}
