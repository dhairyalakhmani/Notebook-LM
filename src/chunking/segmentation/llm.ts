import * as config from "../../config.ts";
import { sanitizeBoundaries } from "./base.ts";
import type { Segmenter } from "./base.ts";
import type { Block } from "../../models.ts";

/**
 * LLM-assisted segmentation, for documents whose structure is too weak to cut
 * on. Used when a rough PDF gives long runs of undifferentiated paragraphs.
 *
 * Two rules make this safe enough to put in an ingest pipeline:
 *
 *  1. **The model never returns text, only block numbers.** It cannot rewrite,
 *     summarise or invent a single word - the slicing is done here from indices.
 *     Anything malformed is discarded and the run stays whole.
 *  2. **It is advisory.** If the call fails, times out, or returns nonsense, the
 *     caller keeps the structural boundaries. Ingest never breaks because a
 *     provider was down.
 */

/** The whole LLM surface this needs. Any provider that can turn a prompt into
 *  text satisfies it - Groq today, anything else later, a fake in tests. */
export interface CompletionModel {
  generate(prompt: string, options?: { jsonMode?: boolean; temperature?: number }): Promise<string>;
}

const PROMPT = `You are segmenting a document for retrieval. Below are numbered blocks of text in reading order.

Identify where the TOPIC genuinely changes. Return the block numbers that START a new topic.

Keep together, in the same segment:
- a definition and the explanation that follows it
- a concept and its examples
- a claim and its supporting reasoning
- a question and its answer
- steps that belong to one procedure
- a sentence that introduces a list, and the list itself

Split only where the subject matter actually moves on. Prefer FEWER, more meaningful boundaries over many small ones. It is correct to return an empty list if the whole passage is one topic.

Respond with JSON only, in this exact shape:
{"boundaries": [4, 11]}

BLOCKS:
`;

interface BoundaryResponse {
  boundaries?: unknown;
}

export interface LLMSegmenterOptions {
  model: CompletionModel;
  /** Blocks per request. Long documents are segmented in windows. */
  windowSize?: number;
  /** Called when a request fails, so ingest can report degraded segmentation. */
  onFallback?: (error: unknown) => void;
}

export class LLMSegmenter implements Segmenter {
  readonly name = "llm";
  private model: CompletionModel;
  private windowSize: number;
  private onFallback: ((error: unknown) => void) | undefined;

  constructor(options: LLMSegmenterOptions) {
    this.model = options.model;
    this.windowSize = options.windowSize ?? config.LLM_SEGMENT_WINDOW;
    this.onFallback = options.onFallback;
  }

  /** Blocks are truncated in the prompt: the model needs to see what a block is
   *  about, not read all of it, and short prompts keep this cheap. */
  private render(blocks: Block[], offset: number): string {
    return blocks
      .map((block, index) => {
        const head = block.text.slice(0, 240).replace(/\s+/g, " ");
        const ellipsis = block.text.length > 240 ? "..." : "";
        return `[${offset + index}] (${block.kind}) ${head}${ellipsis}`;
      })
      .join("\n");
  }

  private async windowBoundaries(window: Block[], offset: number): Promise<number[]> {
    const reply = await this.model.generate(PROMPT + this.render(window, offset), {
      jsonMode: true,
      temperature: 0,
    });
    const parsed = JSON.parse(reply) as BoundaryResponse;
    if (!Array.isArray(parsed.boundaries)) return [];
    return parsed.boundaries.filter((n): n is number => typeof n === "number");
  }

  async boundaries(blocks: Block[]): Promise<number[]> {
    if (blocks.length < config.LLM_SEGMENT_MIN_BLOCKS) return [];

    const found: number[] = [];
    for (let start = 0; start < blocks.length; start += this.windowSize) {
      const window = blocks.slice(start, start + this.windowSize);
      try {
        found.push(...(await this.windowBoundaries(window, start)));
      } catch (error) {
        // Advisory only: a failed window contributes no boundaries and the
        // structural ones still stand.
        this.onFallback?.(error);
      }
      // A window boundary is an artefact of batching, not a topic change, so it
      // is never added as a cut on its own.
    }
    return sanitizeBoundaries(found, blocks.length);
  }
}
