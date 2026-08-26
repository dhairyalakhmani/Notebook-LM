import { TiktokenCounter } from "../tokenizer.ts";
import { TokenWindowChunker } from "./tokenWindowChunker.ts";
import type { Chunker } from "./base.ts";
import type { DocumentPage, Section, TextLine } from "../models.ts";
import type { TokenCounter } from "../tokenizer.ts";

const HEADING_SIZE_RATIO = 1.15; // 15% bigger than body text -> probably a heading
const MAX_HEADING_WORDS = 14;
const SENTENCE_ENDINGS = [".", ",", ";"];
const BRACKET_PAIRS: readonly [string, string][] = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
];
const DEFAULT_MIN_TOKENS = 20;
const DEFAULT_MAX_TOKENS = 400;

/** The most-used non-bold font size, weighted by how much text is set in it. */
function bodyFontSize(lines: TextLine[]): number | null {
  const weights = new Map<number, number>();
  for (const line of lines) {
    if (line.fontSize == null || line.isBold) continue;
    weights.set(line.fontSize, (weights.get(line.fontSize) ?? 0) + line.text.length);
  }
  if (weights.size === 0) return null;
  return [...weights].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

function isHeading(line: TextLine, bodySize: number | null): boolean {
  // Markdown and Word tell us outright; PDFs make us guess from the typography.
  if (line.headingLevel != null) return true;
  if (bodySize == null || line.fontSize == null) return false;
  if (line.text.split(/\s+/).length > MAX_HEADING_WORDS) return false;
  if (SENTENCE_ENDINGS.some((end) => line.text.endsWith(end))) return false;
  return Boolean(line.isBold) || line.fontSize > bodySize * HEADING_SIZE_RATIO;
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** A heading that hangs open — an unclosed quote or bracket — is a wrapped heading. */
function isUnterminated(text: string): boolean {
  if (count(text, '"') % 2 === 1) return true;
  return BRACKET_PAIRS.some(([open, close]) => count(text, open) > count(text, close));
}

interface RawSection {
  title: string;
  pageNumber: number;
  body: string[];
}

export interface HeadingChunkerOptions {
  minTokens?: number;
  maxTokens?: number;
  counter?: TokenCounter;
}

/** The preferred splitter: cut the document where its own headings say to. */
export class HeadingChunker implements Chunker {
  readonly minTokens: number;
  readonly maxTokens: number;
  readonly counter: TokenCounter;

  constructor(options: HeadingChunkerOptions = {}) {
    this.minTokens = options.minTokens ?? DEFAULT_MIN_TOKENS;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.counter = options.counter ?? new TiktokenCounter();
  }

  split(pages: DocumentPage[]): Section[] {
    const lines = pages.flatMap((page) => page.lines);
    const first = pages[0];
    if (lines.length === 0 || !first) return [];

    const bodySize = bodyFontSize(lines);
    const raw: RawSection[] = [];
    let current: RawSection | null = null;

    for (const line of lines) {
      if (isHeading(line, bodySize)) {
        // two heading lines in a row, the first left hanging -> one wrapped heading
        if (current && current.body.length === 0 && isUnterminated(current.title)) {
          current.title = `${current.title} ${line.text}`;
          continue;
        }
        current = { title: line.text, pageNumber: line.pageNumber, body: [] };
        raw.push(current);
      } else if (current) {
        current.body.push(line.text);
      }
    }
    return this.buildSections(raw, first.source);
  }

  private buildSections(raw: RawSection[], source: string): Section[] {
    const sections: Section[] = [];
    const windower = new TokenWindowChunker({
      maxTokens: this.maxTokens,
      counter: this.counter,
    });
    let parent: string | null = null;

    for (const item of raw) {
      const body = item.body.join("\n").trim();
      if (!body) {
        // a heading with nothing under it is a parent heading for what follows
        parent = item.title;
        continue;
      }

      const tokens = this.counter.count(body);
      const previous = sections.at(-1);
      if (previous && tokens < this.minTokens) {
        // too small to stand alone: fold it into the section before it
        previous.text = `${previous.text}\n${item.title}\n${body}`;
        previous.tokenCount = this.counter.count(previous.text);
        continue;
      }

      const pieces = tokens > this.maxTokens ? windower.windows(body) : [body];
      for (const [index, piece] of pieces.entries()) {
        const title =
          pieces.length > 1
            ? `${item.title} (part ${index + 1}/${pieces.length})`
            : item.title;
        sections.push({
          sectionId: `s${String(sections.length + 1).padStart(2, "0")}`,
          title,
          text: piece,
          source,
          pageNumber: item.pageNumber,
          parentHeading: parent,
          tokenCount: this.counter.count(piece),
        });
      }
    }
    return sections;
  }
}
