import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { chunkDocument } from "../src/chunking/pipeline.ts";
import * as config from "../src/config.ts";
import { pdfPages } from "./helpers.ts";
import type { LineSpec } from "./helpers.ts";

function longSection(heading: string, sentences: number): LineSpec[] {
  const lines: LineSpec[] = [{ text: heading, fontSize: 15, isBold: true }];
  for (let i = 0; i < sentences; i++) {
    lines.push({
      text: `${heading} detail ${i}: this clause explains one more aspect of the rule in enough words to occupy space.`,
    });
  }
  return lines;
}

describe("parent/child hierarchy", () => {
  it("fans out - a large unit yields several children per parent", async () => {
    const { parents, children } = await chunkDocument(pdfPages(longSection("Billing", 60)), "doc");
    assert.ok(parents.length >= 1);
    assert.ok(
      children.length > parents.length,
      `expected fan-out, got ${parents.length} parents and ${children.length} children`,
    );
  });

  it("keeps parents larger than children", async () => {
    const { parents, children } = await chunkDocument(pdfPages(longSection("Billing", 60)), "doc");
    const avg = (list: { tokenCount: number }[]): number =>
      list.reduce((sum, c) => sum + c.tokenCount, 0) / list.length;
    assert.ok(avg(parents) > avg(children), "parents must carry more context than children");
  });

  it("respects both token budgets", async () => {
    const { parents, children } = await chunkDocument(pdfPages(longSection("Billing", 80)), "doc");
    for (const parent of parents) {
      assert.ok(
        parent.tokenCount <= config.PARENT_MAX_TOKENS,
        `parent of ${parent.tokenCount} exceeds ${config.PARENT_MAX_TOKENS}`,
      );
    }
    for (const child of children) {
      // The heading path is prepended after sizing, so allow for it.
      assert.ok(
        child.tokenCount <= config.CHILD_MAX_TOKENS + 40,
        `child of ${child.tokenCount} far exceeds ${config.CHILD_MAX_TOKENS}`,
      );
    }
  });

  it("every child points at a real parent", async () => {
    const { parents, children } = await chunkDocument(pdfPages(longSection("Billing", 60)), "doc");
    const ids = new Set(parents.map((p) => p.chunkId));
    for (const child of children) {
      assert.ok(child.parentId && ids.has(child.parentId), "orphan child chunk");
    }
  });
});

describe("chunk metadata", () => {
  const pages = pdfPages([
    { text: "1. BILLING DOMAIN", fontSize: 16, isBold: true },
    { text: "Retry Policy", fontSize: 13, isBold: true },
    { text: "Failed charges are retried three times over seventy-two hours." },
    { text: "After that the subscription is cancelled automatically." },
    { text: "Refunds", fontSize: 13, isBold: true, page: 2 },
    { text: "A refund is issued to the original payment method within ten days." },
  ]);

  it("records a heading path a citation can render", async () => {
    const { children } = await chunkDocument(pages, "doc");
    const retry = children.find((c) => c.text.includes("retried three times"));
    assert.ok(retry);
    assert.ok(retry.headingPath.length >= 1, "heading path must be populated");
    assert.ok(
      retry.headingPath.some((h) => /Retry Policy|BILLING/.test(h)),
      `unexpected path: ${JSON.stringify(retry.headingPath)}`,
    );
  });

  it("records a page range, not a single page", async () => {
    const { children } = await chunkDocument(pages, "doc");
    const refund = children.find((c) => c.text.includes("original payment method"));
    assert.ok(refund);
    assert.equal(refund.pageStart, 2);
    assert.equal(refund.pageEnd, 2);
  });

  it("links neighbours in reading order", async () => {
    const { parents } = await chunkDocument(pdfPages(longSection("Billing", 80)), "doc");
    assert.ok(parents.length > 1, "need several parents to have neighbours");
    assert.equal(parents[0]!.previousChunkId, null);
    assert.equal(parents[0]!.nextChunkId, parents[1]!.chunkId);
    assert.equal(parents[1]!.previousChunkId, parents[0]!.chunkId);
    assert.equal(parents.at(-1)!.nextChunkId, null);
  });

  it("records what a chunk is made of, and why it ends where it does", async () => {
    const { children } = await chunkDocument(pages, "doc");
    for (const child of children) {
      assert.ok(child.blockKinds.length > 0, "blockKinds must say what is inside");
      assert.ok(child.boundaryReason, "every chunk records its boundary reason");
    }
  });

  it("gives every chunk a stable index", async () => {
    const { children } = await chunkDocument(pdfPages(longSection("Billing", 60)), "doc");
    assert.deepEqual(
      children.map((c) => c.chunkIndex),
      children.map((_, i) => i),
    );
  });
});
