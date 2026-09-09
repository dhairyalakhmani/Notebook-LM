import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { splitToSize } from "../src/chunking/sizing.ts";
import { TiktokenCounter } from "../src/tokenizer.ts";

const counter = new TiktokenCounter();

describe("splitToSize - prefers the least damaging boundary", () => {
  it("leaves content alone when it already fits", () => {
    const pieces = splitToSize(["Short enough."], { maxTokens: 100, counter });
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0]!.reason, "structural");
  });

  it("splits at block boundaries before anything finer", () => {
    const blocks = ["A".repeat(200), "B".repeat(200)];
    const pieces = splitToSize(blocks, { maxTokens: 60, counter });
    assert.ok(pieces.every((p) => p.reason === "structural"));
  });

  it("falls to sentences when one block is too large", () => {
    const block = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i}.`).join(" ");
    const pieces = splitToSize([block], { maxTokens: 40, counter });
    assert.ok(pieces.length > 1);
    assert.ok(pieces.some((p) => p.reason === "sentence"));
    // No sentence may be cut in half.
    for (const piece of pieces) {
      assert.ok(/[.]$/.test(piece.text.trim()), `piece ends mid-sentence: ${piece.text}`);
    }
  });

  it("uses token splitting only when nothing else can work", () => {
    // One unbroken run with no sentence or clause boundary anywhere.
    const wall = "word ".repeat(400).trim();
    const pieces = splitToSize([wall], { maxTokens: 50, counter });
    assert.ok(pieces.length > 1);
    assert.ok(
      pieces.every((p) => p.reason === "token"),
      "a text with no natural boundary is the only case that may be token-split",
    );
  });

  it("respects the budget on every piece", () => {
    const block = Array.from({ length: 40 }, (_, i) => `Sentence ${i} has some words in it.`).join(
      " ",
    );
    const pieces = splitToSize([block], { maxTokens: 50, counter });
    for (const piece of pieces) {
      assert.ok(piece.tokenCount <= 50, `piece of ${piece.tokenCount} tokens exceeds 50`);
    }
  });

  it("carries overlap between consecutive pieces", () => {
    const block = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} appears here.`).join(
      " ",
    );
    const withOverlap = splitToSize([block], { maxTokens: 40, overlapTokens: 10, counter });
    const without = splitToSize([block], { maxTokens: 40, overlapTokens: 0, counter });
    assert.ok(withOverlap.length > 1);
    assert.ok(
      withOverlap[1]!.tokenCount > without[1]!.tokenCount,
      "the second piece should have grown by the carried tail",
    );
  });

  it("loses no words", () => {
    const block = Array.from({ length: 30 }, (_, i) => `Unique${i} token here.`).join(" ");
    const pieces = splitToSize([block], { maxTokens: 30, counter });
    const joined = pieces.map((p) => p.text).join(" ");
    for (let i = 0; i < 30; i++) {
      assert.ok(joined.includes(`Unique${i}`), `Unique${i} was lost`);
    }
  });
});
