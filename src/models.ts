import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const ID_LENGTH = 12;

export async function documentIdForFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const block of createReadStream(path)) {
    digest.update(block as Buffer);
  }
  return digest.digest("hex").slice(0, ID_LENGTH);
}

export interface Citation {
  marker: number;
  filename: string;
  pageStart: number | null;
  pageEnd: number | null;
  headingPath: string[];
  sourceId?: string;
  quote?: string | null;
}

export interface StoredPassage {
  marker: number;
  documentId: string;
  filename: string;
  pageStart: number | null;
  pageEnd: number | null;
  headingPath: string[];
  cosine: number | null;
  bm25: number | null;
  denseRank: number | null;
  sparseRank: number | null;
  fused: number;
  matchCount: number;
  cited: boolean;
}

export interface ChatMessage {
  messageId: number;
  notebook: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  citations: Citation[];
  passages?: StoredPassage[];
  resolvedQuestion: string | null;
}

export type IngestStage = "extract" | "quality" | "clean" | "chunk" | "embed" | "store";

export interface IngestStats {
  blocks: number;
  units: number;
  sections: number;
  passages: number;
  structureScore: number;
  tokenSplitChunks: number;
  segmenters: string[];
  stages: { stage: IngestStage; ms: number }[];
  embedModel: string;
}

export interface OutlineSection {
  number: string | null;
  title: string;
  page: number | null;
  depth: number;
}

export interface Document {
  documentId: string;
  title: string;
  filename: string;
  sourceType: string;
  pageCount: number;
  addedAt: string;
}

export type BoundaryReason =
  | "heading" // the document's own heading marked the break
  | "structural" // a block-kind change (prose -> table, list ends)
  | "semantic" // a segmenter judged the topic to change here
  | "paragraph" // split oversized unit at a paragraph
  | "sentence" // split oversized unit at a sentence
  | "token" // last-resort size cut
  | "document"; // start/end of the document

export interface Chunk {
  chunkId: string;
  documentId: string;
  parentId: string | null;
  text: string;
  tokenCount: number;

  pageStart: number | null;
  pageEnd: number | null;

  headingPath: string[];
  sectionTitle: string | null;

  chunkIndex: number;
  previousChunkId: string | null;
  nextChunkId: string | null;

  blockKinds: BlockKind[];
  boundaryReason: BoundaryReason;
}

export function isChild(chunk: Chunk): boolean {
  return chunk.parentId !== null;
}

export type BlockKind = "heading" | "paragraph" | "listItem" | "table" | "caption" | "unknown";

export interface Block {
  kind: BlockKind;
  text: string;
  pageStart: number;
  pageEnd: number;
  headingLevel: number | null;
  tokenCount: number;
  lines: TextLine[];
}

export interface SemanticUnit {
  blocks: Block[];
  title: string | null;
  headingPath: string[];
  text: string;
  tokenCount: number;
  pageStart: number;
  pageEnd: number;
  boundaryReason: BoundaryReason;
}

export interface TextLine {
  text: string;
  pageNumber: number;
  fontSize?: number | null;
  isBold?: boolean;
  headingLevel?: number | null;
  top?: number | null;
  left?: number | null;
  right?: number | null;
  breakBefore?: boolean;
  cells?: string[];
}

export interface DocumentPage {
  text: string;
  pageNumber: number;
  source: string;
  lines: TextLine[];
}

export interface Section {
  sectionId: string;
  title: string;
  text: string;
  source: string;
  pageNumber: number | null;
  parentHeading: string | null;
  tokenCount: number;
}
