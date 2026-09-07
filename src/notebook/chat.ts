/**
 * A notebook conversation: history in, cited answer out, both turns saved.
 *
 * This is the layer the CLI and any future UI both call, so the ordering below
 * is the product's behaviour rather than one caller's convenience:
 *
 *   load recent history -> rewrite the question if it is a follow-up
 *   -> retrieve for the REWRITTEN question -> answer from those passages only
 *   -> persist the user turn and the assistant turn
 *
 * **The boundary that matters:** history reaches the rewrite step and stops
 * there. It is never added to the answer prompt. A prior answer is model
 * output, not source text - feeding it back would let turn one's small
 * imprecision become turn three's cited fact, which is the precise failure this
 * project exists to prevent. Every answer is grounded in passages retrieved
 * now, from the documents, and in nothing else.
 */

import * as config from "../config.ts";
import { answerQuestion } from "../generation/answer.ts";
import { resolveQuestion } from "../generation/followup.ts";
import { LLMClient } from "../llm/client.ts";
import { Retriever } from "../retrieval/retriever.ts";
import { NotebookStore } from "./store.ts";
import type { Answer } from "../generation/answer.ts";
import type { CompletionModel } from "../llm/client.ts";
import type { ChatMessage, Citation } from "../models.ts";

/** Turns of history offered to the rewriter: three exchanges. Enough for what
 *  "that" can plausibly mean, small enough to keep the call cheap. */
const HISTORY_TURNS = 6;

export interface AskOptions {
  retriever?: Retriever;
  store?: NotebookStore;
  model?: CompletionModel;
  k?: number;
  /** Skip loading and saving history - a one-off question, as `ask --no-history`. */
  stateless?: boolean;
}

export interface AskResult {
  answer: Answer;
  /** What the user typed. */
  question: string;
  /** What retrieval actually searched for. Differs on a resolved follow-up. */
  searchedFor: string;
  rewritten: boolean;
  /** How many turns preceded this one. */
  historyLength: number;
}

/** Citations are stored by where they point, not by chunk id - see models.ts. */
function citationsOf(answer: Answer): Citation[] {
  return answer.used.map((marker) => {
    const passage = answer.passages[marker - 1]!;
    return {
      marker,
      filename: passage.filename,
      pageStart: passage.pageStart,
      pageEnd: passage.pageEnd,
      headingPath: passage.headingPath,
    };
  });
}

export async function askInNotebook(
  notebook: string,
  question: string,
  options: AskOptions = {},
): Promise<AskResult> {
  const store = options.store ?? new NotebookStore();
  const model = options.model ?? new LLMClient(config.GROQ_MODEL);

  const history = options.stateless ? [] : store.recentMessages(notebook, HISTORY_TURNS);
  const resolved = await resolveQuestion(question, history, model);

  const retriever = options.retriever ?? (await Retriever.create(notebook, { store }));
  const passages = await retriever.retrieve(resolved.question, {
    ...(options.k === undefined ? {} : { k: options.k }),
  });

  // Note `model` is passed through: one client, so a stub in tests intercepts
  // both the rewrite and the answer.
  const answer = await answerQuestion(resolved.question, notebook, { passages, model });

  if (!options.stateless) {
    const now = new Date().toISOString();
    // The user's own words are stored, with the rewrite alongside rather than in
    // place of them - a thread that silently replaced what someone typed would
    // be a confusing thing to scroll back through.
    store.addMessage({
      notebook,
      role: "user",
      text: question,
      createdAt: now,
      citations: [],
      resolvedQuestion: resolved.rewritten ? resolved.question : null,
    });
    store.addMessage({
      notebook,
      role: "assistant",
      text: answer.text,
      createdAt: new Date().toISOString(),
      citations: citationsOf(answer),
      resolvedQuestion: null,
    });
  }

  return {
    answer,
    question,
    searchedFor: resolved.question,
    rewritten: resolved.rewritten,
    historyLength: history.length,
  };
}

export type { ChatMessage };
