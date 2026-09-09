// @vitest-environment node
import { globSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TOKENS_DIR = resolve(import.meta.dirname, "..", "shared", "styles");
const CSS = readFileSync(join(TOKENS_DIR, "tokens.css"), "utf8");

function readBlock(selector: string): Record<string, string> {
  const at = CSS.indexOf(selector);
  if (at === -1) throw new Error(`tokens.css has no ${selector} block`);
  const open = CSS.indexOf("{", at);
  const close = CSS.indexOf("}", open);
  const body = CSS.slice(open + 1, close);
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    tokens[match[1]!] = match[2]!.trim();
  }
  return tokens;
}

const light = readBlock(":root {");

if (Object.keys(light).length < 50) {
  throw new Error(
    `parsed only ${Object.keys(light).length} tokens from :root - the parse is truncated`,
  );
}
const dark = { ...light, ...readBlock(':root[data-theme="dark"] {') };

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const clean = hex.trim().replace("#", "");
  const full = clean.length === 3 ? clean.replace(/./g, (c) => c + c) : clean;
  const n = Number.parseInt(full, 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

function ratio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const PAIRS: [string, string][] = [
  ["ink", "surface"],
  ["ink", "ground"],
  ["ink-soft", "surface"],
  ["ink-soft", "surface-2"],
  ["ink-soft", "sunk"],
  ["ink-soft", "accent-soft"],
  ["ink-faint", "surface"],
  ["ink-faint", "surface-2"],
  ["ink-faint", "ground"],
  ["cite-ink", "cite-bg"],
  ["cite-ink", "cite-bg-hover"],
  ["cite-current-ink", "cite-current-bg"],
  ["accent-ink", "accent"],
  ["accent", "surface"],
  ["warn", "warn-soft"],
  ["danger", "danger-soft"],
  ["paper-ink", "paper"],
  ["ink", "surface-2"], // StateCard's quoted model output
  ["ink", "accent-soft"], // the cited row in the retrieval scores table
  ["ink-faint", "surface-3"], // the composer when it is disabled
];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme", (_name, tokens) => {
  it.each(PAIRS)("--%s on --%s clears 4.5:1", (fg, bg) => {
    const foreground = tokens[fg];
    const background = tokens[bg];
    expect(foreground, `--${fg} is not defined`).toBeDefined();
    expect(background, `--${bg} is not defined`).toBeDefined();
    expect(ratio(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("token completeness", () => {
  it("defines every light token in the dark block too", () => {
    const darkOnly = readBlock(':root[data-theme="dark"] {');
    const shared = new Set([
      "font-ui",
      "font-doc",
      "font-mono",
      "text-label",
      "text-sm",
      "text-ui",
      "text-lg",
      "text-doc",
      "text-title",
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
      "s8",
      "s10",
      "radius-1",
      "radius-2",
      "radius-3",
      "radius-pill",
      "hit",
    ]);
    const missing = Object.keys(light).filter((key) => !shared.has(key) && !(key in darkOnly));
    expect(missing).toEqual([]);
  });

  it("keeps the OS-preference block in sync with the explicit dark block", () => {
    const media = readBlock(':root:not([data-theme="light"]) {');
    const explicit = readBlock(':root[data-theme="dark"] {');
    const differing = Object.keys(explicit).filter((key) => media[key] !== explicit[key]);
    expect(differing).toEqual([]);
  });
});

describe("the token system is enforced, not just documented", () => {
  const MODULES = globSync("src/**/*.module.css", {
    cwd: resolve(import.meta.dirname, "..", ".."),
  }).map((relative) => resolve(import.meta.dirname, "..", "..", relative));

  it("finds the component stylesheets at all", () => {
    expect(MODULES.length).toBeGreaterThan(3);
  });

  it("has a PAIRS row for every ink/surface combination the components render", () => {
    const known = new Set(PAIRS.map(([fg, bg]) => `${fg}|${bg}`));
    const missing = new Set<string>();

    for (const file of MODULES) {
      const css = readFileSync(file, "utf8");
      for (const block of css.split("}")) {
        const foreground = /(?:^|[;{\s])color:\s*var\(--([\w-]+)\)/.exec(block)?.[1];
        const background = /background(?:-color)?:\s*var\(--([\w-]+)\)/.exec(block)?.[1];
        if (!foreground || !background) continue;
        if (known.has(`${foreground}|${background}`)) continue;
        missing.add(`["${foreground}", "${background}"]  (${basename(file)})`);
      }
    }

    expect(
      [...missing].sort(),
      "these pairings are rendered but not contrast-checked - add them to PAIRS",
    ).toEqual([]);
  });

  it("has no colour literal in any component stylesheet", () => {
    // tokens.css's header claims this. Until now it was only a claim.
    const offenders: string[] = [];
    for (const file of MODULES) {
      const css = readFileSync(file, "utf8");
      css.split("\n").forEach((line, index) => {
        // Comments are allowed to mention a hex value when explaining one.
        const code = line.replace(/\/\*.*?\*\//g, "").split("/*")[0] ?? "";
        if (/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(code)) {
          offenders.push(`${basename(file)}:${index + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders, "use a token from tokens.css instead of a literal").toEqual([]);
  });
});
