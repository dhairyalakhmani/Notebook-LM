// Must come first: config.ts reads process.env at module scope.
import "../env.ts";
import { isRateLimitError } from "../llm/errors.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as config from "../config.ts";
import { answerQuestion, refused, ungrounded } from "../generation/answer.ts";
import { getReranker } from "../retrieval/reranker.ts";
import { Retriever } from "../retrieval/retriever.ts";
import { loadQuestions } from "./questions.ts";
import type { Answer } from "../generation/answer.ts";
import type { Passage, Reranker as RerankerInterface } from "../retrieval/retriever.ts";
import type { EvalQuestion } from "./questions.ts";

const RESULTS_DIR = "eval/results";

interface Result {
  question: EvalQuestion;
  passages: Passage[];
  hitRank: number | null;
  answer: Answer | null;
  generateMs: number | null;
  found: string[];
  missing: string[];
}

function isHit(passage: Passage, question: EvalQuestion): boolean {
  if (question.expectedSource === null) return false;
  if (passage.filename !== question.expectedSource) return false;
  if (question.expectedPages.length === 0) return true; // whole-file expectation
  const start = passage.pageStart ?? 0;
  const end = passage.pageEnd ?? start;
  return question.expectedPages.some((page) => page >= start && page <= end);
}

function firstHitRank(passages: Passage[], question: EvalQuestion): number | null {
  const index = passages.findIndex((passage) => isHit(passage, question));
  return index === -1 ? null : index + 1;
}

function percent(numerator: number, denominator: number): string {
  if (denominator === 0) return "  n/a";
  return `${((100 * numerator) / denominator).toFixed(0).padStart(3)}%`;
}

function bar(numerator: number, denominator: number, width = 20): string {
  if (denominator === 0) return "";
  const filled = Math.round((width * numerator) / denominator);
  return "#".repeat(filled) + ".".repeat(width - filled);
}

async function cappedReranker(topN: number): Promise<RerankerInterface> {
  const reranker = await getReranker();
  return {
    rerank: (question, candidates, chunks) => reranker.rerank(question, candidates, chunks, topN),
  };
}

async function answerPatiently(
  question: string,
  notebook: string,
  passages: Passage[],
): Promise<{ answer: Answer; ms: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const started = performance.now();
      const answer = await answerQuestion(question, notebook, { passages });
      return { answer, ms: performance.now() - started };
    } catch (error) {
      if (!isRateLimitError(error) || attempt > 4) throw error;
      const waitMs = error.retryAfterMs + 1500;
      process.stdout.write(
        `  rate limited on ${error.limitedOn}, waiting ${(waitMs / 1000).toFixed(0)}s ...
`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function run(): Promise<void> {
  const { values } = parseArgs({
    options: {
      notebook: { type: "string", default: "mynotebook" },
      k: { type: "string", default: String(config.CONTEXT_K) },
      retrieval: { type: "boolean", default: false },
      rerank: { type: "boolean", default: config.USE_RERANKER },
      "rerank-keep": { type: "string", default: String(config.RERANK_KEEP) },
      limit: { type: "string" },
    },
    allowPositionals: false,
  });

  const notebook = values.notebook;
  const k = Number.parseInt(values.k, 10);
  if (!Number.isInteger(k) || k < 1) throw new Error("--k must be a positive integer");

  const all = await loadQuestions(notebook);
  const questions =
    values.limit === undefined ? all : all.slice(0, Number.parseInt(values.limit, 10));
  const answerable = questions.filter((question) => !question.unanswerable);
  const unanswerable = questions.filter((question) => question.unanswerable);

  console.log(
    `${questions.length} question(s): ${answerable.length} answerable, ` +
      `${unanswerable.length} unanswerable  |  notebook '${notebook}'  |  k=${k}` +
      `  |  reranker ${values.rerank ? `on (${config.RERANK_MODEL}, keep ${values["rerank-keep"]})` : "off"}` +
      `  |  relevance floor ${config.MIN_RELEVANCE_COSINE || "off"}`,
  );
  console.log(
    values.retrieval ? "retrieval only - no model calls\n" : `model ${config.GROQ_MODEL}\n`,
  );

  const retriever = await Retriever.create(notebook, {
    reranker: values.rerank ? await cappedReranker(Number(values["rerank-keep"])) : null,
  });
  const results: Result[] = [];
  const started = performance.now();

  for (const [index, question] of questions.entries()) {
    const passages = await retriever.retrieve(question.question, { k });
    const hitRank = firstHitRank(passages, question);

    let answer: Answer | null = null;
    let generateMs: number | null = null;
    if (!values.retrieval) {
      const outcome = await answerPatiently(question.question, notebook, passages);
      answer = outcome.answer;
      generateMs = outcome.ms;
    }

    const text = (answer?.text ?? "").toLowerCase();
    const present = (wordings: string[]): boolean =>
      wordings.some((wording) => text.includes(wording.toLowerCase()));
    const found = question.expectedAnswerContains.filter(present).map((w) => w[0]!);
    const missing = question.expectedAnswerContains
      .filter((wordings) => !present(wordings))
      .map((w) => w[0]!);

    results.push({ question, passages, hitRank, answer, generateMs, found, missing });
    process.stdout.write(`  ${index + 1}/${questions.length}\r`);
  }
  const elapsed = performance.now() - started;

  console.log(report(results, k, elapsed, values.retrieval));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await mkdir(RESULTS_DIR, { recursive: true });
  const path = join(
    RESULTS_DIR,
    `${stamp}-k${k}${values.rerank ? "-rerank" : ""}${values.retrieval ? "-retrieval" : ""}.json`,
  );
  await writeFile(
    path,
    `${JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        notebook,
        k,
        config: {
          embeddingModel: config.HF_EMBEDDING_MODEL,
          groqModel: values.retrieval ? null : config.GROQ_MODEL,
          candidatesK: config.CANDIDATES_K,
          useReranker: values.rerank,
          minRelevanceCosine: config.MIN_RELEVANCE_COSINE,
        },
        results: results.map((result) => ({
          question: result.question.question,
          unanswerable: result.question.unanswerable,
          hitRank: result.hitRank,
          retrieved: result.passages.map((passage) => ({
            filename: passage.filename,
            pageStart: passage.pageStart,
            pageEnd: passage.pageEnd,
            heading: passage.headingPath.join(" > "),
            dense: passage.match.dense,
            sparse: passage.match.sparse,
          })),
          answer: result.answer?.text ?? null,
          origin: result.answer?.origin ?? null,
          cited: result.answer?.used ?? null,
          found: result.found,
          missing: result.missing,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`\nwritten to ${path}`);
}

function report(results: Result[], k: number, elapsed: number, retrievalOnly: boolean): string {
  const lines: string[] = [];
  const answerable = results.filter((result) => !result.question.unanswerable);
  const unanswerable = results.filter((result) => result.question.unanswerable);

  // ------------------------------------------------------------ per question
  lines.push("PER QUESTION");
  lines.push("-".repeat(78));
  for (const [index, result] of results.entries()) {
    const number = String(index + 1).padStart(2);
    const question = result.question.question;
    lines.push(`${number}. ${question.length > 72 ? `${question.slice(0, 69)}...` : question}`);

    if (result.question.unanswerable) {
      const correct = result.answer === null ? null : refused(result.answer);
      lines.push(
        `    retrieval: n/a (unanswerable)   ` +
          (correct === null
            ? ""
            : correct
              ? `refused correctly (${result.answer?.origin})`
              : "!! ANSWERED A QUESTION IT COULD NOT ANSWER"),
      );
    } else {
      const rank = result.hitRank === null ? `MISS (not in top ${k})` : `hit at #${result.hitRank}`;
      const best = result.passages[0]?.match.dense;
      lines.push(
        `    retrieval: ${rank.padEnd(22)}best cosine ${best === undefined || best === null ? "n/a" : best.toFixed(3)}`,
      );
      if (result.answer !== null) {
        const terms =
          result.question.expectedAnswerContains.length === 0
            ? `no fixed facts; cited ${result.answer.used.length} passage(s)`
            : `facts ${result.found.length}/${result.question.expectedAnswerContains.length}` +
              (result.missing.length > 0 ? `  missing: ${result.missing.join(", ")}` : "");
        lines.push(
          `    answer:    ${refused(result.answer) ? "REFUSED" : terms}` +
            (ungrounded(result.answer) ? "  !! cites nothing" : ""),
        );
      }
    }
    if (result.hitRank === null && !result.question.unanswerable && result.question.note) {
      lines.push(`    why it is here: ${result.question.note}`);
    }
  }

  // ------------------------------------------------------------- retrieval
  const recallAt = (limit: number): number =>
    answerable.filter((result) => result.hitRank !== null && result.hitRank <= limit).length;
  const mrr =
    answerable.reduce(
      (sum, result) => sum + (result.hitRank === null ? 0 : 1 / result.hitRank),
      0,
    ) / (answerable.length || 1);

  lines.push("");
  lines.push("RETRIEVAL  (the answerable questions only - did the right passage arrive?)");
  lines.push("-".repeat(78));
  for (const limit of [1, 3, k]) {
    if (limit > k) continue;
    lines.push(
      `  recall@${String(limit).padEnd(2)} ${percent(recallAt(limit), answerable.length)}  ` +
        `${bar(recallAt(limit), answerable.length)}  ${recallAt(limit)}/${answerable.length}`,
    );
  }
  lines.push(`  MRR@${k}     ${mrr.toFixed(3)}   (1.0 = the right passage was always first)`);

  // ------------------------------------------------------------ generation
  if (!retrievalOnly) {
    const graded = answerable.filter((result) => result.question.expectedAnswerContains.length > 0);
    const allFacts = graded.filter((result) => result.missing.length === 0).length;
    const totalFacts = graded.reduce(
      (sum, result) => sum + result.question.expectedAnswerContains.length,
      0,
    );
    const foundFacts = graded.reduce((sum, result) => sum + result.found.length, 0);

    const refusedWhenItShould = unanswerable.filter(
      (result) => result.answer !== null && refused(result.answer),
    ).length;
    const falseRefusals = answerable.filter(
      (result) => result.answer !== null && refused(result.answer),
    );
    const uncited = answerable.filter(
      (result) => result.answer !== null && ungrounded(result.answer),
    );

    lines.push("");
    lines.push("GENERATION");
    lines.push("-".repeat(78));
    lines.push(
      `  expected facts present     ${percent(foundFacts, totalFacts)}  ` +
        `${bar(foundFacts, totalFacts)}  ${foundFacts}/${totalFacts} terms`,
    );
    lines.push(
      `  questions with every fact  ${percent(allFacts, graded.length)}  ` +
        `${bar(allFacts, graded.length)}  ${allFacts}/${graded.length}`,
    );
    lines.push(
      `  refused the unanswerable   ${percent(refusedWhenItShould, unanswerable.length)}  ` +
        `${bar(refusedWhenItShould, unanswerable.length)}  ${refusedWhenItShould}/${unanswerable.length}` +
        "   <- honesty",
    );
    lines.push(
      `  false refusals             ${percent(falseRefusals.length, answerable.length)}  ` +
        `${bar(falseRefusals.length, answerable.length)}  ${falseRefusals.length}/${answerable.length}` +
        "   <- lower is better",
    );
    lines.push(
      `  answers citing nothing     ${percent(uncited.length, answerable.length)}  ` +
        `${bar(uncited.length, answerable.length)}  ${uncited.length}/${answerable.length}`,
    );

    const substantive = answerable.filter(
      (result) => result.answer !== null && !refused(result.answer),
    );
    const words = substantive.map(
      (result) => (result.answer?.text ?? "").split(/\s+/).filter(Boolean).length,
    );
    const cited = substantive.map((result) => result.answer?.used.length ?? 0);
    const mean = (values: number[]): number =>
      values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

    lines.push(
      `  mean answer length         ${mean(words).toFixed(0).padStart(4)} words ` +
        `(shortest ${Math.min(...words)}, longest ${Math.max(...words)})`,
    );
    lines.push(
      `  mean passages cited        ${mean(cited).toFixed(1).padStart(4)}  of ${k} supplied`,
    );

    // The reason the length budget exists: output tokens are what a user waits on.
    const gen = results
      .map((result) => result.generateMs)
      .filter((ms): ms is number => ms !== null)
      .sort((a, b) => a - b);
    if (gen.length > 0) {
      lines.push(
        `  LLM time per question      ${(mean(gen) / 1000).toFixed(1).padStart(4)}s mean, ` +
          `${(gen[Math.floor(gen.length / 2)]! / 1000).toFixed(1)}s median, ` +
          `${(gen[0]! / 1000).toFixed(1)}-${(gen.at(-1)! / 1000).toFixed(1)}s range`,
      );
    }
  }

  lines.push("");
  lines.push(
    `${results.length} question(s) in ${(elapsed / 1000).toFixed(1)}s ` +
      `(${(elapsed / results.length / 1000).toFixed(1)}s each)`,
  );
  return lines.join("\n");
}

await run();
