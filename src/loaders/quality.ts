import * as config from "../config.ts";
import type { DocumentPage } from "../models.ts";

const REPLACEMENT = /�/g;
const SHORT_WORD = /(^|\s)\S(?=\s|$)/g;

export interface PageQuality {
  pageNumber: number;
  characters: number;
  textPoor: boolean;
}

export interface ExtractionQuality {
  pages: PageQuality[];
  poorPages: number[];
  needsOcr: boolean;
  garbled: boolean;
  reasons: string[];
}

export function assessExtraction(pages: DocumentPage[]): ExtractionQuality {
  const assessed: PageQuality[] = pages.map((page) => {
    const characters = page.lines.reduce((total, line) => total + line.text.length, 0);
    return {
      pageNumber: page.pageNumber,
      characters,
      textPoor: characters < config.MIN_CHARS_PER_PAGE,
    };
  });

  const poorPages = assessed.filter((page) => page.textPoor).map((page) => page.pageNumber);
  const allText = pages.flatMap((page) => page.lines.map((line) => line.text)).join(" ");

  const replacements = (allText.match(REPLACEMENT) ?? []).length;
  const shortWords = (allText.match(SHORT_WORD) ?? []).length;
  const words = allText.split(/\s+/).filter(Boolean).length;

  const garbled =
    allText.length > 0 &&
    (replacements / allText.length > config.MAX_REPLACEMENT_RATIO ||
      (words > 20 && shortWords / words > config.MAX_SHORT_WORD_RATIO));

  const reasons: string[] = [];
  const needsOcr = pages.length > 0 && poorPages.length / pages.length >= config.OCR_PAGE_RATIO;

  if (needsOcr) {
    reasons.push(
      `${poorPages.length} of ${pages.length} page(s) yielded almost no text ` +
        `(page${poorPages.length === 1 ? "" : "s"} ${poorPages.join(", ")})`,
    );
  }
  if (garbled) {
    reasons.push("the text that was extracted does not look like language");
  }

  return { pages: assessed, poorPages, needsOcr, garbled, reasons };
}
