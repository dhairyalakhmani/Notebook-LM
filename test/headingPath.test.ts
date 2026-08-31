import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { chunkDocument } from "../src/chunking/pipeline.ts";
import { buildBlocks } from "../src/structure/blockBuilder.ts";
import { pdfPages } from "./helpers.ts";
import type { DocumentPage, TextLine } from "../src/models.ts";

/** Markdown-style pages, where heading levels are explicit and trustworthy. */
function markdownPages(specs: { text: string; level?: number }[]): DocumentPage[] {
  const lines: TextLine[] = specs.map((spec) => ({
    text: spec.text,
    pageNumber: 1,
    ...(spec.level != null ? { headingLevel: spec.level } : {}),
    breakBefore: true,
  }));
  return [{ text: lines.map((l) => l.text).join("\n"), pageNumber: 1, source: "a.md", lines }];
}

describe("heading path - flat PDF levels", () => {
  // Every heading is bold at the same size, which is the normal PDF case. Depth
  // has to come from run structure: a heading with no body is an ancestor.
  const pages = pdfPages([
    { text: "1. USER DOMAIN", fontSize: 13, isBold: true },
    { text: "Customer", fontSize: 13, isBold: true },
    { text: "The customer table holds one row per registered account holder." },
    { text: "Branch", fontSize: 13, isBold: true },
    { text: "The branch table holds one row per physical rental location." },
    { text: "2. BILLING DOMAIN", fontSize: 13, isBold: true },
    { text: "Payment", fontSize: 13, isBold: true },
    { text: "The payment table records every transaction against an agreement." },
  ]);

  it("keeps the ancestor for the first child section", async () => {
    const { children } = await chunkDocument(pages, "d");
    const customer = children.find((p) => p.text.includes("registered account holder"));
    assert.deepEqual(customer?.headingPath, ["1. USER DOMAIN", "Customer"]);
  });

  it("keeps the ancestor for later siblings - the bug this replaced", async () => {
    // "Branch" is a sibling of "Customer", not a new top-level section. Popping
    // the domain here is what produced bare ["Branch"] paths.
    const { children } = await chunkDocument(pages, "d");
    const branch = children.find((p) => p.text.includes("physical rental location"));
    assert.deepEqual(branch?.headingPath, ["1. USER DOMAIN", "Branch"]);
  });

  it("switches ancestor when a new top-level section starts", async () => {
    const { children } = await chunkDocument(pages, "d");
    const payment = children.find((p) => p.text.includes("every transaction"));
    assert.deepEqual(payment?.headingPath, ["2. BILLING DOMAIN", "Payment"]);
  });
});

describe("heading path - explicit markdown levels", () => {
  it("uses the levels the format states", async () => {
    const { children } = await chunkDocument(
      markdownPages([
        { text: "Billing", level: 1 },
        { text: "Retries", level: 2 },
        { text: "Failed charges are retried three times over seventy-two hours." },
        { text: "Refunds", level: 2 },
        { text: "Refunds return to the original payment method within ten days." },
      ]),
      "d",
    );
    const retries = children.find((p) => p.text.includes("retried three times"));
    const refunds = children.find((p) => p.text.includes("original payment method"));
    assert.deepEqual(retries?.headingPath, ["Billing", "Retries"]);
    assert.deepEqual(refunds?.headingPath, ["Billing", "Refunds"]);
  });
});

describe("heading edge cases", () => {
  it("rejoins a heading that wrapped onto two lines", () => {
    const blocks = buildBlocks(
      pdfPages([
        { text: 'Available vehicles by branch (The "Whiteboard"', fontSize: 13, isBold: true },
        { text: 'Version)', fontSize: 13, isBold: true },
        { text: "This query lists every vehicle currently available at each branch." },
      ]),
    );
    const heading = blocks.find((b) => b.kind === "heading");
    assert.match(heading!.text, /Whiteboard" Version\)/, "the wrapped tail must be rejoined");
    assert.equal(blocks.filter((b) => b.kind === "heading").length, 1);
  });

  it("treats a trailing colon as a heading, not a sentence", () => {
    const blocks = buildBlocks(
      pdfPages([
        { text: "Frequent Queries:", fontSize: 13, isBold: true },
        { text: "Listed below are the queries the team runs most often each week." },
      ]),
    );
    assert.equal(blocks[0]!.kind, "heading", '"Frequent Queries:" is a heading');
  });

  it("does not treat a bold sentence as a heading", () => {
    const blocks = buildBlocks(
      pdfPages([
        {
          text: "This is an emphasised sentence that runs on well past any reasonable heading length.",
          isBold: true,
        },
      ]),
    );
    assert.equal(blocks[0]!.kind, "paragraph");
  });
});
