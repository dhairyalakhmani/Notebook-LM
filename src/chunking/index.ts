import { HeadingChunker } from "./headingChunker.ts";
import { TokenWindowChunker } from "./tokenWindowChunker.ts";
import type { DocumentPage, Section } from "../models.ts";

export type { Chunker } from "./base.ts";
export { HeadingChunker } from "./headingChunker.ts";
export { TokenWindowChunker } from "./tokenWindowChunker.ts";

const MIN_USEFUL_SECTIONS = 3;

export interface ChunkResult {
  sections: Section[];
  strategy: "headings" | "token windows";
}

/** Prefer the document's own headings; fall back to fixed windows when it has none
 *  worth using (a plain-text dump, a badly-typeset PDF). */
export function chunkDocument(pages: DocumentPage[]): ChunkResult {
  const sections = new HeadingChunker().split(pages);
  if (sections.length >= MIN_USEFUL_SECTIONS) {
    return { sections, strategy: "headings" };
  }
  return { sections: new TokenWindowChunker().split(pages), strategy: "token windows" };
}
