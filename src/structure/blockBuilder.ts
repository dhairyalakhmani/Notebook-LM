import * as config from "../config.ts";
import { TiktokenCounter } from "../tokenizer.ts";
import { classifyHeading, headingContext, isUnterminated } from "./headings.ts";
import type { Block, BlockKind, DocumentPage, TextLine } from "../models.ts";
import type { TokenCounter } from "../tokenizer.ts";

const LIST_MARKER = /^\s*([-*•·]|\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[ivxlc]+[.)])\s+/i;
const COLUMN_GAPS = /\S {2,}\S.* {2,}\S/;
const CAPTION = /^\s*(figure|fig\.?|table|chart|exhibit|listing)\s*\d+\s*[.:—-]?/i;

function listMarkerOf(text: string): string | null {
  return LIST_MARKER.exec(text)?.[1] ?? null;
}

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

function startsNewBlock(
  line: TextLine,
  previous: TextLine | undefined,
  normalGap: number | null,
): boolean {
  if (!previous) return true;
  // An explicit signal from the format always wins.
  if (line.breakBefore) return true;
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

export function buildBlocks(pages: DocumentPage[], options: BuildBlocksOptions = {}): Block[] {
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
      const open = draft;
      if (open && open.kind === "heading" && isUnterminated(open.lines.at(-1)!.text)) {
        open.lines.push(line);
        continue;
      }
      flush();
      draft = { kind: "heading", headingLevel: heading.level, lines: [line] };
      continue;
    }

    const marker = listMarkerOf(line.text);
    const kind = kindOf(line, marker != null);
    const newBlock = startsNewBlock(line, lines[index - 1], normalGap);

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

export function structureScore(blocks: Block[]): number {
  if (blocks.length === 0) return 0;
  return blocks.filter((block) => block.kind === "heading").length / blocks.length;
}
