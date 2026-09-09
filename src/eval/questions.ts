import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const QUESTIONS_DIR = "eval/questions";

export interface EvalQuestion {
  question: string;
  expectedSource: string | null;
  expectedPages: number[];
  expectedAnswerContains: string[][];
  unanswerable: boolean;
  note: string | null;
}

interface RawQuestion {
  question: string;
  expected_source?: string;
  expected_pages?: number[];
  expected_page?: number;
  expected_answer_contains?: (string | string[])[];
  unanswerable?: boolean;
  note?: string;
}

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
