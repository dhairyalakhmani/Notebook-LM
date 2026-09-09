import * as config from "../config.ts";
import { LLMClient } from "../llm/client.ts";
import { Retriever } from "../retrieval/retriever.ts";
import { REFUSAL, buildPrompt, label } from "./prompts.ts";
import type { CompletionModel } from "../llm/client.ts";
import type { Passage } from "../retrieval/retriever.ts";

const MARKER = /\[(\d+)\]/g;

const FULLWIDTH_MARKER = /【\s*(\d+)\s*】/g;

export function normalizeMarkers(text: string): string {
  return text.replace(FULLWIDTH_MARKER, "[$1]");
}

export interface Answer {
  text: string;
  passages: Passage[];
  used: number[];
  origin: "model" | "no-passages" | "below-relevance-floor";
}

export interface AnswerOptions {
  retriever?: Retriever;
  model?: CompletionModel;
  passages?: Passage[];
  k?: number;
  minRelevance?: number;
}

function bestRelevance(passages: Passage[]): number {
  let best = -Infinity;
  for (const passage of passages) {
    if (passage.match.dense === null) return Infinity;
    best = Math.max(best, passage.match.dense);
  }
  return best;
}

export function refused(answer: Answer): boolean {
  return answer.origin !== "model" || answer.text.toLowerCase().includes(REFUSAL.toLowerCase());
}

export function ungrounded(answer: Answer): boolean {
  return !refused(answer) && answer.used.length === 0;
}

export function formatAnswer(answer: Answer): string {
  const lines = [answer.text.trim()];
  if (answer.used.length > 0) {
    lines.push("\nSources:");
    for (const number of answer.used) {
      lines.push(`  ${label(answer.passages[number - 1]!, number - 1)}`);
    }
  }
  if (ungrounded(answer)) {
    lines.push(
      "\n! this answer cites nothing. It is not a refusal either, so the model " +
        "answered without pointing at a passage - treat it as unverified.",
    );
  }
  return lines.join("\n");
}

export function citedMarkers(text: string, passageCount: number): number[] {
  const numbers = [...text.matchAll(MARKER)]
    .map((match) => Number(match[1]))
    .filter((number) => number >= 1 && number <= passageCount);
  return [...new Set(numbers)].sort((a, b) => a - b);
}

export async function answerQuestion(
  question: string,
  notebook: string,
  options: AnswerOptions = {},
): Promise<Answer> {
  const passages =
    options.passages ??
    (await (options.retriever ?? (await Retriever.create(notebook))).retrieve(question, {
      ...(options.k === undefined ? {} : { k: options.k }),
    }));

  if (passages.length === 0) {
    return { text: REFUSAL, passages: [], used: [], origin: "no-passages" };
  }

  const floor = options.minRelevance ?? config.MIN_RELEVANCE_COSINE;
  if (floor > 0 && bestRelevance(passages) < floor) {
    return { text: REFUSAL, passages, used: [], origin: "below-relevance-floor" };
  }

  const model = options.model ?? new LLMClient(config.GROQ_MODEL);
  const text = normalizeMarkers((await model.generate(buildPrompt(question, passages))).trim());

  return { text, passages, used: citedMarkers(text, passages.length), origin: "model" };
}
