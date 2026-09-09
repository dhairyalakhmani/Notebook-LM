import * as config from "../config.ts";
import { answerQuestion } from "../generation/answer.ts";
import { resolveQuestion } from "../generation/followup.ts";
import { LLMClient } from "../llm/client.ts";
import { asRateLimitError, isRateLimitError } from "../llm/errors.ts";
import { chooseQuote } from "../generation/quote.ts";
import { Retriever } from "../retrieval/retriever.ts";
import { NotebookStore } from "./store.ts";
import type { Answer } from "../generation/answer.ts";
import type { CompletionModel } from "../llm/client.ts";
import type { ChatMessage, Chunk, Citation, StoredPassage } from "../models.ts";
import type { QuotaSnapshot } from "../llm/errors.ts";
import type { Passage } from "../retrieval/retriever.ts";

const HISTORY_TURNS = 6;

export interface AskOptions {
  retriever?: Retriever;
  store?: NotebookStore;
  model?: CompletionModel;
  k?: number;
  stateless?: boolean;
  sourceIds?: readonly string[];
  historyTurns?: number;
}

export interface AskTimings {
  rewriteMs: number;
  retrieveMs: number;
  answerMs: number;
  totalMs: number;
}

export interface AskResult {
  answer: Answer;
  question: string;
  searchedFor: string;
  rewritten: boolean;
  historyLength: number;
  citations: Citation[];
  timings: AskTimings;
  quota: QuotaSnapshot | null;
  userMessageId: number | null;
  assistantMessageId: number | null;
}

function citationsOf(answer: Answer, children: Map<string, Chunk>): Citation[] {
  return answer.used.map((marker) => {
    const passage = answer.passages[marker - 1]!;
    const child = children.get(passage.match.chunkId) ?? null;
    const choice = chooseQuote(answer.text, marker, passage, child);
    return {
      marker,
      filename: passage.filename,
      pageStart: passage.pageStart,
      pageEnd: passage.pageEnd,
      headingPath: passage.headingPath,
      sourceId: passage.documentId,
      quote: choice?.quote ?? null,
    };
  });
}

function passagesOf(answer: Answer): StoredPassage[] {
  const cited = new Set(answer.used);
  return answer.passages.map((passage: Passage, index) => ({
    marker: index + 1,
    documentId: passage.documentId,
    filename: passage.filename,
    pageStart: passage.pageStart,
    pageEnd: passage.pageEnd,
    headingPath: passage.headingPath,
    cosine: passage.match.dense,
    bm25: passage.match.sparse,
    denseRank: passage.match.denseRank,
    sparseRank: passage.match.sparseRank,
    fused: passage.match.fused,
    matchCount: passage.matchCount,
    cited: cited.has(index + 1),
  }));
}

async function inPhase<T>(phase: "rewrite" | "answer", work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const limit = isRateLimitError(error) ? error : asRateLimitError(error);
    throw limit ? limit.withPhase(phase) : error;
  }
}

export async function askInNotebook(
  notebook: string,
  question: string,
  options: AskOptions = {},
): Promise<AskResult> {
  const store = options.store ?? new NotebookStore();
  const model = options.model ?? new LLMClient(config.GROQ_MODEL);

  const startedAt = performance.now();
  const historyTurns = options.historyTurns ?? HISTORY_TURNS;
  const history = options.stateless ? [] : store.recentMessages(notebook, historyTurns);

  const rewriteStarted = performance.now();
  const resolved = await inPhase("rewrite", () => resolveQuestion(question, history, model));
  const rewriteMs = performance.now() - rewriteStarted;

  const retriever = options.retriever ?? (await Retriever.create(notebook, { store }));
  const retrieveStarted = performance.now();
  const passages = await retriever.retrieve(resolved.question, {
    ...(options.k === undefined ? {} : { k: options.k }),
    ...(options.sourceIds === undefined ? {} : { documentIds: options.sourceIds }),
  });
  const retrieveMs = performance.now() - retrieveStarted;

  const answerStarted = performance.now();
  const answer = await inPhase("answer", () =>
    answerQuestion(resolved.question, notebook, { passages, model }),
  );
  const answerMs = performance.now() - answerStarted;

  const children = store.getChunks(answer.passages.map((passage) => passage.match.chunkId));

  const citations = citationsOf(answer, children);

  let userMessageId: number | null = null;
  let assistantMessageId: number | null = null;

  if (!options.stateless) {
    const now = new Date().toISOString();
    userMessageId = store.addMessage({
      notebook,
      role: "user",
      text: question,
      createdAt: now,
      citations: [],
      resolvedQuestion: resolved.rewritten ? resolved.question : null,
    }).messageId;
    assistantMessageId = store.addMessage({
      notebook,
      role: "assistant",
      text: answer.text,
      createdAt: new Date().toISOString(),
      citations,
      passages: passagesOf(answer),
      resolvedQuestion: null,
    }).messageId;
  }

  return {
    answer,
    question,
    searchedFor: resolved.question,
    rewritten: resolved.rewritten,
    historyLength: history.length,
    citations,
    timings: {
      rewriteMs,
      retrieveMs,
      answerMs,
      totalMs: performance.now() - startedAt,
    },
    quota: model.lastQuota ?? null,
    userMessageId,
    assistantMessageId,
  };
}

export type { ChatMessage };
