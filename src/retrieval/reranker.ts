/**
 * Cross-encoder reranking — the precision pass over the ~30 candidates.
 *
 * The difference from the embedding model is not "a better model", it is a
 * different shape of computation. An embedder sees the question and the chunk on
 * separate occasions, turns each into ~384 numbers, and can only compare the two
 * summaries afterwards. A cross-encoder reads them **together, as one input**, so
 * every word of the question can attend to every word of the chunk.
 *
 * That is far more accurate and far too slow to run over a corpus: it is one
 * forward pass per (question, chunk) pair. Which is exactly why it belongs here,
 * on 30 candidates rather than 2,474 chunks.
 *
 * It earns its place only when hybrid search is finding the right passage and
 * ranking it too low. On the 775-page corpus that is measurably happening; on a
 * 9-chunk notebook it was not, which is why this file stayed empty until now.
 */

import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import * as config from "../config.ts";
import type { PreTrainedModel, PreTrainedTokenizer } from "@huggingface/transformers";
import type { Chunk } from "../models.ts";
import type { Candidate } from "../search/hybrid.ts";
import type { Reranker as RerankerInterface } from "./retriever.ts";

/** Pairs scored in one forward pass. Bounds peak memory on a long candidate list. */
const BATCH_SIZE = 16;

export class Reranker implements RerankerInterface {
  private tokenizer: PreTrainedTokenizer;
  private model: PreTrainedModel;
  readonly modelId: string;

  private constructor(tokenizer: PreTrainedTokenizer, model: PreTrainedModel, modelId: string) {
    this.tokenizer = tokenizer;
    this.model = model;
    this.modelId = modelId;
  }

  /** ~90MB on first use, then cached on disk. Loaded once, like the embedder. */
  static async create(modelName: string = config.RERANK_MODEL): Promise<Reranker> {
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(modelName),
      AutoModelForSequenceClassification.from_pretrained(modelName),
    ]);
    return new Reranker(tokenizer, model, modelName);
  }

  /**
   * Raw relevance logits, one per text. Unbounded, and negative means "not
   * relevant" - never interpret the number, only the order it produces.
   */
  private async score(question: string, texts: string[]): Promise<number[]> {
    const scores: number[] = [];
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      // `text_pair` is the whole idea: question and chunk enter as ONE input.
      const inputs = await this.tokenizer(
        batch.map(() => question),
        { text_pair: batch, padding: true, truncation: true },
      );
      const { logits } = await this.model(inputs);
      scores.push(...(logits.tolist() as number[][]).map((row) => row[0]!));
    }
    return scores;
  }

  /**
   * Re-scores the candidates and keeps the best `topN`, in the cross-encoder's
   * order. The fused score is left untouched rather than overwritten: it is what
   * the two searches actually said, and a Passage still reports it honestly.
   * `reranked` carries the new score for anything that wants to see it.
   */
  async rerank(
    question: string,
    candidates: Candidate[],
    chunks: Map<string, Chunk>,
    topN: number = config.RERANK_KEEP,
  ): Promise<Candidate[]> {
    const scorable = candidates.filter((candidate) => chunks.has(candidate.chunkId));
    if (scorable.length === 0) return [];

    const scores = await this.score(
      question,
      scorable.map((candidate) => chunks.get(candidate.chunkId)!.text),
    );

    return scorable
      .map((candidate, index) => ({ ...candidate, reranked: scores[index]! }))
      .sort((a, b) => b.reranked - a.reranked)
      .slice(0, topN);
  }
}

let cached: Promise<Reranker> | null = null;

/** Cached per process: loading the model is the expensive part, not scoring. */
export function getReranker(): Promise<Reranker> {
  cached ??= Reranker.create();
  return cached;
}

export function resetReranker(): void {
  cached = null;
}
