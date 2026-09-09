// @vitest-environment node
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { compact, findPhraseItems } from "./highlight.ts";
import { SNIPPETS } from "../../test/fixtures/pages.ts";

describe("compact", () => {
  it("reduces to letters and digits, so punctuation cannot break a match", () => {
    expect(compact("back-bone to the")).toBe("backbonetothe");
    expect(compact("does not belong")).toBe("doesnotbelong");
    expect(compact("  L / R  ")).toBe("lr");
  });
});

describe("findPhraseItems", () => {
  it("finds a phrase split across several items", () => {
    const items = [
      { str: "The propagation " },
      { str: "delay is the " },
      { str: "distance between" },
    ];
    const hits = findPhraseItems(items, "The propagation delay is the distance between");
    expect([...hits].sort()).toEqual([0, 1, 2]);
  });

  it("survives hyphenation and missing spaces in the extracted text", () => {
    const items = [{ str: "through the back-" }, { str: "bone to the area" }];
    expect(findPhraseItems(items, "through the backbone to the area").size).toBe(2);
  });

  it("returns nothing for a phrase that is absent", () => {
    expect(
      findPhraseItems([{ str: "wholly unrelated text here" }], "sourdough starter recipe").size,
    ).toBe(0);
  });

  it("refuses to match on a phrase too short to be distinctive", () => {
    expect(findPhraseItems([{ str: "the delay" }], "the delay").size).toBe(0);
  });

  it("ignores a null phrase", () => {
    expect(findPhraseItems([{ str: "anything" }], null).size).toBe(0);
  });
});

const require_ = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const PDF = join(
  ROOT,
  "data",
  "Computer Networking A Top-Down Approach, 8th Edition by James F. Kurose, Keith W. Ross-Pearson-9780136681557.pdf",
);

describe.skipIf(!existsSync(PDF))("against the real PDF", () => {
  it("marks every cited sentence on the page it is keyed to", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Windows needs a file:// URL here, not a bare drive path.
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      require_.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;

    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(PDF)) }).promise;
    const misses: string[] = [];

    for (const [pageNo, phrase] of Object.entries(SNIPPETS)) {
      const page = await doc.getPage(Number(pageNo));
      const { items } = await page.getTextContent();
      const hits = findPhraseItems(items as { str?: string }[], phrase);
      if (hits.size === 0) misses.push(`p.${pageNo}`);
    }

    expect(misses).toEqual([]);
  }, 120_000);
});
