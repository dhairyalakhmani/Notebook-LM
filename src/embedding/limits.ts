import * as config from "../config.ts";
import type { Chunk } from "../models.ts";
import type { Embedder } from "./base.ts";

/**
 * Guards against silent truncation.
 *
 * An embedding model discards everything past its input limit without raising
 * anything - verified on bge-small: a 1202-token input returns a vector
 * byte-identical to one built from its first 512 tokens. A chunk whose ending is
 * dropped is still stored, still searchable, and simply never matches the part
 * that went missing.
 *
 * Nothing here can prevent that at the model, so the job is to make it
 * impossible for it to happen *unnoticed*: check the configured budget once, and
 * check the actual chunks every ingest.
 */

/** tiktoken count -> worst-case model-token count. */
export function estimateModelTokens(tiktokenCount: number): number {
  return Math.ceil(tiktokenCount * config.MODEL_TOKEN_RATIO);
}

/**
 * Is the chunk budget compatible with this embedder at all?
 *
 * A configuration problem, not a data problem: if CHILD_MAX_TOKENS is set too
 * high for the model, *every* large chunk loses its tail. Worth failing on,
 * because no document will ever ingest correctly until it is fixed.
 */
export function checkBudget(embedder: Embedder): string | null {
  const worstCase = estimateModelTokens(config.CHILD_MAX_TOKENS);
  if (worstCase <= embedder.maxInputTokens) return null;
  return (
    `CHILD_MAX_TOKENS is ${config.CHILD_MAX_TOKENS} tiktoken tokens, which can be ` +
    `~${worstCase} tokens for ${embedder.modelId} - past its ${embedder.maxInputTokens} ` +
    `limit, so chunk endings would be silently discarded. Lower CHILD_MAX_TOKENS to ` +
    `about ${Math.floor(embedder.maxInputTokens / config.MODEL_TOKEN_RATIO)} or use a ` +
    "model with a longer input limit."
  );
}

export interface OversizedChunk {
  chunkId: string;
  tokenCount: number;
  estimated: number;
}

/**
 * Chunks at risk of truncation. Reported rather than thrown: a handful of
 * over-long chunks is a quality note, and refusing the whole document would be
 * a worse outcome than indexing it with a warning.
 */
export function findOversized(chunks: Chunk[], embedder: Embedder): OversizedChunk[] {
  const oversized: OversizedChunk[] = [];
  for (const chunk of chunks) {
    const estimated = estimateModelTokens(chunk.tokenCount);
    if (estimated > embedder.maxInputTokens) {
      oversized.push({ chunkId: chunk.chunkId, tokenCount: chunk.tokenCount, estimated });
    }
  }
  return oversized;
}
