import { access } from "node:fs/promises";
import { basename, extname } from "node:path";
import { buildParentChild } from "../chunking/parentChild.ts";
import { cleanPages } from "../cleaning/index.ts";
import { getEmbedder } from "../embedding/index.ts";
import { loadDocument } from "../loaders/index.ts";
import { documentIdForFile } from "../models.ts";
import { NotebookStore } from "./store.ts";
import { VectorStore } from "../search/vectorStore.ts";
import type { Document } from "../models.ts";
import type { Embedder } from "../embedding/index.ts";

export interface IngestOptions {
  store?: NotebookStore;
  vectorStore?: VectorStore;
  embedder?: Embedder;
}

/**
 * load -> clean -> chunk -> embed -> store. Everything expensive happens here,
 * once, so that asking a question later is only a search.
 *
 * Returns null when there was nothing to do (already added, or no text found).
 */
export async function ingestFile(
  notebook: string,
  filePath: string,
  options: IngestOptions = {},
): Promise<Document | null> {
  try {
    await access(filePath);
  } catch {
    throw new Error(`no such file: ${filePath}`);
  }

  const store = options.store ?? new NotebookStore();
  const name = basename(filePath);
  const documentId = await documentIdForFile(filePath);

  // the id is a hash of the file's bytes, so the same file is never indexed twice
  if (store.hasDocument(notebook, documentId)) {
    console.log(`already added: ${name} (id ${documentId}) - nothing to do`);
    return null;
  }

  console.log(`loading ${name} ...`);
  const pages = cleanPages(await loadDocument(filePath));
  console.log(`  ${pages.length} page(s) after cleaning`);

  const { parents, children, strategy } = buildParentChild(pages, documentId);
  console.log(`  chunked by ${strategy}`);
  console.log(`  ${parents.length} parent chunk(s), ${children.length} child chunk(s)`);
  if (children.length === 0) {
    console.log("  ! nothing to index - the document produced no text");
    return null;
  }

  const document: Document = {
    documentId,
    title: basename(filePath, extname(filePath)),
    filename: name,
    sourceType: extname(filePath).replace(".", "").toLowerCase(),
    pageCount: pages.length,
    addedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
  };
  store.addDocument(notebook, document);
  store.addChunks([...parents, ...children]);

  // only children are embedded: they are what gets searched
  console.log("  embedding children (the first run downloads the model) ...");
  const embedder = options.embedder ?? (await getEmbedder());
  const vectors = await embedder.embedDocuments(children.map((child) => child.text));

  (options.vectorStore ?? new VectorStore()).add(notebook, children, vectors);
  console.log(`added ${document.filename} -> ${notebook} (id ${documentId})`);
  return document;
}
