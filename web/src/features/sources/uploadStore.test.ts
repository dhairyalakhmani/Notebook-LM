import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUploads, startUpload, uploadSnapshot, subscribeUploads } from "./uploadStore.ts";
import type { QueryClient } from "@tanstack/react-query";

function sse(events: unknown[], { terminate = true } = {}): string {
  const frames = events.map(
    (event, index) => `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`,
  );
  frames.splice(1, 0, ": ping\n\n");
  return `retry: 2000\n\n` + frames.join("") + (terminate ? "event: done\ndata: {}\n\n" : "");
}

const SOURCE = {
  id: "aaaaaaaaaaaa",
  kind: "pdf" as const,
  filename: "notes.pdf",
  title: "notes",
  pages: 12,
  bytes: 2048,
  addedAt: "2026-01-01T00:00:00.000Z",
  fileUrl: "/api/sources/aaaaaaaaaaaa/file",
  stats: null,
};

let streamBody = "";
let uploadReply: Record<string, unknown> = { status: "accepted", jobId: "job-1" };
let uploadStatus = 200;
const received: { filename: string | null; bytes: number }[] = [];

const server = setupServer(
  http.post("/api/notebooks/:name/sources", async ({ request }) => {
    const url = new URL(request.url);
    received.push({
      filename: url.searchParams.get("filename"),
      bytes: (await request.arrayBuffer()).byteLength,
    });
    return HttpResponse.json(uploadReply, { status: uploadStatus });
  }),
  http.get(
    "/api/ingest/:jobId/events",
    () => new HttpResponse(streamBody, { headers: { "Content-Type": "text/event-stream" } }),
  ),
  http.delete("/api/ingest/:jobId", () => HttpResponse.json({ cancelled: true })),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());
beforeEach(() => {
  resetUploads();
  received.length = 0;
  uploadReply = { status: "accepted", jobId: "job-1" };
  uploadStatus = 200;
  streamBody = "";
});

const client = {} as QueryClient;
const file = (name = "notes.pdf", size = 2048) =>
  new File([new Uint8Array(size)], name, { type: "application/pdf" });

const one = () => uploadSnapshot()[0]!;

describe("startUpload", () => {
  it("sends the file as a raw body with the filename in the query string", async () => {
    // Not multipart, which is what let the server stay dependency-free.
    streamBody = sse([{ type: "done", source: SOURCE }]);
    await startUpload({
      notebook: "demo",
      file: file("my notes.pdf"),
      client,
      onSettled: () => {},
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.filename).toBe("my notes.pdf");
    expect(received[0]?.bytes).toBeGreaterThan(0);
  });

  it("follows the stream to a finished source", async () => {
    streamBody = sse([
      { type: "stage", stage: "extract", status: "start" },
      { type: "stage", stage: "extract", status: "done", ms: 18_400 },
      { type: "done", source: SOURCE },
    ]);
    await startUpload({ notebook: "demo", file: file(), client, onSettled: () => {} });

    const state = one().state;
    expect(state.status).toBe("succeeded");
    if (state.status === "succeeded") expect(state.source.id).toBe(SOURCE.id);
  });

  it("reports progress only within a stage that can count its steps", async () => {
    streamBody = sse(
      [
        { type: "stage", stage: "embed", status: "start" },
        { type: "progress", stage: "embed", done: 3, total: 12 },
      ],
      { terminate: false },
    );
    await startUpload({ notebook: "demo", file: file(), client, onSettled: () => {} });

    const state = one().state;
    expect(state.status).toBe("failed");
  });

  it("resets the counter when a new stage begins", async () => {
    streamBody = sse(
      [
        { type: "stage", stage: "extract", status: "start" },
        { type: "progress", stage: "extract", done: 775, total: 775 },
        { type: "stage", stage: "chunk", status: "start" },
      ],
      { terminate: false },
    );
    await startUpload({ notebook: "demo", file: file(), client, onSettled: () => {} });
    expect(one().state.status).toBe("failed");
  });

  it("treats an already-added file as a success, with no job to follow", async () => {
    uploadReply = { status: "already-added", source: SOURCE };
    const settled = vi.fn();
    await startUpload({ notebook: "demo", file: file(), client, onSettled: settled });

    expect(one().state.status).toBe("duplicate");
    expect(settled).toHaveBeenCalledWith("demo");
    // No stream was requested, because there is no work to watch.
  });

  it("keeps a needs-OCR outcome distinct from a failure", async () => {
    streamBody = sse([{ type: "needs-ocr", reasons: ["no text layer", "0 chars/page"] }]);
    await startUpload({ notebook: "demo", file: file(), client, onSettled: () => {} });

    const state = one().state;
    expect(state.status).toBe("needs-ocr");
    if (state.status === "needs-ocr") expect(state.reasons).toContain("no text layer");
  });

  it("surfaces a server error from the stream", async () => {
    streamBody = sse([
      { type: "error", error: { code: "internal", message: "the PDF is encrypted" } },
    ]);
    await startUpload({ notebook: "demo", file: file(), client, onSettled: () => {} });

    const state = one().state;
    expect(state.status).toBe("failed");
    if (state.status === "failed") {
      expect(state.error.message).toContain("encrypted");
      expect(state.canRetry).toBe(true);
    }
  });

  it("fails without uploading when the file is over the limit", async () => {
    const huge = new File([new Uint8Array(8)], "huge.pdf");
    Object.defineProperty(huge, "size", { value: 300 * 1024 * 1024 });
    await startUpload({ notebook: "demo", file: huge, client, onSettled: () => {} });

    const state = one().state;
    expect(state.status).toBe("failed");
    if (state.status === "failed") {
      expect(state.error.kind).toBe("too-large");
      expect(state.canRetry).toBe(false);
    }
    expect(received).toHaveLength(0);
  });

  it("maps an unsupported type to its own error kind", async () => {
    uploadStatus = 415;
    uploadReply = {
      error: { code: "unsupported_type", message: "'.exe' is not a supported source." },
    };
    await startUpload({ notebook: "demo", file: file("virus.exe"), client, onSettled: () => {} });

    const state = one().state;
    expect(state.status).toBe("failed");
    if (state.status === "failed") expect(state.error.kind).toBe("unsupported-file");
  });

  it("says so when the stream ends with no outcome", async () => {
    // The server went away mid-ingest. Silence is not success.
    streamBody = sse([{ type: "stage", stage: "chunk", status: "start" }], { terminate: false });
    await startUpload({ notebook: "demo", file: file(), client, onSettled: () => {} });

    const state = one().state;
    expect(state.status).toBe("failed");
    if (state.status === "failed") expect(state.error.kind).toBe("network");
  });

  it("notifies subscribers as it goes", async () => {
    const seen: string[] = [];
    const stop = subscribeUploads(() => seen.push(uploadSnapshot()[0]?.state.status ?? "gone"));
    streamBody = sse([
      { type: "stage", stage: "extract", status: "start" },
      { type: "done", source: SOURCE },
    ]);
    await startUpload({ notebook: "demo", file: file(), client, onSettled: () => {} });
    stop();

    expect(seen).toContain("running");
    expect(seen.at(-1)).toBe("succeeded");
  });

  it("keeps uploads for different notebooks apart", async () => {
    streamBody = sse([{ type: "done", source: SOURCE }]);
    await startUpload({ notebook: "one", file: file("a.pdf"), client, onSettled: () => {} });
    await startUpload({ notebook: "two", file: file("b.pdf"), client, onSettled: () => {} });

    const all = uploadSnapshot();
    expect(all).toHaveLength(2);
    expect(all.filter((upload) => upload.notebook === "one")).toHaveLength(1);
  });
});
