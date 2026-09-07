import { Command } from "commander";
import { ingestFile } from "./src/notebook/ingest.ts";
import * as config from "./src/config.ts";
import { getEmbedder } from "./src/embedding/index.ts";
import { formatAnswer } from "./src/generation/answer.ts";
import { askInNotebook } from "./src/notebook/chat.ts";
import { buildPrompt } from "./src/generation/prompts.ts";
import { supportedExtensions } from "./src/loaders/index.ts";
import { NotebookStore } from "./src/notebook/store.ts";
import { formatPages, Retriever } from "./src/retrieval/index.ts";
import { VectorStore } from "./src/search/vectorStore.ts";

const program = new Command();
program.name("notebook").description("a NotebookLM you can read the source of");

program
  .command("add")
  .description("add a source to a notebook")
  .argument("<notebook>", "which notebook to add it to")
  .argument("<path>", `path to a source file (${supportedExtensions().join(", ")})`)
  .action(async (notebook: string, path: string) => {
    await ingestFile(notebook, path);
  });

program
  .command("list")
  .description("list every notebook on this machine")
  .action(() => {
    const notebooks = new NotebookStore().listNotebooks();
    if (notebooks.length === 0) {
      console.log("no notebooks yet - create one with `notebook add <name> <file>`");
      return;
    }
    console.log(`${notebooks.length} notebook(s):`);
    for (const notebook of notebooks) {
      console.log(
        `  ${notebook.notebook.padEnd(24)} ${String(notebook.sources).padStart(3)} source(s)` +
        `  ${String(notebook.pages).padStart(5)} page(s)   first added ${notebook.addedAt.slice(0, 10)}`,
      );
    }
  });

program
  .command("sources")
  .description("list a notebook's sources")
  .argument("<notebook>")
  .action((notebook: string) => {
    const documents = new NotebookStore().listDocuments(notebook);
    if (documents.length === 0) {
      console.log(`notebook '${notebook}' is empty`);
      return;
    }
    console.log(`${notebook}: ${documents.length} source(s)`);
    for (const document of documents) {
      console.log(
        `  ${document.documentId}  ${document.filename.padEnd(40)} ` +
        `${String(document.pageCount).padStart(4)}p  ${document.addedAt}`,
      );
    }
  });

program
  .command("remove")
  .description("remove a source from a notebook")
  .argument("<notebook>")
  .argument("<documentId>", "the id shown by `sources`")
  .action((notebook: string, documentId: string) => {
    // text first: if the vector delete fails, a re-`add` still works, because the
    // document row that guards it is already gone
    const { removed, chunksRemoved } = new NotebookStore().deleteDocument(
      notebook,
      documentId,
    );
    if (!removed) {
      console.log(`notebook '${notebook}' has no source with id ${documentId}`);
      return;
    }
    // Scoped to this notebook: another notebook may hold the same file, and its
    // vectors must survive.
    new VectorStore().deleteDocument(documentId, notebook);
    console.log(
      `removed ${documentId} from ${notebook}` +
      (chunksRemoved ? "" : " (its text is kept - another notebook still uses it)"),
    );
  });

program
  .command("ask")
  .description("ask a question about a notebook, answered only from its sources")
  .argument("<notebook>")
  .argument("<question>")
  .option("-k, --top <n>", "how many passages to ground the answer in", String(config.CONTEXT_K))
  .option("--show-prompt", "print the prompt sent to the model, then the answer")
  .option("--no-history", "do not read or save the conversation for this question")
  .action(
    async (
      notebook: string,
      question: string,
      options: { top: string; showPrompt?: boolean; history?: boolean },
    ) => {
      const k = Number.parseInt(options.top, 10);
      if (!Number.isInteger(k) || k < 1) throw new Error("--top must be a positive integer");

      const started = performance.now();
      const result = await askInNotebook(notebook, question, {
        k,
        stateless: options.history === false,
      });

      // Say so when retrieval searched for something other than what was typed.
      // A silently rewritten question is the hardest kind of answer to trust.
      if (result.rewritten) {
        console.log(`(follow-up resolved to: "${result.searchedFor}")
`);
      }
      console.log(formatAnswer(result.answer));

      if (result.answer.origin !== "model") {
        console.log(`
(refused without calling the model: ${result.answer.origin})`);
      }
      console.log(
        `
${(performance.now() - started).toFixed(0)}ms` +
        (options.history === false ? "  (not saved)" : `  |  turn ${result.historyLength + 1}`),
      );
    },
  );

program
  .command("history")
  .description("show a notebook's conversation")
  .argument("<notebook>")
  .action((notebook: string) => {
    const messages = new NotebookStore().messages(notebook);
    if (messages.length === 0) {
      console.log(`notebook '${notebook}' has no conversation yet`);
      return;
    }
    for (const message of messages) {
      if (message.role === "user") {
        console.log(`
You  ${message.createdAt.slice(0, 19).replace("T", " ")}`);
        console.log(`  ${message.text}`);
        if (message.resolvedQuestion) {
          console.log(`  (searched for: ${message.resolvedQuestion})`);
        }
      } else {
        console.log("\nNotebook");
        // Indent every line of the answer, so a multi-paragraph reply still
        // reads as one speaker's turn in the transcript.
        console.log(`  ${message.text.replace(/\n/g, "\n  ")}`);
        for (const citation of message.citations) {
          console.log(
            `    [${citation.marker}] ${citation.filename}, ` +
            `${formatPages(citation.pageStart, citation.pageEnd)}` +
            (citation.headingPath.length > 0 ? `, "${citation.headingPath.join(" > ")}"` : ""),
          );
        }
      }
    }
    console.log(`
${messages.length} message(s)`);
  });

program
  .command("forget")
  .description("clear a notebook's conversation, keeping its sources")
  .argument("<notebook>")
  .action((notebook: string) => {
    const removed = new NotebookStore().clearMessages(notebook);
    console.log(
      removed === 0
        ? `notebook '${notebook}' had no conversation`
        : `cleared ${removed} message(s) from ${notebook} - its sources are untouched`,
    );
  });

program
  .command("search")
  .description("show the passages retrieval would hand the answerer, with no LLM involved")
  .argument("<notebook>")
  .argument("<question>")
  .option("-k, --top <n>", "how many passages to return", String(config.CONTEXT_K))
  .option("--full", "print each passage whole instead of its first 500 characters")
  .action(async (notebook: string, question: string, options: { top: string; full?: boolean }) => {
    const k = Number.parseInt(options.top, 10);
    if (!Number.isInteger(k) || k < 1) throw new Error(`--top must be a positive integer`);

    const started = performance.now();
    const retriever = await Retriever.create(notebook);
    const passages = await retriever.retrieve(question, { k });
    const elapsed = performance.now() - started;

    console.log(`Q: ${question}`);
    if (passages.length === 0) {
      // Distinguish the two reasons, because the fixes are entirely different.
      const sources = retriever.store.listDocuments(notebook).length;
      console.log(
        sources === 0
          ? `\nnotebook '${notebook}' has no sources - add one with \`notebook add\``
          : "\nnothing matched. Both searches came back empty, which for a non-empty " +
          "notebook usually means the question shares no words with it and is far " +
          "from it in meaning too.",
      );
      return;
    }

    for (const [index, passage] of passages.entries()) {
      const heading = passage.headingPath.join(" > ") || passage.sectionTitle || "(no heading)";
      console.log(
        `\n[${index + 1}] ${passage.filename}  ${formatPages(passage.pageStart, passage.pageEnd)}` +
        `  |  ${heading}`,
      );
      // Where it came from matters as much as the score. "found by keyword only"
      // is the difference between retrieval working and retrieval getting lucky.
      const found = [
        passage.match.denseRank !== null
          ? `meaning #${passage.match.denseRank} (cos ${passage.match.dense?.toFixed(3)})`
          : null,
        passage.match.sparseRank !== null
          ? `keyword #${passage.match.sparseRank} (bm25 ${passage.match.sparse?.toFixed(2)})`
          : null,
      ].filter((part) => part !== null);
      console.log(
        `    fused ${passage.match.fused.toFixed(5)}  |  found by ${found.join(" + ")}` +
        `  |  ${passage.matchCount} matching chunk(s)  |  ${passage.blockKinds.join(", ")}`,
      );
      console.log(
        options.full ? passage.text : passage.text.slice(0, 500).trimEnd() +
          (passage.text.length > 500 ? " ..." : ""),
      );
    }
    console.log(`\n${passages.length} passage(s) in ${elapsed.toFixed(0)}ms`);
  });

program
  .command("embed-check")
  .description("verify the configured embedder actually works, and report what it returns")
  .action(async () => {
    console.log(`provider: ${config.EMBEDDING_PROVIDER}`);
    const started = performance.now();
    const embedder = await getEmbedder();
    console.log(`model:    ${embedder.modelId}`);
    console.log(`ready in  ${(performance.now() - started).toFixed(0)}ms`);

    const passages = [
      "Failed charges are retried three times over seventy-two hours.",
      "A declined payment is attempted again for three days.",
      "The office cafeteria serves lunch until two in the afternoon.",
    ];

    const t1 = performance.now();
    const vectors = await embedder.embedDocuments(passages);
    console.log(
      `\nembedDocuments: ${passages.length} passages in ` +
      `${(performance.now() - t1).toFixed(0)}ms`,
    );
    console.log(`  dimensions:   ${vectors[0]?.length} (expected ${embedder.dimensions})`);
    const norms = vectors.map((v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)));
    console.log(`  vector norms: ${norms.map((n) => n.toFixed(6)).join(", ")}`);
    console.log(
      `  all unit length: ${norms.every((n) => Math.abs(n - 1) < 1e-3) ? "yes" : "NO"}`,
    );

    const t2 = performance.now();
    const query = await embedder.embedQuery("how are failed payments retried?");
    console.log(`\nembedQuery: ${(performance.now() - t2).toFixed(0)}ms`);

    // The real test of an embedder: does it separate related from unrelated?
    const cosine = (a: number[], b: number[]): number =>
      a.reduce((sum, x, i) => sum + x * b[i]!, 0);
    console.log("\ncosine against the query:");
    for (const [index, passage] of passages.entries()) {
      console.log(`  ${cosine(query, vectors[index]!).toFixed(4)}  ${passage.slice(0, 52)}`);
    }
    const margin = cosine(query, vectors[0]!) - cosine(query, vectors[2]!);
    console.log(`\nrelevant-minus-irrelevant margin: ${margin.toFixed(4)}`);
    console.log(
      margin > 0.15
        ? "looks healthy - the embedder separates related from unrelated text"
        : "! margin is suspiciously small. Check the model id and pooling.",
    );
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  // Set the code rather than calling process.exit(): a forced exit while an
  // HTTP keep-alive socket is still closing trips an assertion inside libuv on
  // Windows. Letting the loop drain exits just as promptly, and cleanly.
  process.exitCode = 1;
}
