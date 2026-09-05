/**
 * Loads the hand-written question set.
 *
 * The JSON keys stay snake_case because you type them by hand, next to a
 * document that names its columns the same way. This file translates them to
 * camelCase on the way in, exactly as store.ts does for database columns.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const QUESTIONS_DIR = "eval/questions";

export interface EvalQuestion {
  question: string;
  /** Filename the answer should come from. Null for unanswerable questions. */
  expectedSource: string | null;
  /** Any page whose content answers it. A passage counts as a hit when its page
   *  range overlaps one of these - so the ground truth survives a re-chunk,
   *  which chunk ids would not. */
  expectedPages: number[];
  /**
   * Facts an answer must contain, lowercased before comparison. Empty means the
   * question has no single checkable fact and is scored on behaviour instead.
   *
   * Each entry is a list of accepted wordings, and matching any one of them
   * counts. That is not convenience, it is correctness: a plain substring grader
   * scored a *better* answer lower because it wrote "if a car breaks down" where
   * the previous one quoted "breakdown". A grader that punishes paraphrase makes
   * every prompt comparison it is used for untrustworthy.
   */
  expectedAnswerContains: string[][];
  /** The sources genuinely cannot answer it, and refusing is the correct result. */
  unanswerable: boolean;
  /** Why this question is in the set. Printed with failures, so a bad score comes
   *  with the reason the question was chosen. */
  note: string | null;
}

interface RawQuestion {
  question: string;
  expected_source?: string;
  expected_pages?: number[];
  expected_page?: number;
  /** A bare string means one accepted wording; a nested list means any-of. */
  expected_answer_contains?: (string | string[])[];
  unanswerable?: boolean;
  note?: string;
}

/**
 * Loads a notebook's questions.
 *
 * `<notebook>.json` wins when it exists, and only then; otherwise every .json in
 * the directory is merged. The scoping is not cosmetic - a question set is
 * ground truth *about one corpus*, so merging two notebooks' files would mark
 * every question unanswerable against the other's documents and quietly report
 * a catastrophic score.
 */
export async function loadQuestions(
  notebook?: string,
  directory: string = QUESTIONS_DIR,
): Promise<EvalQuestion[]> {
  const available = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const scoped = notebook === undefined ? null : `${notebook}.json`;
  const files = scoped !== null && available.includes(scoped) ? [scoped] : available;
  const questions: EvalQuestion[] = [];

  for (const file of files) {
    const data: unknown = JSON.parse(await readFile(join(directory, file), "utf8"));
    const entries: RawQuestion[] = Array.isArray(data)
      ? (data as RawQuestion[])
      : ((data as { questions?: RawQuestion[] }).questions ?? []);

    for (const entry of entries) {
      // `expected_page` singular is accepted too - it is the natural thing to
      // type for the common case of one page.
      const pages =
        entry.expected_pages ?? (entry.expected_page === undefined ? [] : [entry.expected_page]);
      questions.push({
        question: entry.question,
        expectedSource: entry.expected_source ?? null,
        expectedPages: pages,
        expectedAnswerContains: (entry.expected_answer_contains ?? []).map((term) =>
          typeof term === "string" ? [term] : term,
        ),
        unanswerable: entry.unanswerable ?? false,
        note: entry.note ?? null,
      });
    }
  }
  if (questions.length === 0) throw new Error(`no questions found in ${directory}`);
  return questions;
}
