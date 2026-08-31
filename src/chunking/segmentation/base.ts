import type { Block } from "../../models.ts";

/**
 * Layer 2 - semantic segmentation.
 *
 * A segmenter decides *where one topic ends and the next begins*. It never
 * rewrites text: it returns the indices of blocks that start a new unit, and
 * the caller slices deterministically. That keeps every implementation - rules,
 * LLM, embeddings - interchangeable and impossible to hallucinate content with.
 */
export interface Segmenter {
  readonly name: string;
  /**
   * Returns the indices in `blocks` that begin a new semantic unit. Index 0 is
   * implied and may be omitted. Indices out of range or out of order are the
   * caller's problem to reject, not the implementation's to guarantee.
   */
  boundaries(blocks: Block[]): Promise<number[]>;
}

/** Keeps only usable, sorted, in-range boundaries. Applied to every segmenter's
 *  output so a bad implementation degrades instead of corrupting the pipeline. */
export function sanitizeBoundaries(raw: number[], blockCount: number): number[] {
  const valid = raw
    .filter((n) => Number.isInteger(n) && n > 0 && n < blockCount)
    .sort((a, b) => a - b);
  return [...new Set(valid)];
}
