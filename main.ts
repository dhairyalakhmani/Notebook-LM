import { Command } from "commander";
import { ingestFile } from "./src/notebook/ingest.ts";
import { NotebookStore } from "./src/notebook/store.ts";

const program = new Command();
program.name("notebook").description("a NotebookLM you can read the source of");

program
  .command("add")
  .description("add a source to a notebook")
  .argument("<notebook>", "which notebook to add it to")
  .argument("<path>", "path to a .pdf, .txt or .md file")
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

try {
  await program.parseAsync();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
