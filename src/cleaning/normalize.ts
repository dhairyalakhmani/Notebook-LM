import type { DocumentPage, TextLine } from "../models.ts";

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const SPACES = /[ \t\u00a0]+/g;
const ENDS_HYPHENATED = /[A-Za-z]-$/;
const STARTS_LOWER = /^[a-z]/;

/** Typographic characters that an embedder and a keyword index both do better without. */
const REPLACEMENTS: Record<string, string> = {
  "‘": "'", "’": "'", // curly single quotes
  "“": '"', "”": '"', // curly double quotes
  "–": "-", "—": "-", // en dash, em dash
  "•": "-",                // bullet
};
const FANCY = /[‘’“”–—•]/g;

export function normalizeLine(text: string): string {
  return text
    .normalize("NFKC")
    .replace(FANCY, (char) => REPLACEMENTS[char] ?? char)
    .replace(CONTROL, "")
    .replace(SPACES, " ")
    .trim();
}

/** "inter-" / "national" on two lines is one word. Put it back together. */
function mergeHyphenated(lines: TextLine[]): TextLine[] {
  const merged: TextLine[] = [];
  for (const line of lines) {
    const previous = merged.at(-1);
    if (previous && ENDS_HYPHENATED.test(previous.text) && STARTS_LOWER.test(line.text)) {
      const space = line.text.indexOf(" ");
      const head = space === -1 ? line.text : line.text.slice(0, space);
      const tail = space === -1 ? "" : line.text.slice(space + 1);
      merged[merged.length - 1] = { ...previous, text: previous.text.slice(0, -1) + head };
      if (tail) merged.push({ ...line, text: tail });
      continue;
    }
    merged.push(line);
  }
  return merged;
}

export function normalizePages(pages: DocumentPage[]): DocumentPage[] {
  return pages.map((page) => {
    const normalized = page.lines
      .map((line) => ({ ...line, text: normalizeLine(line.text) }))
      .filter((line) => line.text);
    const lines = mergeHyphenated(normalized);
    return {
      text: lines.map((line) => line.text).join("\n"),
      pageNumber: page.pageNumber,
      source: page.source,
      lines,
    };
  });
}
