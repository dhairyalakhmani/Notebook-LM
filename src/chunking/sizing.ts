import { TiktokenCounter } from "../tokenizer.ts";
import { splitSentences } from "./sentences.ts";
import type { BoundaryReason } from "../models.ts";
import type { TokenCounter } from "../tokenizer.ts";

export interface Piece {
  text: string;
  tokenCount: number;
  reason: BoundaryReason;
}

export interface SplitOptions {
  maxTokens: number;
  overlapTokens?: number;
  counter?: TokenCounter;
}

function pack(
  parts: string[],
  maxTokens: number,
  counter: TokenCounter,
  joiner: string,
): { text: string; oversized: boolean }[] {
  const pieces: { text: string; oversized: boolean }[] = [];
  let current: string[] = [];
  let total = 0;

  for (const part of parts) {
    const size = counter.count(part);
    if (size > maxTokens) {
      if (current.length > 0) {
        pieces.push({ text: current.join(joiner), oversized: false });
        current = [];
        total = 0;
      }
      pieces.push({ text: part, oversized: true });
      continue;
    }
    if (current.length > 0 && total + size > maxTokens) {
      pieces.push({ text: current.join(joiner), oversized: false });
      current = [];
      total = 0;
    }
    current.push(part);
    total += size;
  }
  if (current.length > 0) pieces.push({ text: current.join(joiner), oversized: false });
  return pieces;
}

function byTokens(text: string, maxTokens: number, counter: TokenCounter): string[] {
  const tokens = counter.encode(text);
  if (tokens.length <= maxTokens) return [text];
  const out: string[] = [];
  for (let start = 0; start < tokens.length; start += maxTokens) {
    out.push(counter.decode(tokens.slice(start, start + maxTokens)).trim());
  }
  return out.filter(Boolean);
}

export function splitToSize(parts: string[], options: SplitOptions): Piece[] {
  const counter = options.counter ?? new TiktokenCounter();
  const overlapTokens = options.overlapTokens ?? 0;

  const emit = (text: string, reason: BoundaryReason): Piece => ({
    text,
    tokenCount: counter.count(text),
    reason,
  });

  const whole = pack(parts, options.maxTokens, counter, "\n");
  if (whole.length === 1 && !whole[0]!.oversized) {
    return [emit(whole[0]!.text, "structural")];
  }

  const maxTokens = Math.max(overlapTokens + 1, options.maxTokens - overlapTokens);

  const out: Piece[] = [];

  // Rung 1: the parts themselves (blocks).
  for (const packed of pack(parts, maxTokens, counter, "\n")) {
    if (!packed.oversized) {
      out.push(emit(packed.text, "structural"));
      continue;
    }

    // Rung 2: paragraphs inside the oversized part.
    const paragraphs = packed.text.split(/\n{2,}/).filter((p) => p.trim());
    const byParagraph = paragraphs.length > 1 ? pack(paragraphs, maxTokens, counter, "\n\n") : null;
    if (byParagraph && byParagraph.every((p) => !p.oversized)) {
      for (const p of byParagraph) out.push(emit(p.text, "paragraph"));
      continue;
    }

    // Rung 3: sentences.
    const sentences = splitSentences(packed.text);
    if (sentences.length > 1) {
      const bySentence = pack(sentences, maxTokens, counter, " ");
      if (bySentence.every((p) => !p.oversized)) {
        for (const p of bySentence) out.push(emit(p.text, "sentence"));
        continue;
      }
      // Rung 4: clauses within the sentences that are still too big.
      for (const p of bySentence) {
        if (!p.oversized) {
          out.push(emit(p.text, "sentence"));
          continue;
        }
        const clauses = p.text.split(/(?<=[;:])\s+/).filter(Boolean);
        const byClause = clauses.length > 1 ? pack(clauses, maxTokens, counter, " ") : null;
        if (byClause && byClause.every((c) => !c.oversized)) {
          for (const c of byClause) out.push(emit(c.text, "sentence"));
          continue;
        }
        // Rung 5: give up and count tokens.
        for (const t of byTokens(p.text, maxTokens, counter)) out.push(emit(t, "token"));
      }
      continue;
    }

    // One unbroken sentence larger than the budget - a table row, a long URL.
    for (const t of byTokens(packed.text, maxTokens, counter)) out.push(emit(t, "token"));
  }

  return withOverlap(out, overlapTokens, counter);
}

function withOverlap(pieces: Piece[], overlapTokens: number, counter: TokenCounter): Piece[] {
  if (overlapTokens <= 0 || pieces.length < 2) return pieces;
  return pieces.map((piece, index) => {
    if (index === 0) return piece;
    const previous = pieces[index - 1]!;
    const tail = counter.encode(previous.text).slice(-overlapTokens);
    if (tail.length === 0) return piece;
    const text = `${counter.decode(tail).trim()} ${piece.text}`;
    return { text, tokenCount: counter.count(text), reason: piece.reason };
  });
}
