import { extname } from "node:path";
import { DocxDocumentLoader } from "./docxLoader.ts";
import { HTMLDocumentLoader } from "./htmlLoader.ts";
import { PDFDocumentLoader } from "./pdfLoader.ts";
import { TextDocumentLoader } from "./textLoader.ts";
import type { DocumentLoader } from "./base.ts";
import type { DocumentPage } from "../models.ts";

export { DocumentLoader } from "./base.ts";
export { htmlToLines } from "./html.ts";
export { assessExtraction } from "./quality.ts";
export type { ExtractionQuality, PageQuality } from "./quality.ts";
export { routeExtraction } from "./ocr.ts";
export type { OcrEngine, OcrResult } from "./ocr.ts";

const LOADERS: readonly DocumentLoader[] = [
  new PDFDocumentLoader(),
  new DocxDocumentLoader(),
  new HTMLDocumentLoader(),
  new TextDocumentLoader(),
];

/** Every extension the notebook can ingest, for help text and error messages. */
export function supportedExtensions(): string[] {
  return [...new Set(LOADERS.flatMap((loader) => loader.extensions))].sort();
}

export async function loadDocument(filePath: string): Promise<DocumentPage[]> {
  for (const loader of LOADERS) {
    if (loader.handles(filePath)) return loader.load(filePath);
  }
  throw new Error(
    `No loader for '${extname(filePath)}'. Supported: ${supportedExtensions().join(", ")}`,
  );
}
