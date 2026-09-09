import { pipeline } from "@huggingface/transformers";
import * as config from "../config.ts";
import { POOLING, QUERY_PREFIX, isEmbeddable, normalize } from "./shared.ts";
import type { Embedder } from "./base.ts";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

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

  static async create(modelId: string = config.EMBEDDING_MODEL): Promise<LocalEmbedder> {
    const extractor = await pipeline("feature-extraction", modelId);
    const probe = await extractor("dimension probe", { pooling: POOLING, normalize: true });
    const dimensions = (probe.tolist() as number[][])[0]!.length;
    return new LocalEmbedder(extractor, modelId, dimensions);
  }

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
