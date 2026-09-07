import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalize } from "../src/embedding/shared.ts";
import { NotebookStore } from "../src/notebook/store.ts";
import { Retriever, formatPages } from "../src/retrieval/retriever.ts";
import { fuseRankings } from "../src/search/hybrid.ts";
import { VectorStore } from "../src/search/vectorStore.ts";
import type { Embedder } from "../src/embedding/base.ts";
import type { Chunk, Document } from "../src/models.ts";

const NOTEBOOK = "test-notebook";
const DOCUMENT_ID = "doc1";

/**
 * Three dimensions, not 384. The store only requires the query and the stored
 * vectors to agree with each other, so tiny vectors let every cosine in these
 * tests be worked out by hand instead of taken on trust.
 *
 * Dimension 0 is "payments", dimension 1 is "identifiers".
 */
const VECTORS: Record<string, number[]> = {
  // the four child chunks
  "c1: Failed charges are retried three times over seventy-two hours.": [1, 0, 0],
  "c2: A declined payment is attempted again for three days.": normalize([0.9, 0.1, 0]),
  "c3: Retry backoff doubles between each attempt.": normalize([0.8, 0.2, 0]),
  "c4: The customer_id column is the primary key of the Customer table.":
    normalize([0.1, 1, 0]),

  // questions
  "how are failed charges retried?": [1, 0, 0],
  // Deliberately the payments vector: the whole point is that the embedder has
  // no idea what `customer_id` means, so the dense search cannot help here.
  customer_id: [1, 0, 0],
};

/** Looks its answers up, and throws on anything it was not given - a typo in a
 *  test should fail loudly, not quietly return a default vector. */
class StubEmbedder implements Embedder {
  readonly modelId = "stub/test-embedder";
  readonly dimensions = 3;
  readonly maxInputTokens = 512;
  /** Every text this was asked to embed, so a test can prove it was *not* called. */
  readonly calls: string[] = [];

  private lookup(text: string): number[] {
    const vector = VECTORS[text];
    if (!vector) throw new Error(`StubEmbedder has no vector for: ${text}`);
    this.calls.push(text);
    return vector;
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.lookup(text)));
  }

  embedQuery(text: string): Promise<number[]> {
    return Promise.resolve(this.lookup(text));
  }
}

function chunk(overrides: Partial<Chunk> & Pick<Chunk, "chunkId">): Chunk {
  return {
    documentId: DOCUMENT_ID,
    parentId: null,
    text: "",
    tokenCount: 10,
    pageStart: 1,
    pageEnd: 1,
    headingPath: [],
    sectionTitle: null,
    chunkIndex: 0,
    previousChunkId: null,
    nextChunkId: null,
    blockKinds: ["paragraph"],
    boundaryReason: "heading",
    ...overrides,
  };
}

/**
 * One document, two parents, four children: three of the children belong to the
 * payments parent, which is what makes deduplication observable.
 */
async function fixture(): Promise<{ store: NotebookStore; vectorStore: VectorStore; embedder: StubEmbedder }> {
  const directory = mkdtempSync(join(tmpdir(), "retrieval-"));
  const store = new NotebookStore(directory);
  const vectorStore = new VectorStore(directory);
  const embedder = new StubEmbedder();

  const document: Document = {
    documentId: DOCUMENT_ID,
    title: "Schema Notes",
    filename: "Schema Notes.pdf",
    sourceType: "pdf",
    pageCount: 4,
    addedAt: new Date().toISOString(),
  };

  const parents = [
    chunk({
      chunkId: "p1",
      text: "PAYMENTS. Failed charges are retried three times over seventy-two hours. "
        + "Retry backoff doubles between each attempt.",
      pageStart: 1,
      pageEnd: 2,
      headingPath: ["2. BILLING DOMAIN", "Payments"],
      sectionTitle: "Payments",
    }),
    chunk({
      chunkId: "p2",
      text: "IDENTIFIERS. The customer_id column is the primary key of the Customer table.",
      pageStart: 3,
      pageEnd: 3,
      headingPath: ["1. USER & ACCESS DOMAIN", "Customer"],
      sectionTitle: "Customer",
    }),
  ];

  const children = [
    chunk({
      chunkId: "c1",
      parentId: "p1",
      text: "c1: Failed charges are retried three times over seventy-two hours.",
    }),
    chunk({
      chunkId: "c2",
      parentId: "p1",
      text: "c2: A declined payment is attempted again for three days.",
    }),
    chunk({
      chunkId: "c3",
      parentId: "p1",
      text: "c3: Retry backoff doubles between each attempt.",
    }),
    chunk({
      chunkId: "c4",
      parentId: "p2",
      text: "c4: The customer_id column is the primary key of the Customer table.",
      pageStart: 3,
      pageEnd: 3,
    }),
  ];

  store.addDocument(NOTEBOOK, document);
  store.addChunks([...parents, ...children]);
  const vectors = await embedder.embedDocuments(children.map((child) => child.text));
  vectorStore.add(NOTEBOOK, children, vectors, embedder.modelId);
  embedder.calls.length = 0; // ingest is done; from here, calls are query-time

  return { store, vectorStore, embedder };
}

describe("reciprocal rank fusion", () => {
  it("beats a single first place with two second places", () => {
    // `both` is 2nd in each list; `denseOnly` is 1st in one and absent from the other.
    const fused = fuseRankings(
      [
        ["denseOnly", 0.9],
        ["both", 0.8],
      ],
      [
        ["sparseOnly", 12],
        ["both", 9],
      ],
    );
    assert.equal(fused[0]?.chunkId, "both");
    // 1/62 + 1/62 against 1/61: appearing twice wins by more than a rank costs.
    assert.ok(fused[0]!.fused > fused[1]!.fused);
  });

  it("carries each list's own score and rank, and null where a list missed", () => {
    const [both, denseOnly, sparseOnly] = fuseRankings(
      [
        ["both", 0.77],
        ["denseOnly", 0.5],
      ],
      [
        ["both", 11.4],
        ["sparseOnly", 3.2],
      ],
    );

    assert.equal(both?.dense, 0.77);
    assert.equal(both?.denseRank, 1);
    assert.equal(both?.sparse, 11.4);
    assert.equal(both?.sparseRank, 1);

    assert.equal(denseOnly?.sparse, null);
    assert.equal(denseOnly?.sparseRank, null);
    assert.equal(sparseOnly?.dense, null);
    assert.equal(sparseOnly?.denseRank, null);
  });

  it("breaks a tie on cosine, then on id, so the order never reshuffles", () => {
    // Both chunks are found by exactly one list, at rank 1, so `fused` is equal.
    const fused = fuseRankings([["lowCosine", 0.2]], [["sparseOnly", 30]]);
    assert.equal(fused[0]!.fused, fused[1]!.fused);
    // A real cosine beats no cosine at all.
    assert.equal(fused[0]?.chunkId, "lowCosine");

    const tied = fuseRankings(
      [
        ["b", 0.5],
        ["a", 0.5],
      ],
      [],
    );
    assert.deepEqual(
      tied.map((candidate) => candidate.chunkId),
      ["b", "a"], // rank 1 still outscores rank 2; the ids do not reorder it
    );
  });

  it("respects topN", () => {
    const fused = fuseRankings([["a", 1], ["b", 1], ["c", 1]], [], { topN: 2 });
    assert.equal(fused.length, 2);
  });
});

describe("Retriever", () => {
  it("expands children to parents and sends each parent once", async () => {
    const parts = await fixture();
    const retriever = await Retriever.create(NOTEBOOK, parts);

    const passages = await retriever.retrieve("how are failed charges retried?");

    // Four candidate children collapse to the two parents they belong to.
    assert.deepEqual(
      passages.map((passage) => passage.chunkId),
      ["p1", "p2"],
    );
    // c1, c2 and c3 all live in p1 - it is returned once, not three times.
    assert.equal(passages[0]?.matchCount, 3);
    assert.equal(passages[1]?.matchCount, 1);
    // ...and scored by its best child, which is the one the query is nearest.
    assert.equal(passages[0]?.match.chunkId, "c1");
  });

  it("returns the parent's text and citation, not the matching child's", async () => {
    const parts = await fixture();
    const retriever = await Retriever.create(NOTEBOOK, parts);

    const [passage] = await retriever.retrieve("how are failed charges retried?");

    assert.ok(passage!.text.startsWith("PAYMENTS."));
    assert.equal(passage?.filename, "Schema Notes.pdf");
    assert.equal(passage?.pageStart, 1);
    assert.equal(passage?.pageEnd, 2);
    assert.deepEqual(passage?.headingPath, ["2. BILLING DOMAIN", "Payments"]);
  });

  it("finds an exact identifier the embedder is blind to", async () => {
    const parts = await fixture();
    const retriever = await Retriever.create(NOTEBOOK, parts);

    // `customer_id` embeds to the payments vector here, so the dense search ranks
    // the three payments chunks above it. Capped at three candidates, dense alone
    // would never surface c4 at all - only BM25 puts it in the list.
    const passages = await retriever.retrieve("customer_id", { k: 3 });

    assert.ok(
      passages.some((passage) => passage.chunkId === "p2"),
      "the identifiers passage should be retrieved",
    );
    const identifiers = passages.find((passage) => passage.chunkId === "p2");
    assert.equal(identifiers?.match.chunkId, "c4");
    assert.equal(identifiers?.match.sparseRank, 1, "BM25 should rank it first");
    assert.ok((identifiers?.match.sparse ?? 0) > 0);
  });

  it("returns nothing for an empty notebook, without paying to embed", async () => {
    const parts = await fixture();
    const retriever = await Retriever.create("a-different-notebook", parts);

    assert.deepEqual(await retriever.retrieve("how are failed charges retried?"), []);
    assert.deepEqual(parts.embedder.calls, [], "the embedder should not be called");
  });

  it("returns nothing for a blank question, without paying to embed", async () => {
    const parts = await fixture();
    const retriever = await Retriever.create(NOTEBOOK, parts);

    assert.deepEqual(await retriever.retrieve("   \n  "), []);
    assert.deepEqual(parts.embedder.calls, []);
  });
});

describe("formatPages", () => {
  it("renders a page, a range, and an unknown", () => {
    assert.equal(formatPages(4, 4), "p. 4");
    assert.equal(formatPages(4, null), "p. 4");
    assert.equal(formatPages(4, 5), "p. 4-5");
    assert.equal(formatPages(null, null), "p. ?");
  });
});

describe("a document shared by two notebooks", () => {
  /**
   * Regression test. Chunk and document ids are derived from the file's content
   * hash, so the same PDF added twice shares them. With `document_id` alone as
   * the primary key, adding it to a second notebook silently MOVED it out of the
   * first, and removing it from either deleted the chunks from both.
   */
  it("stays in the first notebook when added to a second", async () => {
    const { store, vectorStore, embedder } = await fixture();
    const second = "other-notebook";

    const children = store.childChunks(NOTEBOOK);
    store.addDocument(second, store.getDocument(DOCUMENT_ID)!);
    const vectors = await embedder.embedDocuments(children.map((child) => child.text));
    vectorStore.add(second, children, vectors, embedder.modelId);

    assert.equal(store.listDocuments(NOTEBOOK).length, 1, "the first notebook keeps it");
    assert.equal(store.listDocuments(second).length, 1);
    assert.equal(store.childChunks(NOTEBOOK).length, 4);
    assert.equal(store.childChunks(second).length, 4);
  });

  it("keeps the shared chunks when removed from only one of them", async () => {
    const { store, vectorStore, embedder } = await fixture();
    const second = "other-notebook";
    const children = store.childChunks(NOTEBOOK);
    store.addDocument(second, store.getDocument(DOCUMENT_ID)!);
    const vectors = await embedder.embedDocuments(children.map((child) => child.text));
    vectorStore.add(second, children, vectors, embedder.modelId);

    const { removed, chunksRemoved } = store.deleteDocument(second, DOCUMENT_ID);
    vectorStore.deleteDocument(DOCUMENT_ID, second);

    assert.equal(removed, true);
    assert.equal(chunksRemoved, false, "another notebook still needs the text");
    assert.equal(store.childChunks(NOTEBOOK).length, 4, "the survivor keeps its chunks");
    assert.equal(store.listDocuments(second).length, 0);

    // ...and the survivor is still searchable, which is the point.
    const retriever = await Retriever.create(NOTEBOOK, { store, vectorStore, embedder });
    const passages = await retriever.retrieve("how are failed charges retried?");
    assert.ok(passages.length > 0, "the first notebook must still return passages");
  });

  it("deletes the chunks when the last notebook holding it removes it", async () => {
    const { store } = await fixture();
    const { removed, chunksRemoved } = store.deleteDocument(NOTEBOOK, DOCUMENT_ID);

    assert.equal(removed, true);
    assert.equal(chunksRemoved, true, "nothing else references it, so reclaim the space");
    assert.equal(store.childChunks(NOTEBOOK).length, 0);
  });
});
