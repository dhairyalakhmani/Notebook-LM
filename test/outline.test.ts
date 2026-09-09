import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NotebookStore } from "../src/notebook/store.ts";
import type { Chunk, Document } from "../src/models.ts";

const NOTEBOOK = "outline-test";
const DOCUMENT_ID = "doc1";

function chunk(overrides: Partial<Chunk> & Pick<Chunk, "chunkId">): Chunk {
  return {
    documentId: DOCUMENT_ID,
    parentId: null,
    text: "body text",
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

function store(): NotebookStore {
  const db = new NotebookStore(mkdtempSync(join(tmpdir(), "outline-")));
  const document: Document = {
    documentId: DOCUMENT_ID,
    title: "Networking",
    filename: "Networking.pdf",
    sourceType: "pdf",
    pageCount: 60,
    addedAt: new Date().toISOString(),
  };
  db.addDocument(NOTEBOOK, document);
  return db;
}

describe("a source's outline", () => {
  it("lists sections in reading order, not page order", () => {
    const db = store();
    db.addChunks([
      chunk({ chunkId: "p1", chunkIndex: 0, pageStart: 10, headingPath: ["1 Introduction"] }),
      chunk({ chunkId: "p2", chunkIndex: 1, pageStart: 9, headingPath: ["2 Delay"] }),
      chunk({ chunkId: "p3", chunkIndex: 2, pageStart: 20, headingPath: ["3 Throughput"] }),
    ]);

    assert.deepEqual(
      db.outline(DOCUMENT_ID).map((section) => section.title),
      ["Introduction", "Delay", "Throughput"],
    );
    db.close();
  });

  it("splits a leading section number out of the title", () => {
    const db = store();
    db.addChunks([chunk({ chunkId: "p1", headingPath: ["1.4.2 Queuing Delay and Packet Loss"] })]);

    const [section] = db.outline(DOCUMENT_ID);
    assert.equal(section?.number, "1.4.2");
    assert.equal(section?.title, "Queuing Delay and Packet Loss");
    db.close();
  });

  it("leaves an unnumbered heading alone", () => {
    const db = store();
    db.addChunks([chunk({ chunkId: "p1", headingPath: ["Normalisation"] })]);

    const [section] = db.outline(DOCUMENT_ID);
    assert.equal(section?.number, null);
    assert.equal(section?.title, "Normalisation");
    db.close();
  });

  it("does not mistake a leading year or figure number for a section number", () => {
    const db = store();
    db.addChunks([
      chunk({ chunkId: "p1", chunkIndex: 0, headingPath: ["2026 in review"] }),
      chunk({ chunkId: "p2", chunkIndex: 1, headingPath: ["1.4"] }),
    ]);

    const outline = db.outline(DOCUMENT_ID);
    assert.equal(outline[1]?.title, "1.4");
    assert.equal(outline[1]?.number, null);
    db.close();
  });

  it("reports depth from the heading path, so the UI need not parse anything", () => {
    const db = store();
    db.addChunks([
      chunk({ chunkId: "p1", chunkIndex: 0, headingPath: ["1 Chapter"] }),
      chunk({ chunkId: "p2", chunkIndex: 1, headingPath: ["1 Chapter", "1.1 Section"] }),
      chunk({
        chunkId: "p3",
        chunkIndex: 2,
        headingPath: ["1 Chapter", "1.1 Section", "1.1.1 Part"],
      }),
    ]);

    assert.deepEqual(
      db.outline(DOCUMENT_ID).map((section) => section.depth),
      [1, 2, 3],
    );
    db.close();
  });

  it("names the deepest heading, not the whole path", () => {
    const db = store();
    db.addChunks([
      chunk({ chunkId: "p1", headingPath: ["3 Transport Layer", "3.5 TCP", "3.5.4 Flow Control"] }),
    ]);

    const [section] = db.outline(DOCUMENT_ID);
    assert.equal(section?.title, "Flow Control");
    assert.equal(section?.number, "3.5.4");
    db.close();
  });

  it("ignores children, so a split section is listed once", () => {
    const db = store();
    db.addChunks([
      chunk({ chunkId: "p1", chunkIndex: 0, headingPath: ["1 Introduction"] }),
      chunk({ chunkId: "c1", parentId: "p1", chunkIndex: 0, headingPath: ["1 Introduction"] }),
      chunk({ chunkId: "c2", parentId: "p1", chunkIndex: 1, headingPath: ["1 Introduction"] }),
      chunk({ chunkId: "c3", parentId: "p1", chunkIndex: 2, headingPath: ["1 Introduction"] }),
    ]);

    assert.equal(db.outline(DOCUMENT_ID).length, 1);
    db.close();
  });

  it("skips text that appears before the first heading", () => {
    const db = store();
    db.addChunks([
      chunk({ chunkId: "p0", chunkIndex: 0, headingPath: [] }),
      chunk({ chunkId: "p1", chunkIndex: 1, headingPath: ["1 Introduction"] }),
    ]);

    assert.deepEqual(
      db.outline(DOCUMENT_ID).map((section) => section.title),
      ["Introduction"],
    );
    db.close();
  });

  it("reports the first page a section's text appears on", () => {
    const db = store();
    db.addChunks([
      chunk({
        chunkId: "p1",
        chunkIndex: 0,
        pageStart: 46,
        pageEnd: 48,
        headingPath: ["1.4 Delay"],
      }),
      chunk({
        chunkId: "p2",
        chunkIndex: 1,
        pageStart: 44,
        pageEnd: 45,
        headingPath: ["1.4 Delay"],
      }),
    ]);

    const [section] = db.outline(DOCUMENT_ID);
    assert.equal(section?.page, 44, "the earliest page of the section, not the first chunk's");
    db.close();
  });

  it("survives a format with no page numbers", () => {
    const db = store();
    db.addChunks([
      chunk({ chunkId: "p1", pageStart: null, pageEnd: null, headingPath: ["Normalisation"] }),
    ]);

    const [section] = db.outline(DOCUMENT_ID);
    assert.equal(section?.page, null);
    db.close();
  });

  it("is empty for a document with no chunks", () => {
    const db = store();
    assert.deepEqual(db.outline(DOCUMENT_ID), []);
    assert.deepEqual(db.outline("no-such-document"), []);
    db.close();
  });
});
