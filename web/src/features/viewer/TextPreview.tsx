import { useEffect, useState } from "react";
import { compact } from "./highlight.ts";
import { requestText } from "../../shared/lib/http.ts";
import { messages } from "../../shared/messages.ts";
import { StateCard } from "../../shared/ui/StateCard.tsx";
import styles from "./PdfPage.module.css";
import type { SourceDto } from "../../types.ts";

type Loaded =
  | { url: string | null; status: "loading" }
  | { url: string | null; status: "ready"; text: string }
  | { url: string | null; status: "failed" };

export function TextPreview({
  source,
  phrases,
}: {
  source: SourceDto;
  phrases: readonly string[];
}) {
  const url = source.fileUrl;
  const [loaded, setLoaded] = useState<Loaded>({ url, status: "loading" });
  if (loaded.url !== url) setLoaded({ url, status: "loading" });

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    void (async () => {
      try {
        const body = await requestText(url);
        if (!cancelled) setLoaded({ url, status: "ready", text: body });
      } catch {
        if (!cancelled) setLoaded({ url, status: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  const state: Loaded = loaded.url === url ? loaded : { url, status: "loading" };
  const failed = state.status === "failed";
  const text = state.status === "ready" ? state.text : null;

  if (failed) return <StateCard message={messages.sourceUnavailable} tone="warn" />;
  if (text === null) return <StateCard message={messages.viewerLoading} />;

  return (
    <article className={styles.textDocument}>
      {splitAroundPhrases(text, phrases).map((part, index) =>
        part.marked ? (
          <mark key={index} className={styles.hit}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </article>
  );
}

function splitAroundPhrases(
  text: string,
  phrases: readonly string[],
): { text: string; marked: boolean }[] {
  const usable = phrases.filter((phrase) => compact(phrase).length >= 12);
  if (usable.length === 0) return [{ text, marked: false }];

  // Map every position in the compacted string back to the original.
  let compacted = "";
  const origin: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = compact(text[index]!);
    if (character) {
      compacted += character;
      origin.push(index);
    }
  }

  const ranges: [number, number][] = [];
  for (const phrase of usable) {
    const needle = compact(phrase);
    const at = compacted.indexOf(needle);
    if (at === -1) continue;
    const start = origin[at];
    const end = origin[at + needle.length - 1];
    if (start !== undefined && end !== undefined) ranges.push([start, end + 1]);
  }
  if (ranges.length === 0) return [{ text, marked: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const parts: { text: string; marked: boolean }[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue; // overlapping match, already covered
    if (start > at) parts.push({ text: text.slice(at, start), marked: false });
    parts.push({ text: text.slice(start, end), marked: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), marked: false });
  return parts;
}
