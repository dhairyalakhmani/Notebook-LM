import { assessExtraction } from "./quality.ts";
import type { ExtractionQuality } from "./quality.ts";
import type { DocumentPage, TextLine } from "../models.ts";

export interface OcrEngine {
  readonly name: string;
  recognise(filePath: string, pageNumbers: number[]): Promise<Map<number, TextLine[]>>;
}

export interface OcrResult {
  pages: DocumentPage[];
  quality: ExtractionQuality;
  recognised: number[];
  unmet: boolean;
}

export async function routeExtraction(
  filePath: string,
  pages: DocumentPage[],
  engine?: OcrEngine,
): Promise<OcrResult> {
  const quality = assessExtraction(pages);

  if (!quality.needsOcr) {
    return { pages, quality, recognised: [], unmet: false };
  }
  if (!engine) {
    return { pages, quality, recognised: [], unmet: true };
  }

  const recognisedLines = await engine.recognise(filePath, quality.poorPages);
  const recognised: number[] = [];

  const merged = pages.map((page) => {
    const lines = recognisedLines.get(page.pageNumber);
    if (!lines || lines.length === 0) return page;
    recognised.push(page.pageNumber);
    return {
      ...page,
      text: lines.map((line) => line.text).join("\n"),
      lines,
    };
  });

  const after = assessExtraction(merged);
  return { pages: merged, quality: after, recognised, unmet: after.needsOcr };
}
