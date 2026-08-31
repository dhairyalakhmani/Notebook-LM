import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildBlocks, structureScore } from "../src/structure/blockBuilder.ts";
import { bareLines, pdfPages } from "./helpers.ts";

describe("buildBlocks - paragraph reconstruction", () => {
  it("joins wrapped lines into one paragraph block", () => {
    const blocks = buildBlocks(
      pdfPages([
        { text: "The retry policy applies to failed charges and is" },
        { text: "attempted three times over seventy-two hours before" },
        { text: "the subscription is finally cancelled." },
      ]),
    );
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.kind, "paragraph");
    assert.match(blocks[0]!.text, /failed charges .* finally cancelled\./);
  });

  it("starts a new paragraph on a larger vertical gap", () => {
    const blocks = buildBlocks(
      pdfPages([
        { text: "First paragraph line one." },
        { text: "First paragraph line two." },
        { text: "Second paragraph begins here.", gap: 26 },
        { text: "And continues on this line." },
      ]),
    );
    assert.equal(blocks.length, 2);
    assert.match(blocks[0]!.text, /line one\. First paragraph line two\./);
    assert.match(blocks[1]!.text, /Second paragraph begins/);
  });

  it("never merges across a page boundary", () => {
    const blocks = buildBlocks(
      pdfPages([
        { text: "Sentence continues at the bottom of page one", page: 1 },
        { text: "and resumes at the top of page two.", page: 2 },
      ]),
    );
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.pageStart, 1);
    assert.equal(blocks[1]!.pageStart, 2);
  });
});

describe("buildBlocks - kinds", () => {
  it("detects headings from size and boldness", () => {
    const blocks = buildBlocks(
      pdfPages([
        { text: "Billing Rules", fontSize: 14, isBold: true },
        { text: "Charges are retried three times." },
      ]),
    );
    assert.equal(blocks[0]!.kind, "heading");
    assert.equal(blocks[1]!.kind, "paragraph");
  });

  it("groups consecutive bullets into one list block", () => {
    const blocks = buildBlocks(
      pdfPages([
        { text: "The steps are as follows." },
        { text: "- Validate the card" },
        { text: "- Authorise the amount" },
        { text: "- Capture the funds" },
      ]),
    );
    const lists = blocks.filter((b) => b.kind === "listItem");
    assert.equal(lists.length, 1, "three bullets should merge into one list block");
    assert.match(lists[0]!.text, /Validate/);
    assert.match(lists[0]!.text, /Capture/);
  });

  it("recognises a table row by its column gaps", () => {
    const blocks = buildBlocks(
      pdfPages([{ text: "Region    Revenue    Growth" }, { text: "North     120000     4.1%" }]),
    );
    assert.ok(blocks.some((b) => b.kind === "table"));
  });

  it("loses no text when a document has no headings at all", () => {
    const texts = ["Alpha beta gamma.", "Delta epsilon zeta.", "Eta theta iota."];
    const blocks = buildBlocks(bareLines(texts));
    const joined = blocks.map((b) => b.text).join(" ");
    for (const text of texts) {
      assert.ok(joined.includes(text), `"${text}" must survive`);
    }
    assert.equal(structureScore(blocks), 0);
  });

  it("keeps text that appears before the first heading", () => {
    // The old chunker dropped this outright.
    const blocks = buildBlocks(
      pdfPages([
        { text: "Preamble that precedes every heading in the document." },
        { text: "First Heading", fontSize: 15, isBold: true },
        { text: "Body under the first heading." },
      ]),
    );
    assert.match(blocks[0]!.text, /Preamble/);
    assert.equal(blocks[0]!.kind, "paragraph");
  });
});
