import * as config from "../config.ts";
import { isEmbeddable } from "../embedding/shared.ts";
import type { Embedder } from "../embedding/base.ts";
import type { KeywordIndex } from "./keywordIndex.ts";
import type { VectorStore } from "./vectorStore.ts";

const RRF_K = 60;

export interface Candidate {
  chunkId: string;
  fused: number;
  dense: number | null;
  sparse: number | null;
  denseRank: number | null;
  sparseRank: number | null;
  reranked?: number;
}

function absorb(
  merged: Map<string, Candidate>,
  ranking: [string, number][],
  k: number,
  record: (candidate: Candidate, score: number, rank: number) => void,
): void {
  for (const [index, [chunkId, score]] of ranking.entries()) {
    const rank = index + 1;
    let candidate = merged.get(chunkId);
    if (!candidate) {
      candidate = {
        chunkId,
        fused: 0,
        dense: null,
        sparse: null,
        denseRank: null,
        sparseRank: null,
      };
      merged.set(chunkId, candidate);
    }
    candidate.fused += 1 / (k + rank);
    record(candidate, score, rank);
  }
}

export function fuseRankings(
  dense: [string, number][],
  sparse: [string, number][],
  options: { k?: number; topN?: number } = {},
): Candidate[] {
  const k = options.k ?? RRF_K;
  const merged = new Map<string, Candidate>();

  absorb(merged, dense, k, (candidate, score, rank) => {
    candidate.dense = score;
    candidate.denseRank = rank;
  });
  absorb(merged, sparse, k, (candidate, score, rank) => {
    candidate.sparse = score;
    candidate.sparseRank = rank;
  });

  const fused = [...merged.values()];
  fused.sort((a, b) => {
    if (b.fused !== a.fused) return b.fused - a.fused;
    if (b.dense !== a.dense) return (b.dense ?? -Infinity) - (a.dense ?? -Infinity);
    return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
  });
  return options.topN === undefined ? fused : fused.slice(0, options.topN);
}

export interface HybridSearchDeps {
  embedder: Embedder;
  vectorStore: VectorStore;
  keywordIndex: KeywordIndex;
}

export async function hybridSearch(
  question: string,
  notebook: string,
  deps: HybridSearchDeps,
  k: number = config.CANDIDATES_K,
  documentIds?: readonly string[],
): Promise<Candidate[]> {
  if (!isEmbeddable(question)) return [];
  if (deps.keywordIndex.size === 0) return [];

  const queryVector = await deps.embedder.embedQuery(question);

  const dense = deps.vectorStore.search(
    notebook,
    queryVector,
    k,
    deps.embedder.modelId,
    documentIds,
  );
  const sparse = deps.keywordIndex.search(question, k, documentIds);

  return fuseRankings(dense, sparse, { topN: k });
}
