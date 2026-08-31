import { assessExtraction } from "./quality.ts";
import type { ExtractionQuality } from "./quality.ts";
import type { DocumentPage, TextLine } from "../models.ts";

/**
 * The routing seam for stronger extraction.
 *
 * A scanned PDF is not a chunking problem, it is an extraction problem: pdf.js
 * returns nothing because there is no text layer, only an image. Rather than let
 * that document ingest as empty, `assessExtraction` flags it and this module
 * hands the text-poor pages to an OCR engine.
 *
 * No engine ships by default, and that is deliberate:
 *
 *  - the whole pipeline is offline today, and every OCR option downloads
 *    language data at first use;
 *  - OCR costs seconds per page against milliseconds for the normal path;
 *  - it is only ever needed for documents this project may never see.
 *
 * So the interface is defined, the routing is written and tested, and the engine
 * is injected by the caller. Supplying one is a one-file change with no effect on
 * anything else.
 */

export interface OcrEngine {
  readonly name: string;
  /**
   * Recognises the given pages of a file and returns lines per page number.
   * Pages it cannot read should simply be absent from the map.
   */
  recognise(filePath: string, pageNumbers: number[]): Promise<Map<number, TextLine[]>>;
}

export interface OcrResult {
  pages: DocumentPage[];
  quality: ExtractionQuality;
  /** Pages an engine actually replaced. Empty when no engine was supplied. */
  recognised: number[];
  /** True when the document needed OCR and no engine was available to do it. */
  unmet: boolean;
}

/**
 * Fills in text-poor pages using `engine`, if one is given and if the document
 * looks like it needs it.
 *
 * Pages that already extracted cleanly are never re-read: OCR is slower and
 * less accurate than a real text layer, so it is a fallback, not an upgrade.
 */
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

  // Re-assess: OCR may have fixed some pages and not others, and the caller
  // should be told what it actually ended up with rather than what was hoped for.
  const after = assessExtraction(merged);
  return { pages: merged, quality: after, recognised, unmet: after.needsOcr };
}
