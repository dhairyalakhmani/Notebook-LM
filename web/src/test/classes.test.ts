// @vitest-environment node
import { globSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "..");
const WORD = /[A-Za-z0-9_]/;

function sources(): string[] {
  return globSync("**/*.tsx", { cwd: SRC })
    .map((relative) => resolve(SRC, relative))
    .sort();
}

function uncommented(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, "");
}

function classesIn(css: string): Set<string> {
  const found = new Set<string>();
  for (const chunk of uncommented(css).split("}")) {
    const selector = chunk.slice(0, chunk.indexOf("{"));
    for (const match of selector.matchAll(/\.([A-Za-z][\w-]*)/g)) found.add(match[1]!);
  }
  return found;
}

function styleImport(file: string, code: string): string | null {
  const match = /import\s+styles\s+from\s+"([^"]+\.module\.css)"/.exec(code);
  return match === null ? null : resolve(dirname(file), match[1]!);
}

function usages(code: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = code.indexOf(needle); at !== -1; at = code.indexOf(needle, at + 1)) {
    const next = code.charAt(at + needle.length);
    if (next === "" || !WORD.test(next)) found.push(at);
  }
  return found;
}

describe("css module classes", () => {
  it("resolves every styles.x a component renders to a real rule", () => {
    const missing: string[] = [];

    for (const file of sources()) {
      const code = readFileSync(file, "utf8");
      const module = styleImport(file, code);
      if (module === null) continue;

      const defined = classesIn(readFileSync(module, "utf8"));
      for (const match of code.matchAll(/\bstyles\.([A-Za-z]\w*)/g)) {
        const name = match[1]!;
        if (!defined.has(name)) {
          missing.push(`${basename(file)} uses styles.${name}, absent from ${basename(module)}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("marks every scroller with data-scroll", () => {
    const untagged: string[] = [];
    let checked = 0;

    for (const module of globSync("**/*.module.css", { cwd: SRC }).sort()) {
      const path = resolve(SRC, module);
      const css = uncommented(readFileSync(path, "utf8"));

      // Class names whose own rule turns on scrolling.
      const scrollers = new Set<string>();
      for (const chunk of css.split("}")) {
        const brace = chunk.indexOf("{");
        if (brace === -1) continue;
        if (!/overflow(-y)?:\s*(auto|scroll)/.test(chunk.slice(brace))) continue;
        for (const match of chunk.slice(0, brace).matchAll(/\.([A-Za-z][\w-]*)/g)) {
          scrollers.add(match[1]!);
        }
      }
      if (scrollers.size === 0) continue;

      for (const file of sources()) {
        const code = readFileSync(file, "utf8");
        if (styleImport(file, code) !== path) continue;

        for (const name of scrollers) {
          for (const at of usages(code, `styles.${name}`)) {
            // The JSX tag that applies the class: from its `<` to its `>`.
            const open = code.lastIndexOf("<", at);
            const close = code.indexOf(">", at);
            if (open === -1 || close === -1) continue;
            checked += 1;
            if (!code.slice(open, close).includes("data-scroll")) {
              untagged.push(`${basename(file)}: styles.${name} scrolls without data-scroll`);
            }
          }
        }
      }
    }

    expect(untagged).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(5);
  });
});
