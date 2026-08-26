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

/** One source inside a notebook. */
export interface Document {
  documentId: string;
  title: string;
  filename: string;
  sourceType: string;
  pageCount: number;
  addedAt: string;
}

export interface Chunk {
  chunkId: string;
  documentId: string;
  parentId: string | null;
  text: string;
  pageNumber: number | null;
  sectionTitle: string | null;
  tokenCount: number;
}

export function isChild(chunk: Chunk): boolean {
  return chunk.parentId !== null;
}

export interface TextLine {
  text: string;
  pageNumber: number;
  fontSize?: number | null;
  isBold?: boolean;
  headingLevel?: number | null;
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
