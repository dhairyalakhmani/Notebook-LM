import { splitSentences } from "../chunking/sentences.ts";
import { tokenize } from "../search/keywordIndex.ts";
import { MIN_QUOTE_CHARS } from "../api/dto.ts";
import { normalizeMarkers } from "./answer.ts";
import type { Chunk } from "../models.ts";
import type { Passage } from "../retrieval/retriever.ts";

export interface QuoteChoice {
  quote: string;
  page: number | null;
  score: number;
}

function compact(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function looksWhole(sentence: string): boolean {
  const text = sentence.trim();
  if (text.length === 0) return false;
  const opensCleanly = /^["'([]?[A-Z0-9]/.test(text);
  const closesCleanly = /[.!?]["')\]]?$/.test(text);
  return opensCleanly && closesCleanly;
}

function claimFor(answerText: string, marker: number): string {
  const normalised = normalizeMarkers(answerText);
  const carrying = splitSentences(normalised).filter((sentence) =>
    sentence.includes(`[${marker}]`),
  );
  const text = carrying.length > 0 ? carrying.join(" ") : normalised;
  return text.replace(/\[\d+\]/g, " ");
}

function bodyOf(chunk: Chunk): string {
  const heading = chunk.sectionTitle;
  if (!heading) return chunk.text;
  const [first, ...rest] = chunk.text.split("\n");
  return first?.trim() === heading.trim() ? rest.join("\n") : chunk.text;
}

function documentFrequency(candidates: string[][]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const tokens of candidates) {
    for (const token of new Set(tokens)) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  return frequency;
}

function idfFrom(frequency: Map<string, number>, total: number): Map<string, number> {
  const idf = new Map<string, number>();
  for (const [token, count] of frequency) idf.set(token, Math.log(1 + total / count));
  return idf;
}

const MIN_EVIDENCE_CHARS = 4;

function hasEvidence(
  tokens: Iterable<string>,
  claimTokens: Set<string>,
  frequency: Map<string, number>,
  total: number,
): boolean {
  const selective = Math.max(1, Math.floor(total / 2));
  for (const token of tokens) {
    if (!claimTokens.has(token)) continue;
    if (token.length < MIN_EVIDENCE_CHARS) continue;
    if ((frequency.get(token) ?? total) > selective) continue;
    return true;
  }
  return false;
}

export function chooseQuote(
  answerText: string,
  marker: number,
  passage: Passage,
  child: Chunk | null,
): QuoteChoice | null {
  const haystack = child ? bodyOf(child) : passage.text;
  const sentences = splitSentences(haystack).filter(
    (sentence) => compact(sentence).length >= MIN_QUOTE_CHARS,
  );
  if (sentences.length === 0) return null;

  const claimTokens = new Set(tokenize(claimFor(answerText, marker)));
  if (claimTokens.size === 0) return null;

  const candidates = sentences.map((sentence) => tokenize(sentence));
  const frequency = documentFrequency(candidates);
  const idf = idfFrom(frequency, candidates.length);
  const page = child?.pageStart ?? passage.pageStart;

  const scoreOf = (index: number): number | null => {
    const tokens = candidates[index]!;
    if (tokens.length === 0) return null;
    const distinct = new Set(tokens);

    if (!hasEvidence(distinct, claimTokens, frequency, candidates.length)) return null;

    let overlap = 0;
    for (const token of distinct) {
      if (claimTokens.has(token)) overlap += idf.get(token) ?? 0;
    }
    const score = overlap / Math.sqrt(tokens.length);
    return score > 0 ? score : null;
  };

  const bestOf = (indices: number[]): QuoteChoice | null => {
    let best: QuoteChoice | null = null;
    for (const index of indices) {
      const score = scoreOf(index);
      if (score === null) continue;
      if (!best || score > best.score) {
        best = { quote: sentences[index]!.trim(), page, score };
      }
    }
    return best;
  };

  const all = sentences.map((_, index) => index);
  const whole = all.filter((index) => looksWhole(sentences[index]!));

  return bestOf(whole) ?? bestOf(all.filter((index) => !whole.includes(index)));
}
