import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { splitSentences } from "../src/chunking/sentences.ts";

describe("splitSentences", () => {
  it("splits on real sentence ends", () => {
    assert.deepEqual(splitSentences("One thing. Two things. Three."), [
      "One thing.",
      "Two things.",
      "Three.",
    ]);
  });

  it("does not split on titles - the ICU default gets this wrong", () => {
    assert.deepEqual(splitSentences("Dr. Smith joined in 1999. He left."), [
      "Dr. Smith joined in 1999.",
      "He left.",
    ]);
  });

  it("does not split on cross-references", () => {
    assert.deepEqual(splitSentences("The rule applies (see Sec. 4.2). Others do not."), [
      "The rule applies (see Sec. 4.2).",
      "Others do not.",
    ]);
  });

  it("does not split on initials", () => {
    assert.deepEqual(splitSentences("Written by J. R. Tolkien. It sold well."), [
      "Written by J. R. Tolkien.",
      "It sold well.",
    ]);
  });

  it("keeps e.g. and i.e. inside their sentence", () => {
    assert.deepEqual(splitSentences("Use a key, e.g. customer_id. Then index it."), [
      "Use a key, e.g. customer_id.",
      "Then index it.",
    ]);
  });

  it("returns nothing for empty input", () => {
    assert.deepEqual(splitSentences("   "), []);
  });
});
