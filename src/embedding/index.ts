import * as config from "../config.ts";
import { HfApiEmbedder } from "./hfApiEmbedder.ts";
import { LocalEmbedder } from "./localEmbedder.ts";
import type { Embedder } from "./base.ts";

export type { Embedder } from "./base.ts";
export { HfApiEmbedder } from "./hfApiEmbedder.ts";
export { LocalEmbedder } from "./localEmbedder.ts";
export { EmbeddingCache } from "./cache.ts";
export { QUERY_PREFIX, isEmbeddable, isUnitLength, normalize } from "./shared.ts";

let cached: Promise<Embedder> | null = null;

/**
 * The embedder named by `config.EMBEDDING_PROVIDER`.
 *
 * Cached per process for opposite reasons on each path: the local model costs
 * ~316ms and ~198MB to load, and the API client holds an open cache handle. Both
 * want to exist once.
 *
 * There is deliberately no runtime fallback between the two. A silent switch
 * from the API to the local model would start writing vectors that are not
 * comparable with the ones already stored - a corruption, not a recovery.
 */
export function getEmbedder(): Promise<Embedder> {
  cached ??= create();
  return cached;
}

function create(): Promise<Embedder> {
  switch (config.EMBEDDING_PROVIDER) {
    case "hf-api":
      return Promise.resolve(new HfApiEmbedder());
    case "local":
      return LocalEmbedder.create();
  }
}

/** Drops the cached embedder. For tests, and for `embed-check`. */
export function resetEmbedder(): void {
  cached = null;
}
