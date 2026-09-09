import { BM25 } from "./bm25.ts";
import { NotebookStore } from "../notebook/store.ts";

const WORD = /[a-z0-9_]+/g;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

export class KeywordIndex {
  private chunkIds: string[];
  private documentIds: string[];
  private bm25: BM25 | null;

  constructor(chunkIds: string[], corpus: string[][], documentIds: string[] = []) {
    this.chunkIds = chunkIds;
    this.documentIds = documentIds;
    this.bm25 = corpus.length > 0 ? new BM25(corpus) : null;
  }

  static forNotebook(notebook: string, store: NotebookStore = new NotebookStore()): KeywordIndex {
    const chunks = store.childChunks(notebook);
    return new KeywordIndex(
      chunks.map((chunk) => chunk.chunkId),
      chunks.map((chunk) => tokenize(chunk.text)),
      chunks.map((chunk) => chunk.documentId),
    );
  }

  search(query: string, k: number, documentIds?: readonly string[]): [string, number][] {
    if (!this.bm25) return [];
    const scope = documentIds && documentIds.length > 0 ? new Set(documentIds) : null;
    const scored: [string, number][] = [];
    for (const [doc, score] of this.bm25.scores(tokenize(query))) {
      if (score <= 0) continue;
      const chunkId = this.chunkIds[doc]!;
      if (scope && !scope.has(this.documentIds[doc] ?? "")) continue;
      scored.push([chunkId, score]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, k);
  }

  get size(): number {
    return this.chunkIds.length;
  }
}
