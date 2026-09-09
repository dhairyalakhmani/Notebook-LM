import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { chunkDocument } from "../src/chunking/pipeline.ts";
import { LLMSegmenter } from "../src/chunking/segmentation/llm.ts";
import { sanitizeBoundaries } from "../src/chunking/segmentation/base.ts";
import { buildBlocks } from "../src/structure/blockBuilder.ts";
import { bareLines, pdfPages } from "./helpers.ts";
import type { CompletionModel } from "../src/chunking/segmentation/llm.ts";

function locate(chunks: { text: string }[], needle: string): number {
  return chunks.findIndex((chunk) => chunk.text.includes(needle));
}

describe("semantic boundaries are preserved", () => {
  it("keeps a definition with the explanation that follows it", async () => {
    const { children } = await chunkDocument(
      pdfPages([
        { text: "Idempotency Key", fontSize: 14, isBold: true },
        { text: "An idempotency key is a unique token supplied by the client." },
        { text: "It exists so that retrying a request cannot charge a customer twice." },
      ]),
      "doc",
    );
    const definition = locate(children, "unique token supplied");
    const explanation = locate(children, "cannot charge a customer twice");
    assert.notEqual(definition, -1);
    assert.equal(definition, explanation, "definition and explanation must share a chunk");
  });

  it("keeps a concept with its example", async () => {
    const { children } = await chunkDocument(
      pdfPages([
        { text: "Surrogate keys decouple identity from changeable data." },
        { text: "For example, customer_id stays stable when an email address changes." },
      ]),
      "doc",
    );
    assert.equal(
      locate(children, "decouple identity"),
      locate(children, "For example, customer_id"),
      "a concept and its example must share a chunk",
    );
  });

  it("keeps a list with the sentence that introduces it", async () => {
    const { children } = await chunkDocument(
      pdfPages([
        { text: "A payment moves through three stages:" },
        { text: "- Authorisation" },
        { text: "- Capture" },
        { text: "- Settlement" },
      ]),
      "doc",
    );
    const intro = locate(children, "three stages");
    assert.notEqual(intro, -1);
    assert.equal(intro, locate(children, "Authorisation"), "list must stay with its lead-in");
    assert.equal(intro, locate(children, "Settlement"), "the list must not be broken up");
  });

  it("keeps the steps of one procedure together", async () => {
    const { children } = await chunkDocument(
      pdfPages([
        { text: "To rotate a key:" },
        { text: "1. Generate a replacement key" },
        { text: "2. Deploy it to every service" },
        { text: "3. Revoke the old key" },
      ]),
      "doc",
    );
    assert.equal(locate(children, "Generate a replacement"), locate(children, "Revoke the old"));
  });

  it("keeps a question with its answer", async () => {
    const { children } = await chunkDocument(
      pdfPages([
        { text: "What happens when a charge fails?" },
        { text: "It is retried three times across seventy-two hours." },
      ]),
      "doc",
    );
    assert.equal(
      locate(children, "What happens when a charge fails?"),
      locate(children, "retried three times"),
    );
  });

  it("does separate genuinely different sections", async () => {
    const { children } = await chunkDocument(
      pdfPages([
        { text: "Billing", fontSize: 15, isBold: true },
        { text: "Charges are retried three times over seventy-two hours." },
        { text: "Shipping", fontSize: 15, isBold: true },
        { text: "Parcels are dispatched from the nearest warehouse." },
      ]),
      "doc",
    );
    assert.notEqual(
      locate(children, "retried three times"),
      locate(children, "nearest warehouse"),
      "unrelated sections must not be merged",
    );
  });
});

describe("unstructured documents", () => {
  const rough = [
    "The vehicle table stores one row per physical car in the fleet.",
    "Each row carries a VIN, a registration plate and a current branch.",
    "Pricing is held separately so that a rate change does not rewrite the fleet.",
    "A pricing row applies to a category and a date range.",
  ];

  it("does not fall back to fixed-size cuts when there is no structure", async () => {
    const { children, report } = await chunkDocument(bareLines(rough), "doc");
    assert.equal(report.structureScore, 0, "this document genuinely has no headings");
    assert.equal(report.tokenSplitChunks, 0, "nothing should need a blind token cut at this size");
    for (const sentence of rough) {
      assert.ok(
        children.some((c) => c.text.includes(sentence)),
        `"${sentence.slice(0, 30)}..." must survive intact`,
      );
    }
  });

  it("still produces usable chunks with no geometry whatsoever", async () => {
    const { children, parents } = await chunkDocument(bareLines(rough), "doc");
    assert.ok(children.length > 0);
    assert.ok(parents.length > 0);
    assert.ok(children.every((c) => c.parentId !== null));
  });
});

describe("LLMSegmenter", () => {
  const blocks = buildBlocks(
    pdfPages([
      { text: "Topic one begins here and" },
      { text: "wraps onto a second line." },
      { text: "Topic one continues in a", gap: 30 },
      { text: "separate paragraph below." },
      { text: "Topic two begins with a", gap: 30 },
      { text: "different subject entirely." },
      { text: "Topic two ends after one", gap: 30 },
      { text: "final wrapped sentence." },
    ]),
  );

  it("uses the boundaries the model returns", async () => {
    const model: CompletionModel = {
      generate: async () => JSON.stringify({ boundaries: [2] }),
    };
    const found = await new LLMSegmenter({ model }).boundaries(blocks);
    assert.deepEqual(found, [2]);
  });

  it("degrades to no boundaries when the provider fails", async () => {
    let reported = false;
    const model: CompletionModel = {
      generate: async () => {
        throw new Error("provider down");
      },
    };
    const found = await new LLMSegmenter({
      model,
      onFallback: () => (reported = true),
    }).boundaries(blocks);
    assert.deepEqual(found, [], "ingest must not break when the LLM is unavailable");
    assert.ok(reported, "the fallback must be reported, not silent");
  });

  it("discards malformed output rather than corrupting the split", async () => {
    const model: CompletionModel = {
      generate: async () => `{"boundaries": [0, -3, 99, "two", 2.5, 2]}`,
    };
    const found = await new LLMSegmenter({ model }).boundaries(blocks);
    assert.deepEqual(found, [2], "only the one valid in-range index survives");
  });

  it("never lets the model rewrite text", async () => {
    const model: CompletionModel = {
      generate: async () => JSON.stringify({ boundaries: [2], text: "HALLUCINATED" }),
    };
    const { children } = await chunkDocument(
      bareLines(["Topic one begins.", "Topic two begins."]),
      "doc",
      { segmenters: [new LLMSegmenter({ model })] },
    );
    assert.ok(children.every((c) => !c.text.includes("HALLUCINATED")));
  });
});

describe("sanitizeBoundaries", () => {
  it("drops out-of-range, duplicate and unsorted values", () => {
    assert.deepEqual(sanitizeBoundaries([5, 2, 2, 0, -1, 99, 3], 6), [2, 3, 5]);
  });
});
