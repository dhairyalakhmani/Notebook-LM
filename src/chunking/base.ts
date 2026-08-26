import type { DocumentPage, Section } from "../models.ts";

export interface Chunker {
  split(pages: DocumentPage[]): Section[];
}
