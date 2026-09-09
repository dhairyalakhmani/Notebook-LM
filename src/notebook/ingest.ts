import { access, copyFile, mkdir } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
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
import { consoleReporter } from "./ingestReporter.ts";
import type { Document, IngestStage, IngestStats } from "../models.ts";
import type { IngestReporter } from "./ingestReporter.ts";
import type { Embedder } from "../embedding/index.ts";
import type { Segmenter } from "../chunking/segmentation/base.ts";
import type { CompletionModel } from "../chunking/segmentation/llm.ts";
import type { OcrEngine } from "../loaders/ocr.ts";

export interface IngestOptions {
  store?: NotebookStore;
  vectorStore?: VectorStore;
  embedder?: Embedder;
  segmenters?: Segmenter[];
  completionModel?: CompletionModel;
  ocrEngine?: OcrEngine;
  reporter?: IngestReporter;
  displayName?: string;
}

export type IngestOutcome =
  | { kind: "added"; document: Document; stats: IngestStats }
  | { kind: "already-added"; document: Document }
  | { kind: "needs-ocr"; reasons: string[] }
  | { kind: "no-text" };

export async function ingestFile(
  notebook: string,
  filePath: string,
  options: IngestOptions = {},
): Promise<IngestOutcome> {
  try {
    await access(filePath);
  } catch {
    throw new Error(`no such file: ${filePath}`);
  }

  const store = options.store ?? new NotebookStore();
  const reporter = options.reporter ?? consoleReporter();
  const name = options.displayName ?? basename(filePath);
  const documentId = await documentIdForFile(filePath);

  // the id is a hash of the file's bytes, so the same file is never indexed twice
  if (store.hasDocument(notebook, documentId)) {
    console.log(`already added: ${name} (id ${documentId}) - nothing to do`);
    const existing = store.getDocument(documentId);
    return {
      kind: "already-added",
      document: existing ?? {
        documentId,
        title: name.replace(/\.[^.]+$/, ""),
        filename: name,
        sourceType: extname(filePath).replace(".", "").toLowerCase(),
        pageCount: 0,
        addedAt: new Date().toISOString(),
      },
    };
  }

  const timings: { stage: IngestStage; ms: number }[] = [];
  const clock = async <T>(stage: IngestStage, work: () => Promise<T> | T): Promise<T> => {
    reporter.stage(stage, "start");
    const started = performance.now();
    const value = await work();
    const ms = performance.now() - started;
    timings.push({ stage, ms });
    reporter.stage(stage, "done", ms);
    return value;
  };

  console.log(`loading ${name} ...`);
  const loaded = await clock("extract", () => loadDocument(filePath));

  const routed = await clock("quality", () => routeExtraction(filePath, loaded, options.ocrEngine));
  if (routed.recognised.length > 0) {
    reporter.log("info", `recognised ${routed.recognised.length} page(s) with OCR`);
  }
  if (routed.unmet) {
    reporter.log("warn", `poor extraction: ${routed.quality.reasons.join("; ")}`);
    reporter.log(
      "warn",
      "this file needs OCR. Pass an ocrEngine to ingest it, or supply a " +
        "text-layer version of the document.",
    );
    return { kind: "needs-ocr", reasons: routed.quality.reasons };
  }
  if (routed.quality.garbled) {
    reporter.log("warn", "warning: extracted text does not look like language");
  }

  const pages = await clock("clean", () => cleanPages(routed.pages));
  reporter.log("info", `${pages.length} page(s) after cleaning`);

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
  reporter.log(
    "info",
    `${report.blockCount} block(s), structure score ${report.structureScore.toFixed(2)}` +
      ` [${report.segmenters.join(" + ")}]`,
  );
  reporter.log(
    "info",
    `${report.unitCount} semantic unit(s) -> ` +
      `${parents.length} parent(s), ${children.length} child(ren)`,
  );
  if (report.tokenSplitChunks > 0) {
    // Meaning was lost here, not just size enforced. Worth surfacing.
    reporter.log(
      "warn",
      `${report.tokenSplitChunks} chunk(s) needed a token-count split - ` +
        `extraction quality may be poor for this file`,
    );
  }
  if (children.length === 0) {
    reporter.log("warn", "nothing to index - the document produced no text");
    return { kind: "no-text" };
  }

  const embedder = options.embedder ?? (await getEmbedder());

  const budgetProblem = checkBudget(embedder);
  if (budgetProblem) throw new Error(budgetProblem);

  const oversized = findOversized(children, embedder);
  if (oversized.length > 0) {
    reporter.log(
      "warn",
      `${oversized.length} chunk(s) may exceed ${embedder.modelId}'s ` +
        `${embedder.maxInputTokens}-token input limit and lose their ending ` +
        `(largest ~${Math.max(...oversized.map((c) => c.estimated))} tokens)`,
    );
  }

  reporter.log("info", `embedding ${children.length} child chunk(s) with ${embedder.modelId} ...`);
  const started = performance.now();
  const vectors = await clock("embed", () =>
    embedder.embedDocuments(children.map((child) => child.text)),
  );
  const elapsed = performance.now() - started;
  reporter.log(
    "info",
    `embedded in ${(elapsed / 1000).toFixed(1)}s ` +
      `(${(elapsed / children.length).toFixed(0)}ms per chunk)`,
  );

  if (vectors.length !== children.length) {
    throw new Error(`embedder returned ${vectors.length} vectors for ${children.length} chunks`);
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
    title: name.replace(/\.[^.]+$/, ""),
    filename: name,
    sourceType: extname(filePath).replace(".", "").toLowerCase(),
    pageCount: pages.length,
    addedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
  };

  const vectorStore = options.vectorStore ?? new VectorStore();
  const storeStarted = performance.now();

  const sourcePath = await keepSource(filePath, documentId);
  const byteSize = await fileSize(filePath);

  const stats: IngestStats = {
    blocks: report.blockCount,
    units: report.unitCount,
    sections: parents.length,
    passages: children.length,
    structureScore: report.structureScore,
    tokenSplitChunks: report.tokenSplitChunks,
    segmenters: report.segmenters,
    stages: timings,
    embedModel: embedder.modelId,
  };

  store.addDocument(notebook, document, { sourcePath, byteSize });
  try {
    store.addChunks([...parents, ...children]);
    vectorStore.add(notebook, children, vectors, embedder.modelId);
  } catch (error) {
    store.deleteDocument(notebook, documentId);
    vectorStore.deleteDocument(documentId, notebook);
    throw error;
  }

  timings.push({ stage: "store", ms: performance.now() - storeStarted });

  store.setIngestStats(notebook, documentId, stats);

  console.log(`added ${document.filename} -> ${notebook} (id ${documentId})`);
  reporter.finished(document, stats);
  return { kind: "added", document, stats };
}

async function keepSource(filePath: string, documentId: string): Promise<string | null> {
  try {
    const extension = extname(filePath).toLowerCase();
    const target = join(config.SOURCES_DIR, `${documentId}${extension}`);
    if (resolve(filePath) !== resolve(target)) {
      await mkdir(config.SOURCES_DIR, { recursive: true });
      await copyFile(filePath, target);
    }
    return relative(config.STORAGE_DIR, target).split("\\").join("/");
  } catch (error) {
    console.log(
      `  ! could not keep a copy of the source: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return null;
  }
}
