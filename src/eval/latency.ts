// Must come first: config.ts reads process.env at module scope.
import "../env.ts";
import { parseArgs } from "node:util";
import * as config from "../config.ts";
import { answerQuestion } from "../generation/answer.ts";
import { getEmbedder } from "../embedding/index.ts";
import { NotebookStore } from "../notebook/store.ts";
import { Retriever } from "../retrieval/retriever.ts";
import { KeywordIndex } from "../search/keywordIndex.ts";
import { VectorStore } from "../search/vectorStore.ts";
import { loadQuestions } from "./questions.ts";

async function timed<T>(work: () => Promise<T> | T): Promise<[T, number]> {
  const started = performance.now();
  const value = await work();
  return [value, performance.now() - started];
}

function stat(samples: number[]): string {
  if (samples.length === 0) return "n/a";
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return (
    `${mean.toFixed(0).padStart(6)}ms mean` +
    `  ${median.toFixed(0).padStart(6)}ms median` +
    `  ${sorted[0]!.toFixed(0).padStart(6)}-${sorted.at(-1)!.toFixed(0)}ms range`
  );
}

const { values } = parseArgs({
  options: {
    notebook: { type: "string", default: "networking" },
    n: { type: "string", default: "5" },
    retrieval: { type: "boolean", default: false },
  },
});

const notebook = values.notebook;
const count = Number.parseInt(values.n, 10);
const questions = (await loadQuestions(notebook))
  .filter((question) => !question.unanswerable)
  .slice(0, count)
  .map((question) => question.question);

console.log(`notebook '${notebook}'  |  ${questions.length} question(s)`);
console.log(`embedder ${config.EMBEDDING_PROVIDER}  |  model ${config.GROQ_MODEL}\n`);

// ------------------------------------------------------------ once per session
console.log("STARTUP  (paid once, when the app opens a notebook)");
console.log("-".repeat(72));
const store = new NotebookStore();
const [embedder, embedderMs] = await timed(() => getEmbedder());
console.log(`  load embedder          ${embedderMs.toFixed(0).padStart(6)}ms`);
const [vectorStore, vectorMs] = await timed(() => new VectorStore());
console.log(`  open vector store      ${vectorMs.toFixed(0).padStart(6)}ms`);
const [keywordIndex, indexMs] = await timed(() => KeywordIndex.forNotebook(notebook, store));
console.log(
  `  build keyword index    ${indexMs.toFixed(0).padStart(6)}ms   (${keywordIndex.size} chunks)`,
);
console.log(
  `  TOTAL STARTUP          ${(embedderMs + vectorMs + indexMs).toFixed(0).padStart(6)}ms\n`,
);

// --------------------------------------------------------- once per question
const embed: number[] = [];
const dense: number[] = [];
const sparse: number[] = [];
const expand: number[] = [];
const retrieval: number[] = [];
const generation: number[] = [];
const total: number[] = [];

const retriever = await Retriever.create(notebook, { store, vectorStore, embedder });

for (const question of questions) {
  const startedAll = performance.now();

  const [vector, embedMs] = await timed(() => embedder.embedQuery(question));
  const [, denseMs] = await timed(() =>
    vectorStore.search(notebook, vector, config.CANDIDATES_K, embedder.modelId),
  );
  const [, sparseMs] = await timed(() => keywordIndex.search(question, config.CANDIDATES_K));

  const [passages, retrieveMs] = await timed(() => retriever.retrieve(question));
  const expandMs = retrieveMs - embedMs - denseMs - sparseMs;

  embed.push(embedMs);
  dense.push(denseMs);
  sparse.push(sparseMs);
  expand.push(Math.max(0, expandMs));
  retrieval.push(retrieveMs);

  if (!values.retrieval) {
    const [, generateMs] = await timed(() => answerQuestion(question, notebook, { passages }));
    generation.push(generateMs);
  }
  total.push(performance.now() - startedAll);
}

console.log("PER QUESTION  (paid every time the user asks something)");
console.log("-".repeat(72));
console.log(`  embed the question     ${stat(embed)}`);
console.log(`  vector search          ${stat(dense)}`);
console.log(`  keyword search         ${stat(sparse)}`);
console.log(`  fuse + expand + fetch  ${stat(expand)}`);
console.log(`  = RETRIEVAL            ${stat(retrieval)}`);
if (generation.length > 0) {
  console.log(`  LLM answer             ${stat(generation)}`);
  console.log(`  = END TO END           ${stat(total)}`);
}
