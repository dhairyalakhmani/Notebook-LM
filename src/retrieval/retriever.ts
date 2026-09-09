import * as config from "../config.ts";
import { getEmbedder } from "../embedding/index.ts";
import { NotebookStore } from "../notebook/store.ts";
import { hybridSearch } from "../search/hybrid.ts";
import { KeywordIndex } from "../search/keywordIndex.ts";
import { VectorStore } from "../search/vectorStore.ts";
import type { Embedder } from "../embedding/base.ts";
import type { BlockKind, Chunk } from "../models.ts";
import type { Candidate } from "../search/hybrid.ts";

// Imported lazily: it pulls in onnxruntime, which is ~600 MB and unused here.
async function loadReranker(): Promise<Reranker> {
  const { getReranker } = await import("./reranker.ts");
  return getReranker();
}

export interface Passage {
  chunkId: string;
  documentId: string;
  filename: string;
  title: string;
  pageStart: number | null;
  pageEnd: number | null;
  headingPath: string[];
  sectionTitle: string | null;
  blockKinds: BlockKind[];
  text: string;
  match: Candidate;
  matchCount: number;
}

export interface Reranker {
  rerank(
    question: string,
    candidates: Candidate[],
    chunks: Map<string, Chunk>,
    topN?: number,
  ): Promise<Candidate[]>;
}

export interface RetrieverParts {
  store?: NotebookStore;
  vectorStore?: VectorStore;
  embedder?: Embedder;
  reranker?: Reranker | null;
}

export interface RetrieveOptions {
  k?: number;
  documentIds?: readonly string[];
}

export function formatPages(pageStart: number | null, pageEnd: number | null): string {
  if (pageStart === null) return "p. ?";
  if (pageEnd === null || pageEnd === pageStart) return `p. ${pageStart}`;
  return `p. ${pageStart}-${pageEnd}`;
}

export class Retriever {
  readonly notebook: string;
  readonly store: NotebookStore;
  private vectorStore: VectorStore;
  private embedder: Embedder;
  private keywordIndex: KeywordIndex;
  private reranker: Reranker | null;

  private constructor(
    notebook: string,
    store: NotebookStore,
    vectorStore: VectorStore,
    embedder: Embedder,
    keywordIndex: KeywordIndex,
    reranker: Reranker | null,
  ) {
    this.notebook = notebook;
    this.store = store;
    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.keywordIndex = keywordIndex;
    this.reranker = reranker;
  }

  static async create(notebook: string, parts: RetrieverParts = {}): Promise<Retriever> {
    const store = parts.store ?? new NotebookStore();
    return new Retriever(
      notebook,
      store,
      parts.vectorStore ?? new VectorStore(),
      parts.embedder ?? (await getEmbedder()),
      KeywordIndex.forNotebook(notebook, store),
      parts.reranker ?? (config.USE_RERANKER ? await loadReranker() : null),
    );
  }

  async retrieve(question: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    const k = options.k ?? config.CONTEXT_K;

    const candidates = await hybridSearch(
      question,
      this.notebook,
      {
        embedder: this.embedder,
        vectorStore: this.vectorStore,
        keywordIndex: this.keywordIndex,
      },
      config.CANDIDATES_K,
      options.documentIds,
    );
    if (candidates.length === 0) return [];

    const children = this.store.getChunks(candidates.map((candidate) => candidate.chunkId));

    const ranked = this.reranker
      ? await this.reranker.rerank(question, candidates, children)
      : candidates;

    const groups = new Map<string, { match: Candidate; matchCount: number }>();
    for (const candidate of ranked) {
      const child = children.get(candidate.chunkId);
      // Missing only if the source was removed between the search and now.
      if (!child) continue;
      const parentId = child.parentId ?? child.chunkId;
      const group = groups.get(parentId);
      if (group) group.matchCount += 1;
      else groups.set(parentId, { match: candidate, matchCount: 1 });
    }

    const top = [...groups.entries()].slice(0, k);
    const parents = this.store.getChunks(top.map(([parentId]) => parentId));

    const passages: Passage[] = [];
    for (const [parentId, group] of top) {
      // The fallback covers a child with no parent, whose key is its own id.
      const chunk = parents.get(parentId) ?? children.get(parentId);
      if (!chunk) continue;
      const document = this.store.getDocument(chunk.documentId);
      passages.push({
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        filename: document?.filename ?? chunk.documentId,
        title: document?.title ?? chunk.documentId,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        headingPath: chunk.headingPath,
        sectionTitle: chunk.sectionTitle,
        blockKinds: chunk.blockKinds,
        text: chunk.text,
        match: group.match,
        matchCount: group.matchCount,
      });
    }
    return passages;
  }
}
