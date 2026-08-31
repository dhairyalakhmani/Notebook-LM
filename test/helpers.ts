import type { DocumentPage, TextLine } from "../src/models.ts";

/**
 * Builds pages that look like they came from a PDF, so tests exercise the same
 * geometry-driven path as real documents rather than a shortcut.
 */
export interface LineSpec {
  text: string;
  /** Vertical distance from the previous line. Defaults to a normal line gap. */
  gap?: number;
  fontSize?: number;
  isBold?: boolean;
  left?: number;
  page?: number;
}

const NORMAL_GAP = 12;
const BODY_SIZE = 10;

export function pdfPages(specs: LineSpec[], source = "test.pdf"): DocumentPage[] {
  const byPage = new Map<number, TextLine[]>();
  let top = 0;
  let currentPage = 1;

  for (const spec of specs) {
    const page = spec.page ?? currentPage;
    if (page !== currentPage) {
      currentPage = page;
      top = 0;
    }
    top += spec.gap ?? NORMAL_GAP;
    const line: TextLine = {
      text: spec.text,
      pageNumber: page,
      fontSize: spec.fontSize ?? BODY_SIZE,
      isBold: spec.isBold ?? false,
      top,
      left: spec.left ?? 50,
      right: (spec.left ?? 50) + spec.text.length * 5,
    };
    const list = byPage.get(page) ?? [];
    list.push(line);
    byPage.set(page, list);
  }

  return [...byPage].map(([pageNumber, lines]) => ({
    text: lines.map((l) => l.text).join("\n"),
    pageNumber,
    source,
    lines,
  }));
}

/** Plain text with no geometry at all - the "rough PDF" case. */
export function bareLines(texts: string[], source = "rough.pdf"): DocumentPage[] {
  const lines: TextLine[] = texts.map((text) => ({ text, pageNumber: 1 }));
  return [{ text: texts.join("\n"), pageNumber: 1, source, lines }];
}
