import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const ID_LENGTH = 12;

/** Same file contents -> same id, so re-adding a file is detectable. */
export async function documentIdForFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const block of createReadStream(path)) {
    digest.update(block as Buffer);
  }
  return digest.digest("hex").slice(0, ID_LENGTH);
}

/**
 * A citation on a stored answer, denormalised on purpose.
 *
 * It holds the filename, pages and heading rather than a chunk id. Chunks are
 * derived data and get rebuilt with new ids whenever a source is re-ingested or
 * the chunk schema changes - a stored citation pointing at a chunk id would go
 * dead. What a reader needs is where it came from, and that never changes.
 */
export interface Citation {
  /** The [n] the answer used. */
  marker: number;
  filename: string;
  pageStart: number | null;
  pageEnd: number | null;
  headingPath: string[];
}

/**
 * One turn of a notebook's conversation.
 *
 * These are the only rows in storage that are NOT derived data: chunks and
 * vectors can always be rebuilt from the source file, and a conversation cannot
 * be rebuilt from anything. No migration may drop this table.
 */
export interface ChatMessage {
  messageId: number;
  notebook: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /** Empty for user turns, and for an assistant turn that cited nothing. */
  citations: Citation[];
  /** For a user turn that was a follow-up: what it was rewritten to, so the
   *  thread shows why retrieval looked for something the user did not type. */
  resolvedQuestion: string | null;
}

/** One source inside a notebook. */
export interface Document {
  documentId: string;
  title: string;
  filename: string;
  sourceType: string;
  pageCount: number;
  addedAt: string;
}

/** Why a chunk ends where it does. Kept on the chunk so retrieval quality problems
 *  can be traced back to the decision that caused them. */
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

  /** A chunk can span pages, so retrieval cites a range. */
  pageStart: number | null;
  pageEnd: number | null;

  /** ["1. USER & ACCESS DOMAIN", "Customer"] — structured, so a citation can
   *  render it however it likes instead of parsing a joined string. */
  headingPath: string[];
  sectionTitle: string | null;

  /** Ordinal within the document, in reading order. */
  chunkIndex: number;
  /** Neighbours at the same level, for context expansion at retrieval time. */
  previousChunkId: string | null;
  nextChunkId: string | null;

  /** What the chunk is made of: lets retrieval know it holds a table or a list. */
  blockKinds: BlockKind[];
  boundaryReason: BoundaryReason;
}

export function isChild(chunk: Chunk): boolean {
  return chunk.parentId !== null;
}

/** What a run of lines is, structurally. The unit every later layer works on. */
export type BlockKind =
  | "heading"
  | "paragraph"
  | "listItem"
  | "table"
  | "caption"
  | "unknown";

export interface Block {
  kind: BlockKind;
  text: string;
  pageStart: number;
  pageEnd: number;
  /** 1-6 when kind is "heading", else null. */
  headingLevel: number | null;
  tokenCount: number;
  /** The lines this came from, kept for debugging extraction problems. */
  lines: TextLine[];
}

/** A run of blocks that belong together. The output of segmentation, before
 *  size constraints are applied. */
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
  /** Page geometry, top-down. Present for PDFs; absent for formats that carry
   *  their own structure (markdown, docx) and do not need it inferred. */
  top?: number | null;
  left?: number | null;
  right?: number | null;
  /** Set by loaders whose format marks paragraphs explicitly (a blank line in
   *  markdown, a <p> in HTML). When absent, the structure layer infers it. */
  breakBefore?: boolean;
  /**
   * The line's cells, when the loader could tell it was a table row - wide
   * coordinate gaps in a PDF, a `<tr>` in HTML. Carried as data rather than
   * left to be re-detected from spacing, because cleaning collapses whitespace
   * and would erase the only evidence.
   */
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
