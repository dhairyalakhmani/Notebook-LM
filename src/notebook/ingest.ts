import { access } from "node:fs/promises";
import { basename, extname } from "node:path";
import { chunkDocument } from "../chunking/pipeline.ts";
import { LLMSegmenter } from "../chunking/segmentation/llm.ts";
import { cleanPages } from "../cleaning/index.ts";
import * as config from "../config.ts";
import { getEmbedder } from "../embedding/index.ts";
import { checkBudget, findOversized } from "../embedding/limits.ts";
import { loadDocument, routeExtraction } from "../loaders/index.ts";
import { documentIdForFile } from "../models.ts";
import { NotebookStore } from "./store.ts";
import { VectorStore } from "../search/vectorStore.ts";
import type { Document } from "../models.ts";
import type { Embedder } from "../embedding/index.ts";
import type { Segmenter } from "../chunking/segmentation/base.ts";
import type { CompletionModel } from "../chunking/segmentation/llm.ts";
import type { OcrEngine } from "../loaders/ocr.ts";

export interface IngestOptions {
  store?: NotebookStore;
  vectorStore?: VectorStore;
  embedder?: Embedder;
  /** Overrides the default segmenter set entirely. Mostly for tests. */
  segmenters?: Segmenter[];
  /** Any provider that can turn a prompt into text. Only used when
   *  USE_LLM_SEGMENTATION is on. */
  completionModel?: CompletionModel;
  /** Stronger extraction for documents with no usable text layer. None ships by
   *  default - see loaders/ocr.ts. */
  ocrEngine?: OcrEngine;
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

  // Stage timings, because "ingest took four minutes" is not actionable and
  // "extraction took four minutes, embedding took fifty seconds" is.
  const timings: [string, number][] = [];
  const clock = async <T,>(stage: string, work: () => Promise<T> | T): Promise<T> => {
    const started = performance.now();
    const value = await work();
    timings.push([stage, performance.now() - started]);
    return value;
  };

  console.log(`loading ${name} ...`);
  const loaded = await clock("extract", () => loadDocument(filePath));

  // Extraction quality is judged before chunking, so a scanned document is
  // reported as an extraction problem rather than silently ingested as empty.
  const routed = await clock("quality check", () =>
    routeExtraction(filePath, loaded, options.ocrEngine),
  );
  if (routed.recognised.length > 0) {
    console.log(`  recognised ${routed.recognised.length} page(s) with OCR`);
  }
  if (routed.unmet) {
    console.log(`  ! poor extraction: ${routed.quality.reasons.join("; ")}`);
    console.log(
      "  ! this file needs OCR. Pass an ocrEngine to ingest it, or supply a " +
        "text-layer version of the document.",
    );
    return null;
  }
  if (routed.quality.garbled) {
    console.log("  ! warning: extracted text does not look like language");
  }

  const pages = await clock("clean", () => cleanPages(routed.pages));
  console.log(`  ${pages.length} page(s) after cleaning`);

  // The LLM segmenter is advisory and off by default, so ingest stays offline
  // unless it is explicitly turned on.
  const segmenters =
    options.segmenters ??
    (config.USE_LLM_SEGMENTATION && options.completionModel
      ? [
          new LLMSegmenter({
            model: options.completionModel,
            onFallback: () => console.log("  ! segmenter call failed - using structure only"),
          }),
        ]
      : []);

  const { parents, children, report } = await clock("chunk", () =>
    chunkDocument(pages, documentId, { segmenters }),
  );
  console.log(
    `  ${report.blockCount} block(s), structure score ${report.structureScore.toFixed(2)}` +
      ` [${report.segmenters.join(" + ")}]`,
  );
  console.log(
    `  ${report.unitCount} semantic unit(s) -> ` +
      `${parents.length} parent(s), ${children.length} child(ren)`,
  );
  if (report.tokenSplitChunks > 0) {
    // Meaning was lost here, not just size enforced. Worth surfacing.
    console.log(
      `  ! ${report.tokenSplitChunks} chunk(s) needed a token-count split - ` +
        `extraction quality may be poor for this file`,
    );
  }
  if (children.length === 0) {
    console.log("  ! nothing to index - the document produced no text");
    return null;
  }

  // Embed before storing anything. This is the step that can genuinely fail - the
  // model download dies, a huge PDF exhausts memory - and if the document row were
  // already written, the `hasDocument` check above would report "already added" on
  // every retry, leaving a source that can never be searched.
  //
  // Only children are embedded: they are what gets searched.
  const embedder = options.embedder ?? (await getEmbedder());

  // A budget too large for the model would truncate every big chunk, silently.
  // That is a configuration error, so it stops the ingest rather than producing
  // a store full of vectors missing their endings.
  const budgetProblem = checkBudget(embedder);
  if (budgetProblem) throw new Error(budgetProblem);

  const oversized = findOversized(children, embedder);
  if (oversized.length > 0) {
    console.log(
      `  ! ${oversized.length} chunk(s) may exceed ${embedder.modelId}'s ` +
        `${embedder.maxInputTokens}-token input limit and lose their ending ` +
        `(largest ~${Math.max(...oversized.map((c) => c.estimated))} tokens)`,
    );
  }

  console.log(
    `  embedding ${children.length} child chunk(s) with ${embedder.modelId} ...`,
  );
  const started = performance.now();
  const vectors = await clock("embed", () =>
    embedder.embedDocuments(children.map((child) => child.text)),
  );
  const elapsed = performance.now() - started;
  console.log(
    `  embedded in ${(elapsed / 1000).toFixed(1)}s ` +
      `(${(elapsed / children.length).toFixed(0)}ms per chunk)`,
  );

  if (vectors.length !== children.length) {
    throw new Error(
      `embedder returned ${vectors.length} vectors for ${children.length} chunks`,
    );
  }
  const wrongSize = vectors.findIndex((vector) => vector.length !== embedder.dimensions);
  if (wrongSize !== -1) {
    throw new Error(
      `vector ${wrongSize} has ${vectors[wrongSize]!.length} dimensions, ` +
        `expected ${embedder.dimensions}`,
    );
  }

  const document: Document = {
    documentId,
    title: basename(filePath, extname(filePath)),
    filename: name,
    sourceType: extname(filePath).replace(".", "").toLowerCase(),
    pageCount: pages.length,
    addedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
  };

  // The text and the vectors are two separate SQLite files, so no one transaction
  // covers both. If the later writes fail, undo the earlier ones by hand rather
  // than leaving half a document behind.
  const vectorStore = options.vectorStore ?? new VectorStore();
  const storeStarted = performance.now();
  store.addDocument(notebook, document);
  try {
    store.addChunks([...parents, ...children]);
    vectorStore.add(notebook, children, vectors, embedder.modelId);
  } catch (error) {
    store.deleteDocument(notebook, documentId);
    vectorStore.deleteDocument(documentId, notebook);
    throw error;
  }

  timings.push(["store", performance.now() - storeStarted]);
  const totalMs = timings.reduce((sum, [, ms]) => sum + ms, 0);
  console.log(`added ${document.filename} -> ${notebook} (id ${documentId})`);
  console.log(`  ingest took ${(totalMs / 1000).toFixed(1)}s:`);
  for (const [stage, ms] of timings) {
    console.log(
      `    ${stage.padEnd(14)} ${(ms / 1000).toFixed(1).padStart(6)}s  ` +
        `${((100 * ms) / totalMs).toFixed(0).padStart(3)}%`,
    );
  }
  return document;
}
