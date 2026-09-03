import { Command } from "commander";
import { ingestFile } from "./src/notebook/ingest.ts";
import * as config from "./src/config.ts";
import { getEmbedder } from "./src/embedding/index.ts";
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
    const removed = new NotebookStore().deleteDocument(notebook, documentId);
    if (!removed) {
      console.log(`notebook '${notebook}' has no source with id ${documentId}`);
      return;
    }
    new VectorStore().deleteDocument(documentId);
    console.log(`removed ${documentId} from ${notebook}`);
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
