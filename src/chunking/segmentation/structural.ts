import { sanitizeBoundaries } from "./base.ts";
import type { Segmenter } from "./base.ts";
import type { Block } from "../../models.ts";

/**
 * The offline segmenter. Cuts where the document's own structure says a topic
 * changes, and nowhere else.
 *
 * A new unit starts at:
 *   - a heading (the author's explicit statement that a topic begins)
 *   - a shift between prose and a table (they are different kinds of content)
 *
 * A new unit deliberately does NOT start at:
 *   - a plain paragraph break, which is a pause inside a topic, not a new one
 *   - the start of a list, which almost always belongs to the sentence above it
 *   - a caption, which belongs to the figure or table beside it
 *
 * That last group is the whole point: paragraph breaks are where naive chunkers
 * cut, and they are exactly where a definition gets separated from the
 * explanation that follows it.
 */
export class StructuralSegmenter implements Segmenter {
  readonly name = "structural";

  async boundaries(blocks: Block[]): Promise<number[]> {
    const cuts: number[] = [];
    for (const [index, block] of blocks.entries()) {
      if (index === 0) continue;
      const previous = blocks[index - 1]!;

      if (block.kind === "heading") {
        // Consecutive headings ("2. CATALOG DOMAIN" then "Vehicle_Category")
        // are one nested title, not two units.
        if (previous.kind === "heading") continue;
        cuts.push(index);
        continue;
      }

      // Prose then a table is a real change of content. A caption or a list
      // stays with what precedes it.
      const wasProse = previous.kind === "paragraph";
      if (wasProse && block.kind === "table") cuts.push(index);
    }
    return sanitizeBoundaries(cuts, blocks.length);
  }
}
