import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { detectColumns, joinBand, linesFromPieces } from "../src/loaders/pdfLoader.ts";
import type { Piece } from "../src/loaders/pdfLoader.ts";

function piece(
  text: string,
  left: number,
  top: number,
  options: { fontSize?: number; isBold?: boolean; width?: number } = {},
): Piece {
  const fontSize = options.fontSize ?? 10;
  const width = options.width ?? text.length * fontSize * 0.5;
  return { text, left, right: left + width, top, fontSize, isBold: options.isBold ?? false };
}

describe("joinBand - spacing the PDF only expressed as coordinates", () => {
  it("joins touching runs with no separator", () => {
    // "customer_id" then "(PK)" set immediately adjacent.
    const a = piece("customer_id", 50, 100);
    const b = piece("(PK)", a.right, 100);
    assert.equal(joinBand([a, b], 10).text, "customer_id(PK)");
  });

  it("inserts a space across a word-sized gap", () => {
    const a = piece("failed", 50, 100);
    const b = piece("charges", a.right + 3, 100);
    assert.equal(joinBand([a, b], 10).text, "failed charges");
  });

  it("inserts a cell separator across a column-sized gap", () => {
    const a = piece("Region", 50, 100);
    const b = piece("Revenue", 250, 100);
    const joined = joinBand([a, b], 10);
    assert.match(joined.text, /Region {3}Revenue/);
    assert.deepEqual(joined.cells, ["Region", "Revenue"], "cells carry the signal past cleaning");
  });

  it("does not double a space the file already emitted", () => {
    const a = piece("customer_id", 50, 100);
    const space = piece(" ", a.right, 100, { width: 3 });
    const b = piece("(PK)", space.right + 2, 100);
    assert.equal(joinBand([a, space, b], 10).text, "customer_id (PK)");
  });

  it("scales the threshold with font size", () => {
    // A 4pt gap is a word space at 10pt, but nothing at all at 30pt.
    const small = [piece("a", 50, 100, { fontSize: 10, width: 5 }), piece("b", 59, 100)];
    const large = [piece("a", 50, 100, { fontSize: 30, width: 5 }), piece("b", 59, 100)];
    assert.equal(joinBand(small, 10).text, "a b");
    assert.equal(joinBand(large, 30).text, "ab");
  });
});

describe("detectColumns", () => {
  function twoColumnPage(rows = 6): Piece[] {
    const pieces: Piece[] = [];
    for (let row = 0; row < rows; row++) {
      pieces.push(piece("left column prose filling it", 72, 100 + row * 14, { width: 218 }));
      pieces.push(piece("right column prose filling it", 320, 100 + row * 14, { width: 218 }));
    }
    return pieces;
  }

  it("splits a genuine two-column page", () => {
    const columns = detectColumns(twoColumnPage(), 612);
    assert.equal(columns.length, 2);
    assert.ok(columns[0]!.every((p) => p.text.startsWith("left")));
    assert.ok(columns[1]!.every((p) => p.text.startsWith("right")));
  });

  it("leaves a single-column page alone", () => {
    const pieces = Array.from({ length: 12 }, (_, i) =>
      piece("one continuous column of prose", 50, 100 + i * 14),
    );
    assert.equal(detectColumns(pieces, 600).length, 1);
  });

  it("does not mistake an indented block for a column", () => {
    const pieces = Array.from({ length: 12 }, (_, i) =>
      piece("body text at the margin", i < 6 ? 50 : 90, 100 + i * 14),
    );
    assert.equal(detectColumns(pieces, 600).length, 1);
  });

  it("does not mistake a sparse margin note for a column", () => {
    const pieces = Array.from({ length: 14 }, (_, i) =>
      piece("main body of the document", 50, 100 + i * 14),
    );
    pieces.push(piece("note", 480, 120)); // one lonely run on the right
    assert.equal(detectColumns(pieces, 600).length, 1, "one run is far below MIN_COLUMN_SHARE");
  });

  it("does not try to split very short pages", () => {
    assert.equal(detectColumns([piece("a", 50, 100), piece("b", 400, 100)], 600).length, 1);
  });

  it("splits a three-column page", () => {
    // Letter width, three 150pt columns with 30pt gutters.
    const pieces: Piece[] = [];
    for (let row = 0; row < 6; row++) {
      pieces.push(piece("a col one prose", 40, 100 + row * 14, { width: 150 }));
      pieces.push(piece("b col two prose", 220, 100 + row * 14, { width: 150 }));
      pieces.push(piece("c col three prose", 400, 100 + row * 14, { width: 150 }));
    }
    const columns = detectColumns(pieces, 612);
    assert.equal(columns.length, 3, "all gutters must be found, not only the widest");
    assert.ok(columns[0]!.every((p) => p.text.startsWith("a")));
    assert.ok(columns[1]!.every((p) => p.text.startsWith("b")));
    assert.ok(columns[2]!.every((p) => p.text.startsWith("c")));
  });

  it("still refuses a three-column table", () => {
    const pieces: Piece[] = [];
    for (let row = 0; row < 4; row++) {
      pieces.push(piece("North", 50, 100 + row * 14));
      pieces.push(piece("120000", 250, 100 + row * 14));
      pieces.push(piece("4.1%", 400, 100 + row * 14));
    }
    assert.equal(detectColumns(pieces, 612).length, 1);
  });
});

describe("linesFromPieces", () => {
  it("reads columns in order: all of the left, then all of the right", () => {
    const pieces: Piece[] = [];
    for (let row = 0; row < 6; row++) {
      pieces.push(piece(`L${row} left column body text`, 72, 100 + row * 14, { width: 218 }));
      pieces.push(piece(`R${row} right column body text`, 320, 100 + row * 14, { width: 218 }));
    }
    const texts = linesFromPieces(pieces, 1, 612).map((l) => l.text);
    assert.equal(texts.length, 12);
    assert.ok(
      texts.slice(0, 6).every((t) => t.startsWith("L")),
      "left column first",
    );
    assert.ok(
      texts.slice(6).every((t) => t.startsWith("R")),
      "right column second",
    );
  });

  it("bands a large heading whose runs sit further apart", () => {
    const lines = linesFromPieces(
      [piece("Big", 50, 100, { fontSize: 18 }), piece("Heading", 90, 102.5, { fontSize: 18 })],
      1,
      600,
    );
    assert.equal(lines.length, 1, "one heading, not two");
  });

  it("keeps separate body lines separate", () => {
    const lines = linesFromPieces(
      [piece("first line", 50, 100), piece("second line", 50, 114)],
      1,
      600,
    );
    assert.equal(lines.length, 2);
  });

  it("preserves geometry for the structure layer", () => {
    const lines = linesFromPieces([piece("some text", 50, 100)], 1, 600);
    assert.equal(lines[0]!.top, 100);
    assert.equal(lines[0]!.left, 50);
    assert.ok((lines[0]!.right ?? 0) > 50);
  });

  it("returns nothing for an empty page - the scanned-PDF case", () => {
    assert.deepEqual(linesFromPieces([], 1, 600), []);
  });
});

describe("table detection now reaches the structure layer", () => {
  it("a coordinate-positioned table survives as detectable text", async () => {
    const { buildBlocks } = await import("../src/structure/blockBuilder.ts");
    const pieces: Piece[] = [];
    const rows = [
      ["Region", "Revenue", "Growth"],
      ["North", "120000", "4.1%"],
      ["South", "98000", "2.7%"],
    ];
    for (const [row, cells] of rows.entries()) {
      pieces.push(piece(cells[0]!, 50, 100 + row * 14));
      pieces.push(piece(cells[1]!, 250, 100 + row * 14));
      pieces.push(piece(cells[2]!, 400, 100 + row * 14));
    }
    const lines = linesFromPieces(pieces, 1, 600);
    const blocks = buildBlocks([
      { text: lines.map((l) => l.text).join("\n"), pageNumber: 1, source: "t.pdf", lines },
    ]);
    assert.ok(
      blocks.some((b) => b.kind === "table"),
      "the cell separators must make this recognisable as a table",
    );
  });
});
