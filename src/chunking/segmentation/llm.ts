import * as config from "../../config.ts";
import { sanitizeBoundaries } from "./base.ts";
import type { Segmenter } from "./base.ts";
import type { CompletionModel } from "../../llm/client.ts";
import type { Block } from "../../models.ts";

export type { CompletionModel } from "../../llm/client.ts";

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
  windowSize?: number;
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
        this.onFallback?.(error);
      }
    }
    return sanitizeBoundaries(found, blocks.length);
  }
}
