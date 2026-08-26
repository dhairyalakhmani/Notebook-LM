import { pipeline } from "@huggingface/transformers";
import * as config from "../config.ts";
import type { Embedder } from "./base.ts";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

/** bge was trained with this exact sentence in front of every query. Leaving it off
 *  measurably hurts retrieval; it is not decoration. */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const BATCH_SIZE = 64;

/** bge takes its sentence vector from the [CLS] token, not the token average. */
const POOLING = "cls" as const;

export class HFEmbedder implements Embedder {
  private extractor: FeatureExtractionPipeline;

  private constructor(extractor: FeatureExtractionPipeline) {
    this.extractor = extractor;
  }

  /** Downloading and starting the model is async, so construction is too. */
  static async create(modelName: string = config.EMBEDDING_MODEL): Promise<HFEmbedder> {
    return new HFEmbedder(await pipeline("feature-extraction", modelName));
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      const output = await this.extractor(batch, { pooling: POOLING, normalize: true });
      vectors.push(...(output.tolist() as number[][]));
    }
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const output = await this.extractor(QUERY_PREFIX + text, {
      pooling: POOLING,
      normalize: true,
    });
    return (output.tolist() as number[][])[0]!;
  }
}

let cached: Promise<HFEmbedder> | null = null;

/** The model is ~130MB in memory. Load it once per process, never in a loop. */
export function getEmbedder(): Promise<HFEmbedder> {
  cached ??= HFEmbedder.create();
  return cached;
}
