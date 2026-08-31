import type { TextLine } from "../models.ts";
import * as config from "../config.ts";

/**
 * Deciding what is a heading.
 *
 * Formats that carry real structure (markdown, docx, html) say so outright via
 * `headingLevel`, and are believed without argument. PDFs say nothing, so the
 * intent has to be reconstructed from typography.
 *
 * Everything here returns *evidence*, not a verdict, because a single signal is
 * never enough: bold alone catches emphasised sentences, size alone misses
 * same-size bold headings, and both miss headings in documents typeset with one
 * font throughout.
 */

// A trailing colon is NOT a disqualifier: "Frequent Queries:" and "Note:" are
// among the most common heading shapes there are. Only the marks that end a
// running sentence count.
const SENTENCE_ENDINGS = [".", ",", ";"];
const BRACKET_PAIRS: readonly [string, string][] = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
];

/** "1.", "1.2", "A.", "IV." and friends - a numbered heading in almost any scheme. */
const NUMBERED = /^(\d+(\.\d+)*\.?|[A-Z]\.|[IVXLC]+\.)\s+\S/;
/** ALL CAPS, or Title Case With Most Words Capitalised. */
const ALL_CAPS = /^[^a-z]*[A-Z][^a-z]*$/;

export interface HeadingEvidence {
  isHeading: boolean;
  /** 1-6. Derived from font size rank for PDFs, given outright elsewhere. */
  level: number | null;
  /** How many independent signals agreed. Used to break ties, and to decide
   *  whether a document has trustworthy structure at all. */
  confidence: number;
}

/** The most-used non-bold font size, weighted by how much text is set in it. */
export function bodyFontSize(lines: TextLine[]): number | null {
  const weights = new Map<number, number>();
  for (const line of lines) {
    if (line.fontSize == null || line.isBold) continue;
    weights.set(line.fontSize, (weights.get(line.fontSize) ?? 0) + line.text.length);
  }
  if (weights.size === 0) return null;
  return [...weights].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** A line that hangs open - an unclosed quote or bracket - is a wrapped heading. */
export function isUnterminated(text: string): boolean {
  if (count(text, '"') % 2 === 1) return true;
  return BRACKET_PAIRS.some(([open, close]) => count(text, open) > count(text, close));
}

/**
 * Font sizes above body size, largest first. A line set in the Nth distinct
 * size above body text is a level-N heading, which is how a PDF's visual
 * hierarchy becomes a real outline.
 */
export function headingSizeLadder(lines: TextLine[], bodySize: number | null): number[] {
  if (bodySize == null) return [];
  const larger = new Set<number>();
  for (const line of lines) {
    if (line.fontSize != null && line.fontSize > bodySize * config.HEADING_SIZE_RATIO) {
      larger.add(line.fontSize);
    }
  }
  return [...larger].sort((a, b) => b - a);
}

export interface HeadingContext {
  bodySize: number | null;
  ladder: number[];
  /** Most common left margin. A heading is often outdented relative to body text. */
  bodyLeft: number | null;
}

export function headingContext(lines: TextLine[]): HeadingContext {
  const bodySize = bodyFontSize(lines);
  const lefts = new Map<number, number>();
  for (const line of lines) {
    if (line.left == null) continue;
    const bucket = Math.round(line.left);
    lefts.set(bucket, (lefts.get(bucket) ?? 0) + 1);
  }
  const bodyLeft =
    lefts.size > 0 ? [...lefts].reduce((a, b) => (b[1] > a[1] ? b : a))[0] : null;
  return { bodySize, ladder: headingSizeLadder(lines, bodySize), bodyLeft };
}

export function classifyHeading(line: TextLine, ctx: HeadingContext): HeadingEvidence {
  // Formats that know their own structure are authoritative.
  if (line.headingLevel != null) {
    return { isHeading: true, level: line.headingLevel, confidence: 1 };
  }

  const words = line.text.split(/\s+/).filter(Boolean);
  const no: HeadingEvidence = { isHeading: false, level: null, confidence: 0 };

  // Disqualifiers. A heading is a short label, not a sentence.
  if (words.length === 0 || words.length > config.MAX_HEADING_WORDS) return no;
  if (SENTENCE_ENDINGS.some((end) => line.text.endsWith(end))) {
    // "1. Introduction:" is still a heading; "...and so on." is not.
    if (!NUMBERED.test(line.text)) return no;
  }

  let confidence = 0;
  let level: number | null = null;

  if (line.isBold) confidence += 1;
  if (NUMBERED.test(line.text)) confidence += 1;
  if (ALL_CAPS.test(line.text) && words.length > 1) confidence += 1;

  if (ctx.bodySize != null && line.fontSize != null) {
    if (line.fontSize > ctx.bodySize * config.HEADING_SIZE_RATIO) {
      confidence += 2; // a larger font is the strongest single signal
      const rank = ctx.ladder.indexOf(line.fontSize);
      if (rank >= 0) level = Math.min(rank + 1, 6);
    }
  }

  // Outdented relative to body text: weak on its own, useful as a tiebreak.
  if (ctx.bodyLeft != null && line.left != null && line.left < ctx.bodyLeft - 1) {
    confidence += 1;
  }

  if (confidence < config.HEADING_MIN_CONFIDENCE) return no;
  // Bold-only headings sit below the size ladder, so they are the deepest level.
  return { isHeading: true, level: level ?? (ctx.ladder.length + 1 || 2), confidence };
}
