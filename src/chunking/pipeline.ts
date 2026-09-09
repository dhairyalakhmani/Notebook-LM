import * as config from "../config.ts";
import { TiktokenCounter } from "../tokenizer.ts";
import { buildBlocks, structureScore } from "../structure/blockBuilder.ts";
import { StructuralSegmenter } from "./segmentation/structural.ts";
import { sanitizeBoundaries } from "./segmentation/base.ts";
import { splitToSize } from "./sizing.ts";
import type { Segmenter } from "./segmentation/base.ts";
import type { Block, BoundaryReason, Chunk, DocumentPage, SemanticUnit } from "../models.ts";
import type { TokenCounter } from "../tokenizer.ts";

export interface ChunkingReport {
  blockCount: number;
  structureScore: number;
  segmenters: string[];
  unitCount: number;
  parentCount: number;
  childCount: number;
  tokenSplitChunks: number;
}

export interface ChunkingResult {
  parents: Chunk[];
  children: Chunk[];
  units: SemanticUnit[];
  report: ChunkingReport;
}

export interface ChunkingOptions {
  counter?: TokenCounter;
  segmenters?: Segmenter[];
}

class HeadingStack {
  private stack: { level: number; title: string }[] = [];
  private readonly levelsAreMeaningful: boolean;

  constructor(levelsAreMeaningful: boolean) {
    this.levelsAreMeaningful = levelsAreMeaningful;
  }

  private push(title: string, depth: number): void {
    while (this.stack.length > 0 && this.stack.at(-1)!.level >= depth) this.stack.pop();
    this.stack.push({ level: depth, title });
  }

  pushRun(blocks: Block[]): void {
    if (blocks.length === 0) return;

    if (this.levelsAreMeaningful) {
      for (const [index, block] of blocks.entries()) {
        this.push(block.text, (block.headingLevel ?? 1) + index);
      }
      return;
    }

    const ancestors = blocks.slice(0, -1);
    const leaf = blocks.at(-1)!;

    if (ancestors.length > 0) {
      // A new ancestor run opens a new top-level path.
      this.stack = [];
      for (const [index, block] of ancestors.entries()) this.push(block.text, index + 1);
      this.push(leaf.text, ancestors.length + 1);
      return;
    }

    this.push(leaf.text, Math.max(this.stack.length, 1));
  }

  get path(): string[] {
    return this.stack.map((entry) => entry.title);
  }
}

function levelsAreMeaningful(blocks: Block[]): boolean {
  const headings = blocks.filter((block) => block.kind === "heading");
  if (headings.length === 0) return false;

  const explicit = headings.filter((block) =>
    block.lines.some((line) => line.headingLevel != null),
  );
  // Mixed evidence means the levels are not dependable - fall back to structure.
  if (explicit.length < headings.length) return false;

  return new Set(explicit.map((block) => block.headingLevel ?? 1)).size > 1;
}

function unitFrom(
  blocks: Block[],
  headingPath: string[],
  reason: BoundaryReason,
  counter: TokenCounter,
): SemanticUnit | null {
  const body = blocks.filter((block) => block.kind !== "heading");
  if (body.length === 0) return null;
  const text = body.map((block) => block.text).join("\n\n");
  if (!text.trim()) return null;

  return {
    blocks,
    title: headingPath.at(-1) ?? null,
    headingPath,
    text,
    tokenCount: counter.count(text),
    pageStart: Math.min(...body.map((b) => b.pageStart)),
    pageEnd: Math.max(...body.map((b) => b.pageEnd)),
    boundaryReason: reason,
  };
}

export function buildUnits(
  blocks: Block[],
  boundaries: number[],
  counter: TokenCounter,
): SemanticUnit[] {
  const cuts = new Set(sanitizeBoundaries(boundaries, blocks.length));
  const headings = new HeadingStack(levelsAreMeaningful(blocks));
  const units: SemanticUnit[] = [];

  let current: Block[] = [];
  let reason: BoundaryReason = "document";

  const flush = (): void => {
    if (current.length === 0) return;
    // Headings at the head of a run are the run's title, not its content.
    const leading: Block[] = [];
    while (current[0]?.kind === "heading") leading.push(current.shift()!);
    if (leading.length > 0) headings.pushRun(leading);

    const unit = unitFrom([...leading, ...current], headings.path, reason, counter);
    if (unit) units.push(unit);
    current = [];
  };

  for (const [index, block] of blocks.entries()) {
    if (cuts.has(index)) {
      flush();
      reason = block.kind === "heading" ? "heading" : "semantic";
    }
    current.push(block);
  }
  flush();

  return mergeTinyUnits(units, counter);
}

function mergeTinyUnits(units: SemanticUnit[], counter: TokenCounter): SemanticUnit[] {
  const out: SemanticUnit[] = [];
  for (const unit of units) {
    const previous = out.at(-1);
    const ownHeading =
      unit.headingPath.length > 0 &&
      formatHeadingPath(unit.headingPath) !== formatHeadingPath(previous?.headingPath ?? []);
    if (
      previous &&
      !ownHeading &&
      unit.tokenCount < config.MIN_UNIT_TOKENS &&
      previous.tokenCount + unit.tokenCount <= config.PARENT_MAX_TOKENS
    ) {
      const text = `${previous.text}\n\n${unit.text}`;
      out[out.length - 1] = {
        ...previous,
        blocks: [...previous.blocks, ...unit.blocks],
        text,
        tokenCount: counter.count(text),
        pageEnd: Math.max(previous.pageEnd, unit.pageEnd),
      };
      continue;
    }
    out.push(unit);
  }
  return out;
}

export function formatHeadingPath(path: string[]): string {
  return path.join(" > ");
}

export async function chunkDocument(
  pages: DocumentPage[],
  documentId: string,
  options: ChunkingOptions = {},
): Promise<ChunkingResult> {
  const counter = options.counter ?? new TiktokenCounter();
  const blocks = buildBlocks(pages, { counter });

  const structural = new StructuralSegmenter();
  const segmenters: Segmenter[] = [structural, ...(options.segmenters ?? [])];

  const found = await Promise.all(segmenters.map((s) => s.boundaries(blocks)));
  const units = buildUnits(blocks, found.flat(), counter);

  const { parents, children, tokenSplits } = buildHierarchy(units, documentId, counter);

  return {
    parents,
    children,
    units,
    report: {
      blockCount: blocks.length,
      structureScore: structureScore(blocks),
      segmenters: segmenters.map((s) => s.name),
      unitCount: units.length,
      parentCount: parents.length,
      childCount: children.length,
      tokenSplitChunks: tokenSplits,
    },
  };
}

function commonPrefix(paths: string[][]): string[] {
  const first = paths[0];
  if (!first) return [];
  const prefix: string[] = [];
  for (let depth = 0; depth < first.length; depth++) {
    const value = first[depth]!;
    if (!paths.every((path) => path[depth] === value)) break;
    prefix.push(value);
  }
  return prefix;
}

function groupByAncestor(units: SemanticUnit[]): SemanticUnit[][] {
  if (!config.GROUP_PARENTS_BY_ANCESTOR) return units.map((unit) => [unit]);

  const groups: SemanticUnit[][] = [];
  let current: SemanticUnit[] = [];
  let currentKey: string | null = null;
  let total = 0;

  for (const unit of units) {
    const ancestor = unit.headingPath.slice(0, -1);
    const key = ancestor.length > 0 ? formatHeadingPath(ancestor) : null;
    const sameFamily = key !== null && key === currentKey;
    const fits = total + unit.tokenCount <= config.PARENT_MAX_TOKENS;

    if (current.length > 0 && (!sameFamily || !fits)) {
      groups.push(current);
      current = [];
      total = 0;
    }
    current.push(unit);
    currentKey = key;
    total += unit.tokenCount;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildHierarchy(
  units: SemanticUnit[],
  documentId: string,
  counter: TokenCounter,
): { parents: Chunk[]; children: Chunk[]; tokenSplits: number } {
  const parents: Chunk[] = [];
  const children: Chunk[] = [];
  let tokenSplits = 0;

  const addParent = (
    text: string,
    tokenCount: number,
    reason: BoundaryReason,
    group: SemanticUnit[],
  ): string => {
    const path = commonPrefix(group.map((unit) => unit.headingPath));
    const parentId = `${documentId}-p${String(parents.length + 1).padStart(4, "0")}`;
    parents.push({
      chunkId: parentId,
      documentId,
      parentId: null,
      text,
      tokenCount,
      pageStart: Math.min(...group.map((unit) => unit.pageStart)),
      pageEnd: Math.max(...group.map((unit) => unit.pageEnd)),
      headingPath: path,
      sectionTitle: formatHeadingPath(path) || null,
      chunkIndex: parents.length,
      previousChunkId: parents.at(-1)?.chunkId ?? null,
      nextChunkId: null,
      blockKinds: [...new Set(group.flatMap((unit) => unit.blocks.map((block) => block.kind)))],
      boundaryReason: reason,
    });
    const previous = parents.at(-2);
    if (previous) previous.nextChunkId = parentId;
    return parentId;
  };

  const addChildren = (unit: SemanticUnit, parentId: string): void => {
    const heading = formatHeadingPath(unit.headingPath);
    const bodyBlocks = unit.blocks
      .filter((block) => block.kind !== "heading")
      .map((block) => block.text);

    const pieces = splitToSize(bodyBlocks, {
      maxTokens: config.CHILD_MAX_TOKENS,
      overlapTokens: config.CHILD_OVERLAP_TOKENS,
      counter,
    });

    const firstIndex = children.length;
    for (const piece of pieces) {
      if (piece.reason === "token") tokenSplits++;
      const text =
        config.PREPEND_HEADING_PATH && heading ? `${heading}\n${piece.text}` : piece.text;
      const chunkId = `${documentId}-c${String(children.length + 1).padStart(5, "0")}`;
      children.push({
        chunkId,
        documentId,
        parentId,
        text,
        tokenCount: counter.count(text),
        pageStart: unit.pageStart,
        pageEnd: unit.pageEnd,
        headingPath: unit.headingPath,
        sectionTitle: heading || null,
        chunkIndex: children.length,
        previousChunkId: children.at(-1)?.chunkId ?? null,
        nextChunkId: null,
        blockKinds: [...new Set(unit.blocks.map((block) => block.kind))],
        boundaryReason: piece.reason,
      });
      const previousChild = children.at(-2);
      if (previousChild && children.length - 1 > firstIndex) {
        previousChild.nextChunkId = chunkId;
      }
    }
  };

  for (const group of groupByAncestor(units)) {
    const text = group.map((unit) => unit.text).join("\n\n");
    const tokenCount = counter.count(text);

    if (tokenCount > config.PARENT_MAX_TOKENS) {
      const unit = group[0]!;
      const blockTexts = unit.blocks
        .filter((block) => block.kind !== "heading")
        .map((block) => block.text);
      for (const piece of splitToSize(blockTexts, {
        maxTokens: config.PARENT_MAX_TOKENS,
        counter,
      })) {
        if (piece.reason === "token") tokenSplits++;
        const parentId = addParent(piece.text, piece.tokenCount, piece.reason, [unit]);
        addChildren({ ...unit, text: piece.text, tokenCount: piece.tokenCount }, parentId);
      }
      continue;
    }

    const parentId = addParent(text, tokenCount, group[0]!.boundaryReason, group);
    for (const unit of group) addChildren(unit, parentId);
  }

  return { parents, children, tokenSplits };
}
