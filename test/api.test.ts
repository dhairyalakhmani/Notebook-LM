import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type {
  ApiErrorDto,
  NotebookDto,
  NotebookSummaryDto,
  OutlineSectionDto,
} from "../src/api/dto.ts";

const STORAGE = mkdtempSync(join(tmpdir(), "api-"));
process.env["NOTEBOOK_STORAGE_DIR"] = STORAGE;

let server: Server;
let base: string;
let close: () => void;

const DOC = "a1b2c3d4e5f6";
const ORPHAN = "0123456789ab";

before(async () => {
  const { NotebookStore } = await import("../src/notebook/store.ts");
  const { handleApi } = await import("../src/api/router.ts");
  const { registerReadRoutes } = await import("../src/api/handlers.ts");
  const services = await import("../src/api/services.ts");
  close = services.closeServices;

  mkdirSync(join(STORAGE, "sources"), { recursive: true });
  writeFileSync(join(STORAGE, "sources", `${DOC}.pdf`), "%PDF-1.6\n" + "x".repeat(1000));

  const store = new NotebookStore(STORAGE);

  store.addDocument(
    "demo",
    {
      documentId: DOC,
      title: "Delay Notes",
      filename: "Delay Notes.pdf",
      sourceType: "pdf",
      pageCount: 12,
      addedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      sourcePath: `sources/${DOC}.pdf`,
      byteSize: 1009,
      stats: {
        blocks: 6,
        units: 3,
        sections: 2,
        passages: 4,
        structureScore: 0.5,
        tokenSplitChunks: 0,
        segmenters: ["structural"],
        stages: [
          { stage: "extract", ms: 10 },
          { stage: "store", ms: 2 },
        ],
        embedModel: "BAAI/bge-small-en-v1.5",
      },
    },
  );

  store.addDocument("demo", {
    documentId: ORPHAN,
    title: "Orphan",
    filename: "Orphan.md",
    sourceType: "md",
    pageCount: 1,
    addedAt: "2026-01-02T00:00:00.000Z",
  });

  store.addChunks([
    {
      chunkId: `${DOC}-p0001`,
      documentId: DOC,
      parentId: null,
      text: "Queuing delay is the time a packet waits.",
      tokenCount: 12,
      pageStart: 3,
      pageEnd: 4,
      headingPath: ["1.4 Delay"],
      sectionTitle: "1.4 Delay",
      chunkIndex: 0,
      previousChunkId: null,
      nextChunkId: null,
      blockKinds: ["paragraph"],
      boundaryReason: "heading",
    },
  ]);

  store.addMessage({
    notebook: "demo",
    role: "user",
    text: "what is queuing delay?",
    createdAt: "2026-01-03T00:00:00.000Z",
    citations: [],
    resolvedQuestion: null,
  });
  store.addMessage({
    notebook: "demo",
    role: "assistant",
    text: "Queuing delay is the wait before transmission [1].",
    createdAt: "2026-01-03T00:00:01.000Z",
    citations: [
      {
        marker: 1,
        filename: "Delay Notes.pdf",
        pageStart: 3,
        pageEnd: 4,
        headingPath: ["1.4 Delay"],
        sourceId: DOC,
        quote: "Queuing delay is the time a packet waits.",
      },
    ],
    passages: [
      {
        marker: 1,
        documentId: DOC,
        filename: "Delay Notes.pdf",
        pageStart: 3,
        pageEnd: 4,
        headingPath: ["1.4 Delay"],
        cosine: 0.81,
        bm25: null,
        denseRank: 1,
        sparseRank: null,
        fused: 0.5,
        matchCount: 2,
        cited: true,
      },
    ],
    resolvedQuestion: null,
  });

  // A refusal too, so more than one outcome of the union is exercised.
  store.addMessage({
    notebook: "demo",
    role: "user",
    text: "how does QUIC work?",
    createdAt: "2026-01-04T00:00:00.000Z",
    citations: [],
    resolvedQuestion: null,
  });
  store.addMessage({
    notebook: "demo",
    role: "assistant",
    text: "The sources provided don't cover this.",
    createdAt: "2026-01-04T00:00:01.000Z",
    citations: [],
    resolvedQuestion: null,
  });
  store.close();

  registerReadRoutes();
  server = createServer((request, response) => {
    void handleApi(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  close?.();
  server?.close();
});

async function get<T>(path: string): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // A binary or plain-text body; the caller checks the status instead.
  }
  return { status: response.status, body: body as T, headers: response.headers };
}

const notebook = () => get<NotebookDto>("/api/notebooks/demo");

describe("GET /api/notebooks", () => {
  it("lists the notebook with its source and page counts", async () => {
    const { status, body } = await get<{ notebooks: NotebookSummaryDto[] }>("/api/notebooks");
    assert.equal(status, 200);
    const demo = body.notebooks.find((summary) => summary.name === "demo");
    assert.ok(demo);
    assert.equal(demo.sources, 2);
    assert.equal(demo.pages, 13);
    assert.equal(demo.lastMessageAt, "2026-01-04T00:00:01.000Z");
  });
});

describe("GET /api/notebooks/:notebook", () => {
  it("returns raw bytes and ISO dates, not pre-formatted strings", async () => {
    const { body } = await notebook();
    const source = body.sources.find((candidate) => candidate.id === DOC);
    assert.ok(source);
    assert.equal(source.bytes, 1009);
    assert.equal(source.addedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(source.pages, 12);
    assert.equal(source.kind, "pdf");
  });

  it("gives fileUrl only when the bytes are actually on disk", async () => {
    const { body } = await notebook();
    const kept = body.sources.find((candidate) => candidate.id === DOC);
    const orphan = body.sources.find((candidate) => candidate.id === ORPHAN);
    assert.equal(kept?.fileUrl, `/api/sources/${DOC}/file`);
    assert.equal(orphan?.fileUrl, null, "a missing file must not get a URL that 404s");
  });

  it("reports missing ingest stats as null, not as zeroes", async () => {
    const { body } = await notebook();
    const kept = body.sources.find((candidate) => candidate.id === DOC);
    const orphan = body.sources.find((candidate) => candidate.id === ORPHAN);
    assert.equal(kept?.stats?.sections, 2);
    assert.equal(kept?.stats?.passages, 4);
    assert.equal(orphan?.stats, null, "zeroes would read as a real measurement");
  });

  it("pairs messages into turns, keeping question and answer together", async () => {
    const { body } = await notebook();
    assert.equal(body.turns.length, 2);
    const turn = body.turns[0];
    assert.ok(turn);
    assert.equal(turn.question.text, "what is queuing delay?");
    assert.equal(turn.kind, "answer");
  });

  it("carries the citation's document and quote through to the wire", async () => {
    const { body } = await notebook();
    const turn = body.turns[0];
    assert.ok(turn && turn.kind === "answer");
    const [citation] = turn.citations;
    assert.equal(citation.sourceId, DOC);
    assert.equal(citation.pageLabel, "p. 3-4");
    assert.equal(citation.quote, "Queuing delay is the time a packet waits.");
    // A starting point only: the browser narrows it in the rendered text layer.
    assert.equal(citation.page, 3);
  });

  it("keeps a null cosine null, because a BM25-only hit has none", async () => {
    const { body } = await notebook();
    const turn = body.turns[0];
    assert.ok(turn && turn.kind === "answer");
    const passage = turn.passages[0];
    assert.ok(passage);
    assert.equal(passage.cosine, 0.81);
    assert.equal(passage.bm25, null);
    assert.equal(passage.sparseRank, null, "0 would claim it ranked first");
    assert.equal(passage.cited, true);
  });

  it("classifies a refusal as a refusal, not as an answer", async () => {
    const { body } = await notebook();
    const turn = body.turns[1];
    assert.ok(turn);
    assert.equal(turn.kind, "refusal");
    if (turn.kind !== "refusal") return;
    assert.equal(turn.reason, "model");
    // The union carries `refusalText`, so nothing can read `.text` and get "".
    assert.match(turn.refusalText, /don't cover this/);
    assert.ok(!("text" in turn));
  });

  it("404s an unknown notebook", async () => {
    const { status, body } = await get<ApiErrorDto>("/api/notebooks/nosuchnotebook");
    assert.equal(status, 404);
    assert.equal(body.error.code, "not_found");
  });
});

describe("GET /api/sources/:id/outline", () => {
  it("returns sections with the number split from the title", async () => {
    const { body } = await get<{ sections: OutlineSectionDto[] }>(`/api/sources/${DOC}/outline`);
    assert.deepEqual(body.sections, [{ number: "1.4", title: "Delay", page: 3, depth: 1 }]);
  });

  it("404s an unknown source", async () => {
    const { status } = await get<ApiErrorDto>("/api/sources/ffffffffffff/outline");
    assert.equal(status, 404);
  });
});

describe("GET /api/sources/:id/file", () => {
  it("serves the bytes with Accept-Ranges, so pdf.js knows it can seek", async () => {
    const response = await fetch(`${base}/api/sources/${DOC}/file`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-length"), "1009");
  });

  it("honours a Range request", async () => {
    const response = await fetch(`${base}/api/sources/${DOC}/file`, {
      headers: { Range: "bytes=0-7" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 0-7/1009");
    assert.equal(await response.text(), "%PDF-1.6");
  });

  it("answers 416 for a range past the end, rather than the whole file", async () => {
    // A 200 with the full body here would make pdf.js read all 19.7 MB.
    const response = await fetch(`${base}/api/sources/${DOC}/file`, {
      headers: { Range: "bytes=99999-999999" },
    });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */1009");
  });

  it("distinguishes an unknown source from one with no file kept", async () => {
    const unknown = await get<ApiErrorDto>("/api/sources/ffffffffffff/file");
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error.message, /no source/);

    const orphan = await get<ApiErrorDto>(`/api/sources/${ORPHAN}/file`);
    assert.equal(orphan.status, 404);
    assert.match(orphan.body.error.message, /relink/, "the fixable case should name the fix");
  });
});

describe("the router", () => {
  it("404s an unknown /api path as JSON, not as the app shell", async () => {
    const { status, body } = await get<ApiErrorDto>("/api/not-a-route");
    assert.equal(status, 404);
    assert.equal(body.error.code, "not_found");
  });

  it("405s a known path with the wrong method, and says what is allowed", async () => {
    const response = await fetch(`${base}/api/notebooks`, { method: "DELETE" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  });

  it("rejects a document id that is not 12 hex characters", async () => {
    const { status, body } = await get<ApiErrorDto>("/api/sources/NOTHEX/outline");
    assert.equal(status, 400);
    assert.match(body.error.message, /12 hex characters/);
  });

  it("refuses a path-traversal attempt through a document id", async () => {
    for (const attempt of [
      "/api/sources/..%2F..%2F..%2F.env/file",
      "/api/sources/..%2f..%2fstorage%2fnotebook.db/file",
      "/api/sources/%2e%2e%2f%2e%2e%2f.env/outline",
    ]) {
      const { status, body } = await get<ApiErrorDto>(attempt);
      assert.ok(status === 400 || status === 404, `${attempt} returned ${status}`);
      assert.equal(typeof body, "object", "must answer JSON, never a file");
    }
  });

  it("rejects an invalid notebook name", async () => {
    const { status } = await get<ApiErrorDto>("/api/notebooks/UPPER%20CASE!");
    assert.ok(status === 400 || status === 404);
  });

  it("clamps an out-of-range turn limit instead of failing", async () => {
    const { status, body } = await get<NotebookDto>("/api/notebooks/demo?turns=99999");
    assert.equal(status, 200);
    assert.equal(body.totalTurns, 2);
  });

  it("names a non-numeric query parameter rather than silently defaulting", async () => {
    const { status, body } = await get<ApiErrorDto>("/api/notebooks/demo?turns=abc");
    assert.equal(status, 400);
    assert.match(body.error.message, /must be a number/);
  });

  it("sends no-store, because every response is derived from mutable state", async () => {
    const { headers } = await get<NotebookDto>("/api/notebooks");
    assert.equal(headers.get("cache-control"), "no-store");
  });
});
