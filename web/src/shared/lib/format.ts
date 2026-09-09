export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 100 ? 1 : 0)} ${units[unit]}`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export type AnswerPart = { kind: "text"; text: string } | { kind: "marker"; marker: number };

export function parseMarkers(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let at = 0;
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    const index = match.index;
    if (index > at) parts.push({ kind: "text", text: text.slice(at, index) });
    parts.push({ kind: "marker", marker: Number(match[1]) });
    at = index + match[0].length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
}

export function clampDepth(depth: number, max = 4): number {
  return Math.min(Math.max(1, depth), max);
}
