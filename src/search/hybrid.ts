/**
 * Hybrid search — run both searches and merge them.
 *
 * The two halves fail in opposite directions, which is the whole reason both are
 * here. Embeddings understand meaning but are bad at rare exact strings: the
 * vector for a token the model barely saw in training, like `ERR_4021` or
 * `customer_id`, points nowhere useful. BM25 nails exactly those, because its
 * formula pays out for matching a *rare* word - and is helpless when the question
 * says "how do we bill customers" and the document says "invoicing process".
 *
 * Merging them is the largest reliable accuracy win available in this project.
 */

import * as config from "../config.ts";
import { isEmbeddable } from "../embedding/shared.ts";
import type { Embedder } from "../embedding/base.ts";
import type { KeywordIndex } from "./keywordIndex.ts";
import type { VectorStore } from "./vectorStore.ts";

/** The standard RRF constant. It does not need tuning. */
const RRF_K = 60;

/**
 * One chunk that at least one of the two searches found.
 *
 * `fused` is what the list is ordered by, but it is deliberately not the only
 * number here. An RRF score has no meaning on its own - every fused score lands
 * in a narrow band around 0.016-0.033 whether retrieval found gold or garbage,
 * because it is built from ranks and a rank of 1 exists in every result set.
 * So the underlying scores are carried through as well:
 *
 *   - `dense` is a cosine similarity, the one number here that is comparable
 *     across questions. Phase 6 needs it to answer "is anything relevant at
 *     all?" honestly instead of always finding a best-of-the-bad passage.
 *   - `sparse` is a BM25 score. Not comparable across notebooks (it moves as
 *     documents are added), but useful for seeing *why* something ranked.
 *   - a null rank means that search did not return this chunk at all.
 */
export interface Candidate {
  chunkId: string;
  fused: number;
  dense: number | null;
  sparse: number | null;
  denseRank: number | null;
  sparseRank: number | null;
  /** Cross-encoder score, when a reranker ran. Unbounded and often negative -
   *  meaningful only as an ordering, never as a confidence. */
  reranked?: number;
}

/** Adds one ranked list into the merge, crediting each chunk 1 / (k + rank). */
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

/**
 * Reciprocal Rank Fusion — merge the two rankings using *positions only*.
 *
 * A cosine similarity of 0.82 and a BM25 score of 11.4 are not comparable. They
 * are not even on the same scale: BM25 has no upper bound, and its values shift
 * as documents are added, so any weighted sum of the two would need a
 * corpus-wide normalisation that goes stale on the next ingest. Ranks have no
 * units, so they can just be added:
 *
 *     fused(chunk) = SUM over each list:  1 / (60 + its rank in that list)
 *
 * A chunk that appears in both lists beats a chunk that is first in only one,
 * which is exactly the behaviour wanted from two searches that fail in opposite
 * ways.
 */
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

  // Ties are common and not rare edge cases: a chunk found only by the dense
  // search at rank 3 scores exactly what a chunk found only by the sparse search
  // at rank 3 does. Break on cosine, the only score comparable between two
  // different chunks, then on id so the order is fully deterministic - retrieval
  // that reshuffles between identical runs is untestable and undebuggable.
  const fused = [...merged.values()];
  fused.sort((a, b) => {
    if (b.fused !== a.fused) return b.fused - a.fused;
    if (b.dense !== a.dense) return (b.dense ?? -Infinity) - (a.dense ?? -Infinity);
    return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
  });
  return options.topN === undefined ? fused : fused.slice(0, options.topN);
}

/** The three collaborators question time needs. Named, because
 *  `hybridSearch(q, nb, e, vs, ki, 30)` is six values in an order you have to
 *  remember, and an object cannot be passed wrong. */
export interface HybridSearchDeps {
  embedder: Embedder;
  vectorStore: VectorStore;
  keywordIndex: KeywordIndex;
}

/**
 * Returns candidate *child* chunks, best first.
 *
 * Both guards below exist to avoid embedding the question, which on the hosted
 * provider is a network round trip and the slowest step in the whole path. There
 * is nothing either search could match, so there is nothing to pay for.
 */
export async function hybridSearch(
  question: string,
  notebook: string,
  deps: HybridSearchDeps,
  k: number = config.CANDIDATES_K,
): Promise<Candidate[]> {
  if (!isEmbeddable(question)) return [];
  if (deps.keywordIndex.size === 0) return [];

  const queryVector = await deps.embedder.embedQuery(question);

  // The model id travels with the query: the store refuses to compare it against
  // vectors some other model produced, rather than returning confident nonsense.
  const dense = deps.vectorStore.search(notebook, queryVector, k, deps.embedder.modelId);
  const sparse = deps.keywordIndex.search(question, k);

  return fuseRankings(dense, sparse, { topN: k });
}
