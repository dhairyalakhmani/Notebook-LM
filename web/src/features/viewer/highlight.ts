import { MIN_QUOTE_CHARS } from "../../types.ts";

export interface TextItemLike {
  str?: string;
}

export function compact(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MIN_PHRASE = MIN_QUOTE_CHARS;

const PREFIX_SHARE = 0.55;

export function findPhraseItems(
  items: readonly TextItemLike[],
  phrase: string | null,
): Set<number> {
  const hits = new Set<number>();
  if (!phrase) return hits;

  let haystack = "";
  const owner: number[] = [];
  items.forEach((item, index) => {
    for (const ch of compact(item.str ?? "")) {
      haystack += ch;
      owner.push(index);
    }
  });

  const needle = compact(phrase);
  if (needle.length < MIN_PHRASE) return hits;

  let at = haystack.indexOf(needle);
  let length = needle.length;

  if (at === -1) {
    length = Math.max(14, Math.floor(needle.length * PREFIX_SHARE));
    at = haystack.indexOf(needle.slice(0, length));
    if (at === -1) return hits;
  }

  for (const index of owner.slice(at, at + length)) hits.add(index);
  return hits;
}

export function findAnyPhrase(
  items: readonly TextItemLike[],
  phrases: readonly (string | null)[],
): Set<number> {
  const hits = new Set<number>();
  for (const phrase of phrases) {
    for (const index of findPhraseItems(items, phrase ?? null)) hits.add(index);
  }
  return hits;
}
