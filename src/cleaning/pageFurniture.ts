import type { DocumentPage } from "../models.ts";

const EDGE_LINES = 2; // only the top/bottom lines can be furniture
const REPEAT_RATIO = 0.6; // on 60%+ of pages -> it is a header/footer
const MIN_PAGES_TO_JUDGE = 3; // with 1-2 pages, repetition proves nothing

const DIGITS = /\d+/g;
const PAGE_NUMBER = /^(page\s*)?[ivxlcdm\d]+(\s*(\/|of|-)\s*\d+)?$/i;

function fingerprint(text: string): string {
  return text.toLowerCase().replace(DIGITS, "#").trim();
}

export function findFurniture(pages: DocumentPage[]): Set<string> {
  if (pages.length < MIN_PAGES_TO_JUDGE) return new Set();

  const counts = new Map<string, number>();
  for (const page of pages) {
    const edge = [...page.lines.slice(0, EDGE_LINES), ...page.lines.slice(-EDGE_LINES)];
    for (const print of new Set(edge.map((line) => fingerprint(line.text)))) {
      counts.set(print, (counts.get(print) ?? 0) + 1);
    }
  }

  const threshold = pages.length * REPEAT_RATIO;
  return new Set(
    [...counts].filter(([print, n]) => print && n >= threshold).map(([print]) => print),
  );
}

export function stripFurniture(pages: DocumentPage[]): DocumentPage[] {
  const furniture = findFurniture(pages);
  const judgeable = pages.length >= MIN_PAGES_TO_JUDGE;

  return pages.map((page) => {
    const last = page.lines.length - 1;
    const kept = page.lines.filter((line, index) => {
      if (furniture.has(fingerprint(line.text))) return false;
      const atEdge = index < EDGE_LINES || index > last - EDGE_LINES;
      if (atEdge && judgeable && PAGE_NUMBER.test(line.text.trim())) return false;
      return true;
    });
    return {
      text: kept.map((line) => line.text).join("\n"),
      pageNumber: page.pageNumber,
      source: page.source,
      lines: kept,
    };
  });
}
