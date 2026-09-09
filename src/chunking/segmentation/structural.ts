import { sanitizeBoundaries } from "./base.ts";
import type { Segmenter } from "./base.ts";
import type { Block } from "../../models.ts";

export class StructuralSegmenter implements Segmenter {
  readonly name = "structural";

  async boundaries(blocks: Block[]): Promise<number[]> {
    const cuts: number[] = [];
    for (const [index, block] of blocks.entries()) {
      if (index === 0) continue;
      const previous = blocks[index - 1]!;

      if (block.kind === "heading") {
        if (previous.kind === "heading") continue;
        cuts.push(index);
        continue;
      }

      const wasProse = previous.kind === "paragraph";
      if (wasProse && block.kind === "table") cuts.push(index);
    }
    return sanitizeBoundaries(cuts, blocks.length);
  }
}
