import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseQuote } from "../src/generation/quote.ts";
import { MIN_QUOTE_CHARS } from "../src/api/dto.ts";
import type { Chunk } from "../src/models.ts";
import type { Passage } from "../src/retrieval/retriever.ts";

function chunk(text: string, over: Partial<Chunk> = {}): Chunk {
  return {
    chunkId: "doc-c00001",
    documentId: "doc",
    parentId: "doc-p00001",
    text,
    tokenCount: 100,
    pageStart: 46,
    pageEnd: 46,
    headingPath: ["1.4 Delay, Loss and Throughput"],
    sectionTitle: null,
    chunkIndex: 0,
    previousChunkId: null,
    nextChunkId: null,
    blockKinds: ["paragraph"],
    boundaryReason: "heading",
    ...over,
  };
}

function passage(text: string, over: Partial<Passage> = {}): Passage {
  return {
    chunkId: "doc-p00001",
    documentId: "doc",
    filename: "networking.pdf",
    title: "networking",
    pageStart: 46,
    pageEnd: 48,
    headingPath: ["1.4 Delay, Loss and Throughput"],
    sectionTitle: "1.4 Delay, Loss and Throughput",
    blockKinds: ["paragraph"],
    text,
    match: {
      chunkId: "doc-c00001",
      fused: 0.5,
      dense: 0.7,
      sparse: null,
      denseRank: 1,
      sparseRank: null,
    },
    matchCount: 1,
    ...over,
  };
}

// Real prose from the corpus this project is built on.
const DELAY_TEXT = [
  "The time required to examine the packet's header and determine where to direct the packet is part of the processing delay.",
  "Queuing delay is the time the packet waits to be transmitted onto the link.",
  "The transmission delay is L/R, where L is the length of the packet and R is the transmission rate of the link.",
  "Once a bit is pushed onto the link, it needs to propagate to the next router.",
].join(" ");

describe("chooseQuote", () => {
  it("picks the sentence the cited claim is actually about", () => {
    const answer =
      "Transmission delay is the time to push all of a packet's bits onto the link, " +
      "computed as L/R [1]. Propagation delay is different [2].";
    const choice = chooseQuote(answer, 1, passage(DELAY_TEXT), chunk(DELAY_TEXT));
    assert.ok(choice);
    assert.match(choice.quote, /transmission delay is L\/R/i);
  });

  it("picks a different sentence for a different marker in the same answer", () => {
    const answer =
      "Transmission delay is L/R [1]. Once a bit is pushed onto the link it must " +
      "propagate to the next router, which is the propagation delay [2].";
    const first = chooseQuote(answer, 1, passage(DELAY_TEXT), chunk(DELAY_TEXT));
    const second = chooseQuote(answer, 2, passage(DELAY_TEXT), chunk(DELAY_TEXT));
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.quote, second.quote);
    assert.match(second.quote, /propagate to the next router/i);
  });

  it("never returns the prepended heading line", () => {
    const heading = "1.4.2 Transmission Delay and Propagation Delay";
    const withHeading = chunk(heading + "\n" + DELAY_TEXT, { sectionTitle: heading });
    const choice = chooseQuote(
      "The transmission delay is L/R for a packet of length L [1].",
      1,
      passage(DELAY_TEXT),
      withHeading,
    );
    assert.ok(choice);
    assert.notEqual(choice.quote, heading);
    assert.ok(!choice.quote.startsWith("1.4.2"));
    assert.match(choice.quote, /transmission delay is L\/R/i);
  });

  it("requires shared meaning, not shared grammar", () => {
    const choice = chooseQuote(
      "It is the one of the [1].",
      1,
      passage(DELAY_TEXT),
      chunk(DELAY_TEXT),
    );
    assert.equal(choice, null);
  });

  it("returns null rather than a quote too short to locate", () => {
    const tiny = chunk("Yes. No. OK.");
    assert.equal(chooseQuote("Definitely [1].", 1, passage("Yes. No. OK."), tiny), null);
  });

  it("returns null when the claim shares nothing with the passage", () => {
    const choice = chooseQuote(
      "The mitochondrion is the powerhouse of the cell [1].",
      1,
      passage(DELAY_TEXT),
      chunk(DELAY_TEXT),
    );
    assert.equal(choice, null);
  });

  it("prefers a whole sentence over a better-scoring fragment", () => {
    const text =
      "equals the ratio of length to rate. " +
      "Transmission delay is computed per packet from the header and the payload together.";
    const choice = chooseQuote(
      "Transmission delay is computed per packet, and equals the ratio of length to rate [1].",
      1,
      passage(text),
      chunk(text),
    );
    assert.ok(choice);
    assert.match(choice.quote, /^[A-Z]/, "a quote must not begin mid-clause");
    assert.match(choice.quote, /[.!?]$/, "a quote must not end mid-clause");
    assert.equal(
      choice.quote,
      "Transmission delay is computed per packet from the header and the payload together.",
    );
  });

  it("falls back to a fragment when no whole sentence has any evidence", () => {
    // Better a findable fragment from the right passage than no highlight.
    const onlyFragments = "queuing delay is the time a packet waits before transmission onto";
    const choice = chooseQuote(
      "Queuing delay is the waiting time before transmission [1].",
      1,
      passage(onlyFragments),
      chunk(onlyFragments),
    );
    assert.ok(choice, "a fragment is better than nothing when nothing else matches");
    assert.match(choice.quote, /queuing delay/i);
  });

  it("still returns a quote when the chunk holds a single sentence", () => {
    const one = "Queuing delay is the time the packet waits to be transmitted onto the link.";
    const choice = chooseQuote(
      "Queuing delay is the waiting time before transmission [1].",
      1,
      passage(one),
      chunk(one),
    );
    assert.ok(choice, "a one-sentence chunk must still yield its sentence");
    assert.equal(choice.quote, one);
  });

  it("is deterministic, because the quote gets stored", () => {
    const answer = "Transmission delay is L/R [1].";
    const runs = Array.from({ length: 5 }, () =>
      chooseQuote(answer, 1, passage(DELAY_TEXT), chunk(DELAY_TEXT)),
    );
    for (const run of runs) assert.equal(run?.quote, runs[0]?.quote);
  });

  it("never returns a quote shorter than the shared floor", () => {
    const choice = chooseQuote(
      "Queuing delay is the waiting time [1].",
      1,
      passage(DELAY_TEXT),
      chunk(DELAY_TEXT),
    );
    assert.ok(choice);
    const compacted = choice.quote.toLowerCase().replace(/[^a-z0-9]/g, "");
    assert.ok(compacted.length >= MIN_QUOTE_CHARS);
  });

  it("falls back to the parent when no child chunk is available", () => {
    const choice = chooseQuote("Transmission delay is L/R [1].", 1, passage(DELAY_TEXT), null);
    assert.ok(choice);
    assert.match(choice.quote, /transmission delay/i);
  });

  it("offers the child's page as the starting point, not the parent's range", () => {
    const child = chunk(DELAY_TEXT, { pageStart: 47, pageEnd: 47 });
    const choice = chooseQuote("Transmission delay is L/R [1].", 1, passage(DELAY_TEXT), child);
    assert.ok(choice);
    assert.equal(choice.page, 47);
  });

  it("strips markers before matching, so [1] is never a token", () => {
    const choice = chooseQuote(
      "Queuing delay is the wait before transmission [1].",
      1,
      passage(DELAY_TEXT),
      chunk(DELAY_TEXT),
    );
    assert.ok(choice);
    assert.match(choice.quote, /queuing delay/i);
  });

  it("handles the full-width markers gpt-oss emits", () => {
    const choice = chooseQuote(
      "The transmission delay is L/R for a packet of length L 【1】.",
      1,
      passage(DELAY_TEXT),
      chunk(DELAY_TEXT),
    );
    assert.ok(choice);
    assert.match(choice.quote, /transmission delay is L\/R/i);
  });
});
