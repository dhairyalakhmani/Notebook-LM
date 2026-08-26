import { TiktokenCounter } from "../tokenizer.ts";
import type { Chunker } from "./base.ts";
import type { DocumentPage, Section } from "../models.ts";
import type { TokenCounter } from "../tokenizer.ts";

const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 60;

export interface TokenWindowOptions {
  maxTokens?: number;
  overlapTokens?: number;
  counter?: TokenCounter;
}

/** The fallback splitter: fixed-size windows with a little overlap, split on blank
 *  lines so a window never starts mid-sentence. */
export class TokenWindowChunker implements Chunker {
  readonly maxTokens: number;
  readonly overlapTokens: number;
  readonly counter: TokenCounter;

  constructor(options: TokenWindowOptions = {}) {
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
    this.counter = options.counter ?? new TiktokenCounter();
  }

  windows(text: string): string[] {
    const blocks = text
      .split("\n")
      .map((block) => block.trim())
      .filter(Boolean);
    if (blocks.length === 0) return [];

    const sized = blocks.map((block) => ({ block, size: this.counter.count(block) }));
    const windows: string[] = [];
    let current: { block: string; size: number }[] = [];
    let total = 0;

    for (const item of sized) {
      if (current.length > 0 && total + item.size > this.maxTokens) {
        windows.push(current.map((c) => c.block).join("\n"));
        // carry the tail of this window into the next one, so a sentence that
        // straddles the boundary is still findable from either side
        const carried: { block: string; size: number }[] = [];
        let carriedTotal = 0;
        for (const previous of [...current].reverse()) {
          if (carriedTotal + previous.size > this.overlapTokens) break;
          carried.unshift(previous);
          carriedTotal += previous.size;
        }
        current = carried;
        total = carriedTotal;
      }
      current.push(item);
      total += item.size;
    }
    if (current.length > 0) windows.push(current.map((c) => c.block).join("\n"));
    return windows;
  }

  split(pages: DocumentPage[]): Section[] {
    const first = pages[0];
    if (!first) return [];
    const text = pages.map((page) => page.text).join("\n");

    return this.windows(text).map((window, index) => ({
      sectionId: `s${String(index + 1).padStart(2, "0")}`,
      title: `${first.source} (part ${index + 1})`,
      text: window,
      source: first.source,
      pageNumber: first.pageNumber,
      parentHeading: null,
      tokenCount: this.counter.count(window),
    }));
  }
}
