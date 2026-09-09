import type { Block } from "../../models.ts";

export interface Segmenter {
  readonly name: string;
  boundaries(blocks: Block[]): Promise<number[]>;
}

export function sanitizeBoundaries(raw: number[], blockCount: number): number[] {
  const valid = raw
    .filter((n) => Number.isInteger(n) && n > 0 && n < blockCount)
    .sort((a, b) => a - b);
  return [...new Set(valid)];
}
