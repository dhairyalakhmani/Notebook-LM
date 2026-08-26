import * as config from "../config.ts";
import { chunkDocument } from "./index.ts";
import { TokenWindowChunker } from "./tokenWindowChunker.ts";
import { TiktokenCounter } from "../tokenizer.ts";
import type { Chunk, DocumentPage, Section } from "../models.ts";
import type { TokenCounter } from "../tokenizer.ts";

/** "Billing > Retry policy" — prepended to each child so a chunk read alone
 *  still says what it is about. */
export function headingPath(section: Section): string {
  return [section.parentHeading, section.title].filter(Boolean).join(" > ");
}

export interface ParentChild {
  parents: Chunk[];
  children: Chunk[];
  strategy: string;
}

/**
 * Two sizes of the same text:
 *   children (~350 tokens) are what we search — small enough to match precisely
 *   parents (~1200 tokens) are what we read — big enough to hold the full answer
 * Each child records its parent, so a match on a child returns the parent's text.
 */
export function buildParentChild(
  pages: DocumentPage[],
  documentId: string,
  counter: TokenCounter = new TiktokenCounter(),
): ParentChild {
  const { sections, strategy } = chunkDocument(pages);

  const parentWindower = new TokenWindowChunker({
    maxTokens: config.PARENT_MAX_TOKENS,
    overlapTokens: 0,
    counter,
  });
  const childWindower = new TokenWindowChunker({
    maxTokens: config.CHILD_MAX_TOKENS,
    overlapTokens: config.CHILD_OVERLAP_TOKENS,
    counter,
  });

  const parents: Chunk[] = [];
  const children: Chunk[] = [];

  for (const section of sections) {
    const path = headingPath(section);
    const blocks =
      section.tokenCount <= config.PARENT_MAX_TOKENS
        ? [section.text]
        : parentWindower.windows(section.text);

    for (const block of blocks) {
      const parentId = `${documentId}-p${String(parents.length + 1).padStart(4, "0")}`;
      parents.push({
        chunkId: parentId,
        documentId,
        parentId: null,
        text: block,
        pageNumber: section.pageNumber,
        sectionTitle: path || null,
        tokenCount: counter.count(block),
      });

      for (const piece of childWindower.windows(block)) {
        const text = path ? `${path}\n${piece}` : piece;
        children.push({
          chunkId: `${documentId}-c${String(children.length + 1).padStart(5, "0")}`,
          documentId,
          parentId,
          text,
          pageNumber: section.pageNumber,
          sectionTitle: path || null,
          tokenCount: counter.count(text),
        });
      }
    }
  }
  return { parents, children, strategy };
}
