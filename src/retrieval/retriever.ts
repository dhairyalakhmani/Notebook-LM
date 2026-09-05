/**
 * The question-time entry point.
 *
 *   question -> hybrid search over CHILD chunks -> expand each child to its
 *   PARENT -> deduplicate -> the handful of passages the answerer will read.
 *
 * Searching children and returning parents is Phase 2 paying off. A child is
 * small, so it is about one thing and matches precisely; a parent is large, so it
 * reads as a coherent passage with the surrounding context a reader needs. You
 * want to match on the first and hand over the second.
 */

import * as config from "../config.ts";
import { getEmbedder } from "../embedding/index.ts";
import { getReranker } from "./reranker.ts";
import { NotebookStore } from "../notebook/store.ts";
import { hybridSearch } from "../search/hybrid.ts";
import { KeywordIndex } from "../search/keywordIndex.ts";
import { VectorStore } from "../search/vectorStore.ts";
import type { Embedder } from "../embedding/base.ts";
import type { BlockKind, Chunk } from "../models.ts";
import type { Candidate } from "../search/hybrid.ts";

/** One parent chunk, ready to be read by the LLM and cited. */
export interface Passage {
  chunkId: string;
  documentId: string;
  /** For the citation. `title` is the file without its extension. */
  filename: string;
  title: string;
  /** A chunk can span pages, so a citation is a range, not a page. */
  pageStart: number | null;
  pageEnd: number | null;
  /** ["1. USER & ACCESS DOMAIN", "Customer"] - structured, so a citation can be
   *  rendered however the caller likes instead of parsing a joined string. */
  headingPath: string[];
  sectionTitle: string | null;
  /** Lets the answerer know it is looking at a table rather than prose. */
  blockKinds: BlockKind[];
  text: string;
  /**
   * The child chunk that put this passage in the list, and how it scored. Kept
   * whole rather than flattened: `match.dense` is the cosine Phase 6 needs to
   * refuse honestly, and `match.chunkId` is where to look when a passage that
   * should not be here is.
   */
  match: Candidate;
  /** How many of the candidate children landed inside this passage. One child is
   *  a hit; four is the question being squarely about this section. */
  matchCount: number;
}

/**
 * A cross-encoder that re-scores the candidates by reading the question and each
 * chunk *together*, which an embedding model never gets to do. Implemented in
 * reranker.ts and switched on by `config.USE_RERANKER`.
 *
 * It takes the already-fetched chunks rather than the store, so a reranker needs
 * to know nothing about storage and costs no second database round trip. The
 * returned order is authoritative, and the list may be shorter than the input.
 */
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
  /** How many passages to return. Defaults to `config.CONTEXT_K`. */
  k?: number;
}

/** "p. 4", "p. 4-5", or "p. ?" when the format carried no page numbers. */
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

  /**
   * Async because loading an embedding model is. Build one and reuse it: the
   * keyword index is rebuilt from SQLite here, which is milliseconds for a few
   * thousand chunks but is not free, and it does not see sources added after
   * this call. In a CLI that is a non-issue - every command is a fresh process.
   */
  static async create(notebook: string, parts: RetrieverParts = {}): Promise<Retriever> {
    const store = parts.store ?? new NotebookStore();
    return new Retriever(
      notebook,
      store,
      parts.vectorStore ?? new VectorStore(),
      parts.embedder ?? (await getEmbedder()),
      KeywordIndex.forNotebook(notebook, store),
      parts.reranker ?? (config.USE_RERANKER ? await getReranker() : null),
    );
  }

  async retrieve(question: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    const k = options.k ?? config.CONTEXT_K;

    const candidates = await hybridSearch(question, this.notebook, {
      embedder: this.embedder,
      vectorStore: this.vectorStore,
      keywordIndex: this.keywordIndex,
    });
    if (candidates.length === 0) return [];

    // Fetched once, here, because both remaining steps need it: a reranker would
    // want the text, and expansion needs the parentId.
    const children = this.store.getChunks(
      candidates.map((candidate) => candidate.chunkId),
    );

    const ranked = this.reranker
      ? await this.reranker.rerank(question, candidates, children)
      : candidates;

    // Expand child -> parent and deduplicate. Several children usually share one
    // parent, and that parent should be sent once, scored by its *best* child.
    // Summing its children's scores instead would sound fairer and is not: a sum
    // grows with parent size, so a long parent would win for being long.
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

    // No sort needed: candidates arrive best-first, so a parent is created the
    // first time one of its children appears - which is that parent's best
    // child - and a Map iterates in insertion order.
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
