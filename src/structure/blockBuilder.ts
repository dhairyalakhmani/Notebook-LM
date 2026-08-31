import * as config from "../config.ts";
import { TiktokenCounter } from "../tokenizer.ts";
import { classifyHeading, headingContext, isUnterminated } from "./headings.ts";
import type { Block, BlockKind, DocumentPage, TextLine } from "../models.ts";
import type { TokenCounter } from "../tokenizer.ts";

/**
 * Layer 1 - structural analysis.
 *
 * Turns a flat list of visual lines back into typed blocks: headings,
 * paragraphs, list items and table rows. Everything downstream works on blocks,
 * so this is the only place that has to know that a PDF line break is a
 * typesetting artefact rather than a meaning boundary.
 *
 * The signals used, in order of reliability:
 *   1. `headingLevel` / `breakBefore` from formats that carry real structure
 *   2. vertical gaps between lines (a bigger-than-usual gap starts a paragraph)
 *   3. line prefixes (bullets, numbers) and indentation for lists
 *   4. column-like alignment repeated across lines, for tables
 */

/** "-", "*", "1.", "1)", "a.", "(iv)" at the start of a line. */
const LIST_MARKER = /^\s*([-*•·]|\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[ivxlc]+[.)])\s+/i;
/** Two or more runs of whitespace inside one line - the shape of a table row. */
const COLUMN_GAPS = /\S {2,}\S.* {2,}\S/;
/** "Figure 3:", "Table 2 -", "Fig. 4" */
const CAPTION = /^\s*(figure|fig\.?|table|chart|exhibit|listing)\s*\d+\s*[.:—-]?/i;

function listMarkerOf(text: string): string | null {
  return LIST_MARKER.exec(text)?.[1] ?? null;
}

/** Median gap between consecutive line tops on a page - the normal line height. */
function medianLineGap(lines: TextLine[]): number | null {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const previous = lines[i - 1]!;
    const line = lines[i]!;
    if (previous.top == null || line.top == null) continue;
    if (line.pageNumber !== previous.pageNumber) continue;
    const gap = line.top - previous.top;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * Does a new block start at `line`?
 *
 * This is the judgement the old chunker could not make, because the loader had
 * already thrown away the geometry it needs.
 */
function startsNewBlock(
  line: TextLine,
  previous: TextLine | undefined,
  normalGap: number | null,
): boolean {
  if (!previous) return true;
  // An explicit signal from the format always wins.
  if (line.breakBefore) return true;
  // A page break is a block break: the last line of page 1 and the first of
  // page 2 are not one paragraph, even when they read as one sentence.
  if (line.pageNumber !== previous.pageNumber) return true;
  // A list marker always starts its own item.
  if (listMarkerOf(line.text)) return true;

  if (normalGap != null && line.top != null && previous.top != null) {
    const gap = line.top - previous.top;
    if (gap > normalGap * config.PARAGRAPH_GAP_RATIO) return true;
  }
  return false;
}

function kindOf(line: TextLine, isListItem: boolean): BlockKind {
  if (isListItem) return "listItem";
  if (CAPTION.test(line.text)) return "caption";
  // The loader saw the geometry (or the <tr>) and said so outright. Trust that
  // before sniffing the text, whose spacing cleaning has already collapsed.
  if (line.cells && line.cells.length >= 2) return "table";
  if (COLUMN_GAPS.test(line.text)) return "table";
  return "paragraph";
}

interface Draft {
  kind: BlockKind;
  headingLevel: number | null;
  lines: TextLine[];
}

function finish(draft: Draft, counter: TokenCounter): Block | null {
  // Lines inside one block are joined with a space: they were wrapped by the
  // typesetter, not written as separate lines. Table rows keep their newlines,
  // because there the line break carries the row structure.
  const separator = draft.kind === "table" ? "\n" : " ";
  const text = draft.lines
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join(separator)
    .replace(/\s+/g, draft.kind === "table" ? "$&" : " ")
    .trim();
  if (!text) return null;

  const pages = draft.lines.map((line) => line.pageNumber);
  return {
    kind: draft.kind,
    text,
    pageStart: Math.min(...pages),
    pageEnd: Math.max(...pages),
    headingLevel: draft.headingLevel,
    tokenCount: counter.count(text),
    lines: draft.lines,
  };
}

export interface BuildBlocksOptions {
  counter?: TokenCounter;
}

/**
 * Returns every block in the document, in reading order. Nothing is dropped:
 * text appearing before the first heading becomes ordinary paragraph blocks
 * rather than disappearing.
 */
export function buildBlocks(
  pages: DocumentPage[],
  options: BuildBlocksOptions = {},
): Block[] {
  const counter = options.counter ?? new TiktokenCounter();
  const lines = pages.flatMap((page) => page.lines);
  if (lines.length === 0) return [];

  const ctx = headingContext(lines);
  const normalGap = medianLineGap(lines);

  const blocks: Block[] = [];
  let draft: Draft | null = null;

  const flush = (): void => {
    if (!draft) return;
    const block = finish(draft, counter);
    if (block) blocks.push(block);
    draft = null;
  };

  for (const [index, line] of lines.entries()) {
    const heading = classifyHeading(line, ctx);

    if (heading.isHeading) {
      // Two heading lines in a row where the first hangs open on a bracket or
      // quote: one heading that wrapped, not two headings.
      const open = draft;
      if (open && open.kind === "heading" && isUnterminated(open.lines.at(-1)!.text)) {
        open.lines.push(line);
        continue;
      }
      flush();
      // Left open, not flushed: the next line may be the rest of a heading that
      // wrapped, and the check above can only merge into a draft that is still
      // current. A following body line flushes it through the normal path.
      draft = { kind: "heading", headingLevel: heading.level, lines: [line] };
      continue;
    }

    const marker = listMarkerOf(line.text);
    const kind = kindOf(line, marker != null);
    const newBlock = startsNewBlock(line, lines[index - 1], normalGap);

    // A continuation line of a list item or table keeps that block's kind: an
    // indented wrapped bullet is still part of the bullet above it.
    if (draft && !newBlock && draft.kind !== "heading") {
      draft.lines.push(line);
      continue;
    }
    flush();
    draft = { kind, headingLevel: null, lines: [line] };
  }
  flush();

  return mergeAdjacent(blocks, counter);
}

/**
 * Consecutive list items and table rows are merged into one block, so a list is
 * retrieved whole rather than one bullet at a time. Headings and paragraphs are
 * left alone.
 */
function mergeAdjacent(blocks: Block[], counter: TokenCounter): Block[] {
  const merged: Block[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    const mergeable = block.kind === "listItem" || block.kind === "table";
    if (
      previous &&
      mergeable &&
      previous.kind === block.kind &&
      previous.tokenCount + block.tokenCount <= config.MAX_MERGED_BLOCK_TOKENS
    ) {
      const text = `${previous.text}\n${block.text}`;
      merged[merged.length - 1] = {
        ...previous,
        text,
        pageEnd: block.pageEnd,
        tokenCount: counter.count(text),
        lines: [...previous.lines, ...block.lines],
      };
      continue;
    }
    merged.push(block);
  }
  return merged;
}

/** Share of blocks that are headings - how structured this document really is. */
export function structureScore(blocks: Block[]): number {
  if (blocks.length === 0) return 0;
  return blocks.filter((block) => block.kind === "heading").length / blocks.length;
}
