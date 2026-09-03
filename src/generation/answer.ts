/**
 * Retrieve, ground, answer, cite.
 *
 * The order matters: two of the three ways this can refuse happen *before* the
 * model is called, because a refusal the code makes is certain and a refusal the
 * model makes is a request. See `bestRelevance` below for the interesting one.
 */

import * as config from "../config.ts";
import { LLMClient } from "../llm/client.ts";
import { Retriever } from "../retrieval/retriever.ts";
import { REFUSAL, buildPrompt, label } from "./prompts.ts";
import type { CompletionModel } from "../llm/client.ts";
import type { Passage } from "../retrieval/retriever.ts";

/** `[2]`, or `[1][3]` as two separate matches. */
const MARKER = /\[(\d+)\]/g;

/**
 * Full-width brackets, U+3010 and U+3011.
 *
 * Not a theoretical case: gpt-oss-120b emits `【1】` instead of `[1]` on some
 * answers and ASCII on others, apparently depending on how markdown-heavy the
 * reply is. Left unhandled it is the worst kind of bug - a perfectly grounded,
 * correctly cited answer whose citations all silently vanish from the source
 * list, because the model was never disobeying, only using a different glyph.
 *
 * Normalising here, at the boundary where untrusted model output arrives, means
 * everything downstream only ever has to know about `[n]`.
 */
const FULLWIDTH_MARKER = /【\s*(\d+)\s*】/g;

export function normalizeMarkers(text: string): string {
  return text.replace(FULLWIDTH_MARKER, "[$1]");
}

export interface Answer {
  text: string;
  passages: Passage[];
  /** Which markers actually appeared in the answer, deduplicated and in order.
   *  Out-of-range markers are dropped: a `[7]` against five passages is the
   *  model inventing a citation, and it must not become a source line. */
  used: number[];
  /**
   * Where the text came from. A refusal decided here is not the same event as a
   * refusal the model chose to write, and Phase 10 needs to tell them apart to
   * report refusal accuracy honestly.
   */
  origin: "model" | "no-passages" | "below-relevance-floor";
}

export interface AnswerOptions {
  retriever?: Retriever;
  /** Any provider that turns a prompt into text. A stub in tests. */
  model?: CompletionModel;
  /** Phase 10 passes passages it already retrieved, to avoid searching twice. */
  passages?: Passage[];
  /** How many passages to retrieve. Ignored when `passages` is given. */
  k?: number;
  /** Overrides `config.MIN_RELEVANCE_COSINE`. Lets the eval sweep the threshold
   *  without editing config, which is how the number gets chosen. */
  minRelevance?: number;
}

/**
 * The best cosine among the passages, for the pre-flight relevance check.
 *
 * A passage found by BM25 alone has no cosine, and that case returns Infinity on
 * purpose - never refuse on it. Keyword-only is exactly the hit the embedder is
 * blind to: a rare identifier like `inspection_id` embeds to nothing in
 * particular, which is the whole reason BM25 is in the pipeline. Refusing
 * because cosine was low there would throw away the retrieval that worked.
 */
function bestRelevance(passages: Passage[]): number {
  let best = -Infinity;
  for (const passage of passages) {
    if (passage.match.dense === null) return Infinity;
    best = Math.max(best, passage.match.dense);
  }
  return best;
}

export function refused(answer: Answer): boolean {
  return (
    answer.origin !== "model" || answer.text.toLowerCase().includes(REFUSAL.toLowerCase())
  );
}

/** True when the answer states things but points at nothing. Not a refusal and
 *  not an answer - it is the prompt being ignored, and worth saying out loud. */
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

/** Pulls the `[n]` markers the model actually used out of its answer. */
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

  // Nothing retrieved: refuse here rather than asking the model to invent from
  // an empty context, which it will.
  if (passages.length === 0) {
    return { text: REFUSAL, passages: [], used: [], origin: "no-passages" };
  }

  // Retrieval always returns its best k, however weak - so a floor is the only
  // way "nothing here is relevant" gets said before the model is involved.
  const floor = options.minRelevance ?? config.MIN_RELEVANCE_COSINE;
  if (floor > 0 && bestRelevance(passages) < floor) {
    return { text: REFUSAL, passages, used: [], origin: "below-relevance-floor" };
  }

  const model = options.model ?? new LLMClient(config.GROQ_MODEL);
  const text = normalizeMarkers((await model.generate(buildPrompt(question, passages))).trim());

  return { text, passages, used: citedMarkers(text, passages.length), origin: "model" };
}
