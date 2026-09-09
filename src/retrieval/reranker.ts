import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import * as config from "../config.ts";
import type { PreTrainedModel, PreTrainedTokenizer } from "@huggingface/transformers";
import type { Chunk } from "../models.ts";
import type { Candidate } from "../search/hybrid.ts";
import type { Reranker as RerankerInterface } from "./retriever.ts";

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

  static async create(modelName: string = config.RERANK_MODEL): Promise<Reranker> {
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(modelName),
      AutoModelForSequenceClassification.from_pretrained(modelName),
    ]);
    return new Reranker(tokenizer, model, modelName);
  }

  private async score(question: string, texts: string[]): Promise<number[]> {
    const scores: number[] = [];
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      const inputs = await this.tokenizer(
        batch.map(() => question),
        { text_pair: batch, padding: true, truncation: true },
      );
      const { logits } = await this.model(inputs);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      scores.push(...(logits.tolist() as number[][]).map((row) => row[0]!));
    }
    return scores;
  }

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

export function getReranker(): Promise<Reranker> {
  cached ??= Reranker.create();
  return cached;
}

export function resetReranker(): void {
  cached = null;
}
