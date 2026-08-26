import { extname } from "node:path";
import { PDFDocumentLoader } from "./pdfLoader.ts";
import { TextDocumentLoader } from "./textLoader.ts";
import type { DocumentLoader } from "./base.ts";
import type { DocumentPage } from "../models.ts";

export { DocumentLoader } from "./base.ts";

const LOADERS: readonly DocumentLoader[] = [
  new PDFDocumentLoader(),
  new TextDocumentLoader(),
];

export async function loadDocument(filePath: string): Promise<DocumentPage[]> {
  for (const loader of LOADERS) {
    if (loader.handles(filePath)) return loader.load(filePath);
  }
  const supported = [...new Set(LOADERS.flatMap((l) => l.extensions))].sort();
  throw new Error(
    `No loader for '${extname(filePath)}'. Supported: ${supported.join(", ")}`,
  );
}
