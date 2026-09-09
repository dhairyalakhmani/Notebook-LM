import * as config from "../config.ts";
import type { Chunk } from "../models.ts";
import type { Embedder } from "./base.ts";

export function estimateModelTokens(tiktokenCount: number): number {
  return Math.ceil(tiktokenCount * config.MODEL_TOKEN_RATIO);
}

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
