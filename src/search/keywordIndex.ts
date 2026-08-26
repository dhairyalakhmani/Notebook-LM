import { BM25 } from "./bm25.ts";
import { NotebookStore } from "../notebook/store.ts";

const WORD = /[a-z0-9_]+/g;

/**
 * Lowercase, then split on anything that is not a letter, digit or underscore.
 * `ERR_4021` survives as one token, which is the whole point of BM25 here — split
 * it into "err" and "4021" and the rare-word advantage disappears.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

export class KeywordIndex {
  private chunkIds: string[];
  private bm25: BM25 | null;

  constructor(chunkIds: string[], corpus: string[][]) {
    this.chunkIds = chunkIds;
    this.bm25 = corpus.length > 0 ? new BM25(corpus) : null;
  }

  /**
   * Built from SQLite each time you start asking questions. For a few thousand
   * chunks that is milliseconds, so there is nothing to persist. If a notebook ever
   * gets big enough for that to be noticeable, save the postings to disk on `add`.
   */
  static forNotebook(notebook: string, store: NotebookStore = new NotebookStore()): KeywordIndex {
    const chunks = store.childChunks(notebook);
    return new KeywordIndex(
      chunks.map((chunk) => chunk.chunkId),
      chunks.map((chunk) => tokenize(chunk.text)),
    );
  }

  /** Returns [chunkId, bm25Score][], best first. Zero scores are dropped. */
  search(query: string, k: number): [string, number][] {
    if (!this.bm25) return [];
    const scored: [string, number][] = [];
    for (const [doc, score] of this.bm25.scores(tokenize(query))) {
      if (score > 0) scored.push([this.chunkIds[doc]!, score]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, k);
  }

  get size(): number {
    return this.chunkIds.length;
  }
}
