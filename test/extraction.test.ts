import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assessExtraction } from "../src/loaders/quality.ts";
import { routeExtraction } from "../src/loaders/ocr.ts";
import type { OcrEngine } from "../src/loaders/ocr.ts";
import type { DocumentPage, TextLine } from "../src/models.ts";

function page(pageNumber: number, texts: string[]): DocumentPage {
  const lines: TextLine[] = texts.map((text) => ({ text, pageNumber }));
  return { text: texts.join("\n"), pageNumber, source: "scan.pdf", lines };
}

const PROSE =
  "This page carries a full paragraph of ordinary prose, long enough that no reasonable threshold would call it empty.";

describe("assessExtraction", () => {
  it("passes a document with a real text layer", () => {
    const quality = assessExtraction([page(1, [PROSE]), page(2, [PROSE])]);
    assert.equal(quality.needsOcr, false);
    assert.deepEqual(quality.poorPages, []);
  });

  it("flags a document whose pages are images", () => {
    const quality = assessExtraction([page(1, []), page(2, []), page(3, [])]);
    assert.equal(quality.needsOcr, true);
    assert.deepEqual(quality.poorPages, [1, 2, 3]);
    assert.match(quality.reasons.join(" "), /yielded almost no text/);
  });

  it("tolerates a single blank page in an otherwise fine document", () => {
    // A cover page or a separator sheet must not condemn the whole file.
    const quality = assessExtraction([
      page(1, [PROSE]),
      page(2, [PROSE]),
      page(3, [PROSE]),
      page(4, []),
    ]);
    assert.equal(quality.needsOcr, false);
    assert.deepEqual(quality.poorPages, [4]);
  });

  it("detects mojibake rather than language", () => {
    const quality = assessExtraction([page(1, ["���� ���� ���� ���� ���� ����"])]);
    assert.equal(quality.garbled, true);
  });

  it("detects a broken font encoding from one-character words", () => {
    const quality = assessExtraction([
      page(1, [Array.from({ length: 40 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(" ")]),
    ]);
    assert.equal(quality.garbled, true);
  });

  it("does not call ordinary prose garbled", () => {
    assert.equal(assessExtraction([page(1, [PROSE])]).garbled, false);
  });

  it("reports an empty document without throwing", () => {
    const quality = assessExtraction([]);
    assert.equal(quality.needsOcr, false);
    assert.deepEqual(quality.pages, []);
  });
});

describe("routeExtraction", () => {
  const scanned = [page(1, []), page(2, [])];

  it("leaves a good document untouched and calls no engine", async () => {
    let called = false;
    const engine: OcrEngine = {
      name: "spy",
      recognise: async () => {
        called = true;
        return new Map();
      },
    };
    const result = await routeExtraction("x.pdf", [page(1, [PROSE])], engine);
    assert.equal(called, false, "OCR is a fallback, never an upgrade");
    assert.equal(result.unmet, false);
    assert.deepEqual(result.recognised, []);
  });

  it("reports unmet need when no engine is supplied", async () => {
    const result = await routeExtraction("x.pdf", scanned);
    assert.equal(result.unmet, true);
    assert.deepEqual(result.recognised, []);
    assert.ok(result.quality.reasons.length > 0, "the caller must be told why");
  });

  it("fills in text-poor pages from the engine", async () => {
    const engine: OcrEngine = {
      name: "fake",
      recognise: async (_path, pageNumbers) =>
        new Map(
          pageNumbers.map((pageNumber) => [
            pageNumber,
            [{ text: PROSE, pageNumber }] as TextLine[],
          ]),
        ),
    };
    const result = await routeExtraction("x.pdf", scanned, engine);
    assert.deepEqual(result.recognised, [1, 2]);
    assert.equal(result.unmet, false, "quality is re-checked after OCR");
    assert.match(result.pages[0]!.text, /ordinary prose/);
    assert.equal(result.pages[0]!.lines.length, 1);
  });

  it("only asks the engine for the pages that need it", async () => {
    let asked: number[] = [];
    const engine: OcrEngine = {
      name: "fake",
      recognise: async (_path, pageNumbers) => {
        asked = pageNumbers;
        return new Map(pageNumbers.map((n) => [n, [{ text: PROSE, pageNumber: n }]]));
      },
    };
    // Three empty pages out of four crosses the ratio; page 2 is fine.
    await routeExtraction(
      "x.pdf",
      [page(1, []), page(2, [PROSE]), page(3, []), page(4, [])],
      engine,
    );
    assert.deepEqual(asked, [1, 3, 4], "page 2 already had text");
  });

  it("stays unmet when the engine cannot read the pages either", async () => {
    const engine: OcrEngine = { name: "useless", recognise: async () => new Map() };
    const result = await routeExtraction("x.pdf", scanned, engine);
    assert.equal(result.unmet, true);
    assert.deepEqual(result.recognised, []);
  });

  it("reports partial success honestly", async () => {
    const engine: OcrEngine = {
      name: "partial",
      recognise: async () => new Map([[1, [{ text: PROSE, pageNumber: 1 }]]]),
    };
    const result = await routeExtraction("x.pdf", [page(1, []), page(2, []), page(3, [])], engine);
    assert.deepEqual(result.recognised, [1]);
    assert.equal(result.unmet, true, "two of three pages are still unreadable");
  });
});
