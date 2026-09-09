import * as config from "../config.ts";
import { HfApiEmbedder } from "./hfApiEmbedder.ts";
import { LocalEmbedder } from "./localEmbedder.ts";
import type { Embedder } from "./base.ts";

export type { Embedder } from "./base.ts";
export { HfApiEmbedder } from "./hfApiEmbedder.ts";
export { LocalEmbedder } from "./localEmbedder.ts";
export { EmbeddingCache } from "./cache.ts";
export { QUERY_PREFIX, isEmbeddable, isUnitLength, normalize } from "./shared.ts";
export { checkBudget, findOversized, estimateModelTokens } from "./limits.ts";

let cached: Promise<Embedder> | null = null;

export function getEmbedder(): Promise<Embedder> {
  cached ??= create();
  return cached;
}

function create(): Promise<Embedder> {
  switch (config.EMBEDDING_PROVIDER) {
    case "hf-api":
      return Promise.resolve(new HfApiEmbedder());
    case "local":
      console.log(
        `! EMBEDDING_PROVIDER is "local" - embedding with ${config.EMBEDDING_MODEL} ` +
          "in-process, not the HuggingFace API. Vectors from the two paths are not " +
          'comparable; set it back to "hf-api" before ingesting anything you intend to keep.',
      );
      return LocalEmbedder.create();
  }
}

export function resetEmbedder(): void {
  cached = null;
}
