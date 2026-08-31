/**
 * Sentence segmentation, used as a split point of last resort before falling
 * back to counting tokens.
 *
 * `Intl.Segmenter` ships with Node and needs no dependency, but ICU breaks on
 * abbreviations - it splits "Dr. Smith" and "see Sec. 4" - so its output is
 * post-processed by rejoining pieces that ended on a known abbreviation. That
 * is cheaper and far more predictable than adding an NLP package.
 */

const ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st",
  "fig", "figs", "sec", "secs", "no", "nos", "vol", "ch", "chap", "eq", "ref",
  "e.g", "i.e", "cf", "vs", "etc", "al", "approx", "est", "inc", "ltd", "co",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

/** The token right before a trailing period, lowercased and without the dot. */
function trailingWord(text: string): string {
  const match = /([A-Za-z.]+)\.\s*$/.exec(text.trimEnd());
  return (match?.[1] ?? "").toLowerCase().replace(/\.$/, "");
}

/** A piece ending "Sec." or "4." is mid-sentence and must absorb the next piece. */
function isOpen(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(".")) return false;
  const word = trailingWord(trimmed);
  if (ABBREVIATIONS.has(word)) return true;
  // "4." / "iv." - a numbered fragment, not the end of a sentence
  if (/^\d+$/.test(word)) return true;
  // A single capital is an initial: "J. R. R. Tolkien"
  return /^[A-Za-z]$/.test(word);
}

export function splitSentences(text: string): string[] {
  const raw = [...segmenter.segment(text)].map((piece) => piece.segment);
  const sentences: string[] = [];
  for (const piece of raw) {
    const previous = sentences.at(-1);
    if (previous !== undefined && isOpen(previous)) {
      sentences[sentences.length - 1] = previous + piece;
      continue;
    }
    sentences.push(piece);
  }
  return sentences.map((s) => s.trim()).filter(Boolean);
}
