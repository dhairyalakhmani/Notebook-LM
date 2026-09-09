import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import "../src/env.ts";
import type { Chunk, Document } from "../src/models.ts";

const { NotebookStore } = await import("../src/notebook/store.ts");
const { VectorStore } = await import("../src/search/vectorStore.ts");

const NOTEBOOK = "reclaim";
const DOCUMENT_ID = "abcdef012345";

function storageDir(): string {
  return mkdtempSync(join(tmpdir(), "reclaim-"));
}

// The database's real disk cost. In WAL mode the main file can be 4 KB while
// its -wal companion holds megabytes, so measuring the main file alone reports
// nonsense - which is what the first version of this test proved.
function footprint(path: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(path + suffix).size;
    } catch {
      // WAL companions only exist between checkpoints.
    }
  }
  return total;
}

const document: Document = {
  documentId: DOCUMENT_ID,
  title: "Bulk",
  filename: "bulk.pdf",
  sourceType: "pdf",
  pageCount: 10,
  addedAt: new Date().toISOString(),
};

function chunk(index: number): Chunk {
  return {
    documentId: DOCUMENT_ID,
    chunkId: `${DOCUMENT_ID}-c${String(index).padStart(5, "0")}`,
    parentId: null,
    // Big enough that the freed pages are measurable rather than noise.
    text: "lorem ipsum dolor sit amet ".repeat(80),
    tokenCount: 400,
    pageStart: 1,
    pageEnd: 1,
    headingPath: ["Bulk"],
    sectionTitle: "Bulk",
    chunkIndex: index,
    previousChunkId: null,
    nextChunkId: null,
    blockKinds: ["paragraph"],
    boundaryReason: "heading",
  };
}

describe("deleting a source hands disk back to the volume", () => {
  it("shrinks notebook.db, which deleting rows alone does not", () => {
    const directory = storageDir();
    const store = new NotebookStore(directory);
    const path = join(directory, "notebook.db");

    store.addDocument(NOTEBOOK, document);
    store.addChunks(Array.from({ length: 400 }, (_unused, index) => chunk(index)));

    const full = footprint(path);
    assert.ok(full > 200_000, `expected a sizeable database, got ${full} bytes`);

    const { chunksRemoved } = store.deleteDocument(NOTEBOOK, DOCUMENT_ID);
    assert.equal(chunksRemoved, true);

    // The point of the test: the rows are gone and the space is still ours.
    // SQLite marks the pages free for reuse rather than returning them, so a
    // deleted notebook would otherwise occupy the volume for ever.
    const afterDelete = footprint(path);
    assert.ok(
      afterDelete > full / 2,
      `deleting rows should not hand space back, but ${full} became ${afterDelete}`,
    );

    const freed = store.compact();
    const compacted = footprint(path);

    assert.ok(compacted < full / 2, `expected a real reduction, ${full} became ${compacted}`);
    assert.ok(freed > 0, "compact() should report the bytes it handed back");
    assert.equal(freed, afterDelete - compacted, "the reported figure should be the real one");
    store.close();
  });

  it("shrinks vectors.db too", () => {
    const directory = storageDir();
    const vectors = new VectorStore(directory);
    const path = join(directory, "vectors.db");

    const chunks = Array.from({ length: 400 }, (_unused, index) => chunk(index));
    const embedded = chunks.map(() => Array.from({ length: 384 }, () => 0.05));
    vectors.add(NOTEBOOK, chunks, embedded, "test-model");

    const full = footprint(path);
    vectors.deleteDocument(DOCUMENT_ID);
    assert.ok(footprint(path) > full / 2, "deleting rows should not hand space back");

    const freed = vectors.compact();
    assert.ok(footprint(path) < full / 2);
    assert.ok(freed > 0);
    vectors.close();
  });

  it("has nothing left to hand back on a second pass", () => {
    const directory = storageDir();
    const store = new NotebookStore(directory);
    store.addDocument(NOTEBOOK, document);
    store.addChunks(Array.from({ length: 50 }, (_unused, index) => chunk(index)));
    store.deleteDocument(NOTEBOOK, DOCUMENT_ID);

    assert.ok(store.compact() > 0);
    // Idempotent: compacting an already-compact database should not claim to
    // have achieved something.
    assert.equal(store.compact(), 0);
    store.close();
  });
});
