import { useSyncExternalStore } from "react";
import { asApiError, requestQuietly, requestStream, requestUpload } from "../../shared/lib/http.ts";
import { MAX_UPLOAD_BYTES } from "../../types.ts";
import type { QueryClient } from "@tanstack/react-query";
import type { ApiError } from "../../shared/lib/http.ts";
import type { IngestEventDto, IngestStageDto, SourceDto, UploadResponseDto } from "../../types.ts";

export type UploadState =
  | { status: "hashing" }
  | {
      status: "running";
      stage: IngestStageDto | null;
      done: number | null;
      total: number | null;
      note: string | null;
      queued: number | null;
    }
  | { status: "succeeded"; source: SourceDto }
  | { status: "duplicate"; source: SourceDto }
  | { status: "needs-ocr"; reasons: readonly string[] }
  | { status: "no-text" }
  | { status: "cancelled" }
  | { status: "failed"; error: ApiError; canRetry: boolean };

export interface Upload {
  id: string;
  notebook: string;
  filename: string;
  bytes: number;
  jobId: string | null;
  state: UploadState;
}

const uploads = new Map<string, Upload>();
const listeners = new Set<() => void>();
let snapshot: readonly Upload[] = [];

function publish(): void {
  snapshot = [...uploads.values()];
  for (const listener of listeners) listener();
}

function set(id: string, state: UploadState): void {
  const upload = uploads.get(id);
  if (!upload) return;
  uploads.set(id, { ...upload, state });
  publish();
}

export function subscribeUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function uploadSnapshot(): readonly Upload[] {
  return snapshot;
}

export function dismissUpload(id: string): void {
  uploads.delete(id);
  publish();
}

export function resetUploads(): void {
  uploads.clear();
  publish();
}

async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<IngestEventDto> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");

      // `: ping` is the heartbeat, and `event: done` is the terminator.
      if (frame.startsWith(":")) continue;
      if (frame.includes("event: done")) return;

      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (data === "" || data === "{}") continue;
      try {
        yield JSON.parse(data) as IngestEventDto;
      } catch {
        // Skip a malformed frame rather than abort a long ingest's progress.
      }
    }
  }
}

function terminalState(event: IngestEventDto): UploadState | null {
  switch (event.type) {
    case "done":
      return { status: "succeeded", source: event.source };
    case "already-added":
      return { status: "duplicate", source: event.source };
    case "needs-ocr":
      return { status: "needs-ocr", reasons: event.reasons };
    case "no-text":
      return { status: "no-text" };
    case "cancelled":
      return { status: "cancelled" };
    case "error":
      return {
        status: "failed",
        error: { kind: "server", message: event.error.message },
        canRetry: true,
      };
    case "queued":
    case "stage":
    case "progress":
    case "log":
      return null;
  }
}

export interface StartOptions {
  notebook: string;
  file: File;
  client: QueryClient;
  onSettled: (notebook: string) => void;
}

export async function startUpload({ notebook, file, onSettled }: StartOptions): Promise<string> {
  const id = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  uploads.set(id, {
    id,
    notebook,
    filename: file.name,
    bytes: file.size,
    jobId: null,
    state: { status: "hashing" },
  });
  publish();

  if (file.size > MAX_UPLOAD_BYTES) {
    set(id, {
      status: "failed",
      error: { kind: "too-large", message: `${file.name} is larger than the 200 MB limit.` },
      canRetry: false,
    });
    return id;
  }

  try {
    const accepted = await postFile(notebook, file);

    if (accepted.status === "already-added") {
      set(id, { status: "duplicate", source: accepted.source });
      onSettled(notebook);
      return id;
    }

    uploads.set(id, { ...uploads.get(id)!, jobId: accepted.jobId });
    set(id, {
      status: "running",
      stage: null,
      done: null,
      total: null,
      note: null,
      queued: null,
    });

    await follow(id, accepted.jobId, notebook, onSettled);
  } catch (error) {
    const failure = asApiError(error);
    set(id, {
      status: "failed",
      error: failure,
      canRetry: failure.kind === "network" || failure.kind === "server",
    });
  }
  return id;
}

async function postFile(notebook: string, file: File): Promise<UploadResponseDto> {
  return requestUpload<UploadResponseDto>(
    `/api/notebooks/${encodeURIComponent(notebook)}/sources` +
      `?filename=${encodeURIComponent(file.name)}`,
    file,
  );
}

async function follow(
  id: string,
  jobId: string,
  notebook: string,
  onSettled: (notebook: string) => void,
): Promise<void> {
  const body = await requestStream(`/api/ingest/${jobId}/events`);

  let current: UploadState = {
    status: "running",
    stage: null,
    done: null,
    total: null,
    note: null,
    queued: null,
  };

  for await (const event of readEvents(body)) {
    const terminal = terminalState(event);
    if (terminal) {
      set(id, terminal);
      onSettled(notebook);
      if (terminal.status === "succeeded" || terminal.status === "duplicate") {
        setTimeout(() => dismissUpload(id), 6000);
      }
      return;
    }

    if (current.status !== "running") continue;

    switch (event.type) {
      case "queued":
        current = { ...current, queued: event.position };
        break;
      case "stage":
        current = {
          ...current,
          stage: event.stage,
          done: null,
          total: null,
          queued: null,
        };
        break;
      case "progress":
        current = { ...current, stage: event.stage, done: event.done, total: event.total };
        break;
      case "log":
        current = { ...current, note: event.message };
        break;
      case "done":
      case "already-added":
      case "needs-ocr":
      case "no-text":
      case "cancelled":
      case "error":
        break;
    }
    set(id, current);
  }

  // The stream ended without a terminal event: the server went away.
  set(id, {
    status: "failed",
    error: { kind: "network", message: "the connection dropped before the ingest finished" },
    canRetry: true,
  });
}

export async function cancelUpload(id: string): Promise<void> {
  const upload = uploads.get(id);
  if (!upload?.jobId) return;
  await requestQuietly(`/api/ingest/${upload.jobId}`, "DELETE");
}

export function useUploads(notebook: string): readonly Upload[] {
  const all = useSyncExternalStore(subscribeUploads, uploadSnapshot, uploadSnapshot);
  return all.filter((upload) => upload.notebook === notebook);
}
