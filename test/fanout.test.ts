import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { chunkDocument } from "../src/chunking/pipeline.ts";
import { splitToSize } from "../src/chunking/sizing.ts";
import { TiktokenCounter } from "../src/tokenizer.ts";
import { pdfPages } from "./helpers.ts";
import type { LineSpec } from "./helpers.ts";

const counter = new TiktokenCounter();

function section(name: string, sentences: number): LineSpec[] {
  const lines: LineSpec[] = [{ text: name, fontSize: 15, isBold: true, gap: 24 }];
  for (let i = 0; i < sentences; i++) {
    lines.push({
      text: `${name} point ${i}: this sentence explains one aspect of the rule in enough words to take up meaningful space.`,
    });
  }
  return lines;
}

describe("parent/child fan-out scales with section size", () => {
  it("gives one child when a section fits the child budget", async () => {
    const { parents, children } = await chunkDocument(pdfPages(section("Small", 4)), "d");
    assert.equal(parents.length, 1);
    assert.equal(children.length, 1, "nothing to split - one child is correct");
  });

  it("gives several children when a section is large", async () => {
    const { parents, children } = await chunkDocument(pdfPages(section("Big", 60)), "d");
    assert.ok(
      children.length / parents.length >= 2,
      `expected >=2 children per parent, got ${children.length}/${parents.length}`,
    );
  });

  it("fan-out grows monotonically with section size", async () => {
    const small = await chunkDocument(pdfPages(section("A", 8)), "d");
    const medium = await chunkDocument(pdfPages(section("A", 30)), "d");
    const large = await chunkDocument(pdfPages(section("A", 80)), "d");
    const ratio = (r: { parents: unknown[]; children: unknown[] }): number =>
      r.children.length / r.parents.length;
    assert.ok(ratio(small) <= ratio(medium), "medium must fan out at least as much as small");
    assert.ok(ratio(medium) <= ratio(large), "large must fan out at least as much as medium");
    assert.ok(ratio(large) > 1, "a large section must actually fan out");
  });
});

describe("overlap is reserved only when a split will happen", () => {
  it("does not split content that fits the full budget", () => {
    // ~300 tokens: under maxTokens 350, but over the 290 left after reserving 60.
    const text = Array.from(
      { length: 35 },
      (_, i) => `Sentence ${i} carries a few words here.`,
    ).join(" ");
    const size = counter.count(text);
    assert.ok(size > 290 && size < 350, `fixture should be 290-350 tokens, was ${size}`);

    const pieces = splitToSize([text], { maxTokens: 350, overlapTokens: 60, counter });
    assert.equal(pieces.length, 1, "content under the budget must not be split");
  });

  it("still honours the ceiling once a split is needed", () => {
    const text = Array.from(
      { length: 200 },
      (_, i) => `Sentence ${i} carries a few words here.`,
    ).join(" ");
    const pieces = splitToSize([text], { maxTokens: 350, overlapTokens: 60, counter });
    assert.ok(pieces.length > 1);
    for (const piece of pieces) {
      assert.ok(piece.tokenCount <= 350, `piece of ${piece.tokenCount} exceeds the 350 ceiling`);
    }
  });
});
