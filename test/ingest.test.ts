import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import "../src/env.ts";
import type {
  ApiErrorDto,
  DeleteSourceDto,
  IngestJobDto,
  NotebookDto,
  NotebookSummaryDto,
} from "../src/api/dto.ts";

const STORAGE = mkdtempSync(join(tmpdir(), "ingest-"));
process.env["NOTEBOOK_STORAGE_DIR"] = STORAGE;

const CAN_EMBED = Boolean(process.env["HF_TOKEN"] ?? process.env["HUGGINGFACE_TOKEN"]);
const skip = CAN_EMBED ? false : "needs HF_TOKEN: a real ingest calls the embedding provider";

let server: Server;
let base: string;
let stop: () => void;

const MARKDOWN =
  "# Delay\n\nQueuing delay is the time a packet waits in a router buffer " +
  "before it can be transmitted onto the outgoing link.\n\n" +
  "# Throughput\n\nThroughput is the rate at which bits are delivered " +
  "between a sender and a receiver across the network path.\n";

before(async () => {
  const { handleApi } = await import("../src/api/router.ts");
  const { registerReadRoutes, registerWriteRoutes } = await import("../src/api/handlers.ts");
  const services = await import("../src/api/services.ts");
  const { stopAllJobs } = await import("../src/api/jobs.ts");

  stop = () => {
    stopAllJobs();
    services.closeServices();
  };

  registerReadRoutes();
  registerWriteRoutes();

  server = createServer((request, response) => {
    void handleApi(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  stop?.();
  server?.close();
});

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON; the caller checks the status.
  }
  return { status: response.status, body: body as T };
}

async function send<T>(
  path: string,
  method: "POST" | "DELETE",
  options: { json?: unknown; raw?: string } = {},
): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method };
  if (options.raw !== undefined) {
    init.headers = { "Content-Type": "application/octet-stream" };
    init.body = options.raw;
  } else if (options.json !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: response.status, body: body as T };
}

async function upload(
  notebook: string,
  filename: string,
  raw?: string,
): Promise<{ status: number; body: { status?: string; jobId?: string } }> {
  return send(
    `/api/notebooks/${notebook}/sources?filename=${encodeURIComponent(filename)}`,
    "POST",
    {
      raw:
        raw ??
        `${MARKDOWN}

Belongs to the ${notebook} notebook.
`,
    },
  );
}

async function settle(jobId: string, timeoutMs = 60_000): Promise<IngestJobDto> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await get<IngestJobDto>(`/api/ingest/${jobId}`);
    if (body.finishedAt !== null) return body;
    if (Date.now() > deadline) throw new Error(`job ${jobId} never finished`);
    await new Promise((wake) => setTimeout(wake, 150));
  }
}

describe("uploading a source", { skip }, () => {
  it("rejects a file type the loaders cannot read", async () => {
    const { status, body } = await upload("demo", "virus.exe", "MZ");
    assert.equal(status, 415);
    assert.equal((body as unknown as ApiErrorDto).error.code, "unsupported_type");
    // Names what IS accepted, so the reader knows what to do instead.
    assert.match((body as unknown as ApiErrorDto).error.message, /\.pdf/);
  });

  it("requires a filename", async () => {
    const { status, body } = await send<ApiErrorDto>("/api/notebooks/demo/sources", "POST", {
      raw: "hello",
    });
    assert.equal(status, 400);
    assert.match(body.error.message, /filename/);
  });

  it("refuses an empty upload", async () => {
    const { status, body } = await send<ApiErrorDto>(
      "/api/notebooks/demo/sources?filename=empty.md",
      "POST",
      { raw: "" },
    );
    assert.equal(status, 400);
    assert.match(body.error.message, /empty/);
  });

  it("never lets a filename become a path", async () => {
    for (const attempt of ["..%2F..%2F..%2Fescaped.md", "%2Fetc%2Fpasswd.md", "a%2Fb%2Fc.md"]) {
      const { status } = await send<unknown>(
        `/api/notebooks/demo/sources?filename=${attempt}`,
        "POST",
        { raw: MARKDOWN },
      );
      assert.ok(status === 201 || status === 200, `${attempt} -> ${status}`);
    }

    assert.equal(existsSync(join(STORAGE, "..", "escaped.md")), false);
    for (const name of readdirSync(join(STORAGE, "sources"))) {
      assert.match(name, /^[0-9a-f]{12}\.[a-z]+$/, `${name} is not content-addressed`);
    }
  });

  it("keeps the name the reader uploaded, not the hash", async () => {
    const accepted = await upload("named", "my lecture notes.md");
    assert.equal(accepted.body.status, "accepted");
    await settle(accepted.body.jobId!);

    const { body } = await get<NotebookDto>("/api/notebooks/named");
    assert.equal(body.sources[0]?.filename, "my lecture notes.md");
    assert.equal(body.sources[0]?.title, "my lecture notes");
  });

  it("answers a duplicate immediately, without queueing work", async () => {
    const same = `${MARKDOWN}

Uploaded twice on purpose.
`;
    const first = await upload("dupes", "notes.md", same);
    assert.equal(first.body.status, "accepted");
    await settle(first.body.jobId!);

    const second = await upload("dupes", "notes.md", same);
    assert.equal(second.body.status, "already-added");
    assert.equal(second.body.jobId, undefined, "a duplicate must not start a job");
  });

  it("records real ingest statistics", async () => {
    const accepted = await upload("stats", "stats.md");
    await settle(accepted.body.jobId!);

    const { body } = await get<NotebookDto>("/api/notebooks/stats");
    const stats = body.sources[0]?.stats;
    assert.ok(stats, "no statistics were recorded");
    assert.ok(stats.passages > 0, "no passages");
    assert.ok(stats.stages.length > 0, "no stage timings");
    assert.ok(stats.stages.some((stage) => stage.stage === "store"));
    assert.equal(stats.embedModel.length > 0, true);
  });

  it("leaves the ingested file on disk", async () => {
    const accepted = await upload("survives", "survives.md");
    await settle(accepted.body.jobId!);

    const { body } = await get<NotebookDto>("/api/notebooks/survives");
    const source = body.sources[0];
    assert.ok(source);
    assert.ok(source.fileUrl, "fileUrl is null, so no file was kept");

    const served = await fetch(`${base}${source.fileUrl}`);
    assert.equal(served.status, 200, "the kept file cannot be read back");
  });
});

describe("ingest progress", { skip }, () => {
  it("keeps every event, so a reload replays the whole run", async () => {
    const accepted = await upload("replay", "replay.md");
    const job = await settle(accepted.body.jobId!);

    assert.equal(job.status, "done");
    const kinds = new Set(job.events.map((event) => event.type));
    assert.ok(kinds.has("stage"), "no stage events were kept");
    assert.ok(kinds.has("done"));
  });

  it("streams the events and terminates deliberately", async () => {
    const accepted = await upload("stream", "stream.md");
    await settle(accepted.body.jobId!);

    const response = await fetch(`${base}/api/ingest/${accepted.body.jobId!}/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const text = await response.text();
    assert.match(text, /"type":"stage"/);
    // The terminator. Without it an EventSource would reconnect forever.
    assert.match(text, /event: done/);
  });

  it("replays only what was missed, from Last-Event-ID", async () => {
    const accepted = await upload("resume", "resume.md");
    await settle(accepted.body.jobId!);

    const whole = await (await fetch(`${base}/api/ingest/${accepted.body.jobId!}/events`)).text();
    const tail = await (
      await fetch(`${base}/api/ingest/${accepted.body.jobId!}/events`, {
        headers: { "Last-Event-ID": "3" },
      })
    ).text();

    assert.ok(tail.length < whole.length, "Last-Event-ID replayed everything");
    assert.match(tail, /event: done/, "a resumed stream must still terminate");
  });

  it("404s an unknown job", async () => {
    assert.equal((await get<ApiErrorDto>("/api/ingest/not-a-job")).status, 404);
    assert.equal((await get<ApiErrorDto>("/api/ingest/not-a-job/events")).status, 404);
  });

  it("lists a notebook's jobs, so a reload can find one without the id", async () => {
    const accepted = await upload("listjobs", "listjobs.md");
    await settle(accepted.body.jobId!);

    const { body } = await get<{ jobs: IngestJobDto[] }>("/api/notebooks/listjobs/ingests");
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0]?.filename, "listjobs.md");
  });
});

describe("deleting a source", { skip }, () => {
  it("keeps the chunks and the file when another notebook shares the document", async () => {
    const shared = `${MARKDOWN}

Deliberately shared between notebooks.
`;
    const first = await upload("holdera", "shared.md", shared);
    await settle(first.body.jobId!);
    const second = await upload("holderb", "shared.md", shared);
    if (second.body.status === "accepted") await settle(second.body.jobId!);

    const holderA = await get<NotebookDto>("/api/notebooks/holdera");
    const id = holderA.body.sources[0]?.id;
    assert.ok(id);

    const removed = await send<DeleteSourceDto>(`/api/notebooks/holdera/sources/${id}`, "DELETE");
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
    assert.equal(removed.body.chunksRemoved, false, "another notebook still needs them");
    assert.equal(removed.body.fileRemoved, false, "the file is shared");

    // And the other notebook can still read it.
    const holderB = await get<NotebookDto>("/api/notebooks/holderb");
    assert.equal(holderB.body.sources.length, 1);
    const served = await fetch(`${base}${holderB.body.sources[0]!.fileUrl!}`);
    assert.equal(served.status, 200);
  });

  it("reclaims the chunks and the file when it was the last reference", async () => {
    const accepted = await upload("onlyholder", "only.md");
    await settle(accepted.body.jobId!);

    const before = await get<NotebookDto>("/api/notebooks/onlyholder");
    const id = before.body.sources[0]?.id;
    assert.ok(id);

    const removed = await send<DeleteSourceDto>(
      `/api/notebooks/onlyholder/sources/${id}`,
      "DELETE",
    );
    assert.equal(removed.body.chunksRemoved, true);
    assert.equal(removed.body.fileRemoved, true);
    assert.equal(existsSync(join(STORAGE, "sources", `${id}.md`)), false);
  });

  it("404s a source the notebook does not hold", async () => {
    const { status } = await send<ApiErrorDto>(
      "/api/notebooks/demo/sources/ffffffffffff",
      "DELETE",
    );
    assert.equal(status, 404);
  });

  it("rejects a malformed document id", async () => {
    const { status } = await send<ApiErrorDto>("/api/notebooks/demo/sources/NOPE", "DELETE");
    assert.equal(status, 400);
  });
});

describe("notebooks", { skip }, () => {
  it("creates an empty one, so a source can be uploaded into it", async () => {
    const { status, body } = await send<NotebookSummaryDto>("/api/notebooks", "POST", {
      json: { name: "brand new" },
    });
    assert.equal(status, 201);
    assert.equal(body.name, "brand new");
    assert.equal(body.sources, 0);

    const listed = await get<{ notebooks: NotebookSummaryDto[] }>("/api/notebooks");
    assert.ok(listed.body.notebooks.some((notebook) => notebook.name === "brand new"));
  });

  it("accepts a name with capitals and spaces, as typed", async () => {
    const { status, body } = await send<NotebookSummaryDto>("/api/notebooks", "POST", {
      json: { name: "Computer Networks" },
    });
    assert.equal(status, 201);
    assert.equal(body.name, "Computer Networks");
  });

  it("409s a name that is already taken", async () => {
    await send("/api/notebooks", "POST", { json: { name: "taken" } });
    const { status } = await send<ApiErrorDto>("/api/notebooks", "POST", {
      json: { name: "taken" },
    });
    assert.equal(status, 409);
  });

  it("deletes a notebook, releasing its sources", async () => {
    const accepted = await upload("doomed", "doomed.md");
    await settle(accepted.body.jobId!);

    const before = await get<NotebookDto>("/api/notebooks/doomed");
    const id = before.body.sources[0]!.id;

    const removed = await send<{
      removed: boolean;
      sourcesReleased: number;
      messagesRemoved: number;
    }>("/api/notebooks/doomed", "DELETE");

    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
    assert.equal(removed.body.sourcesReleased, 1);

    // Gone from the listing, and its only source's file reclaimed with it.
    assert.equal((await get<ApiErrorDto>("/api/notebooks/doomed")).status, 404);
    assert.equal(existsSync(join(STORAGE, "sources", `${id}.md`)), false);
  });

  it("leaves a shared document alone when a notebook holding it is deleted", async () => {
    // The same content-hash rule as deleting one source, applied per document.
    const shared = `${MARKDOWN}

Shared with a notebook that survives.
`;
    const keep = await upload("keeper", "shared2.md", shared);
    await settle(keep.body.jobId!);
    const go = await upload("goner", "shared2.md", shared);
    if (go.body.status === "accepted") await settle(go.body.jobId!);

    await send<unknown>("/api/notebooks/goner", "DELETE");

    const survivor = await get<NotebookDto>("/api/notebooks/keeper");
    assert.equal(survivor.body.sources.length, 1);
    const served = await fetch(`${base}${survivor.body.sources[0]!.fileUrl!}`);
    assert.equal(served.status, 200, "the shared file was reclaimed too early");
  });

  it("404s a notebook that is not there", async () => {
    assert.equal((await send<ApiErrorDto>("/api/notebooks/nosuch", "DELETE")).status, 404);
  });

  it("rejects a name that could not be put in a URL or a path", async () => {
    for (const name of ["../escape", ".hidden", "", "a".repeat(80)]) {
      const { status } = await send<ApiErrorDto>("/api/notebooks", "POST", { json: { name } });
      assert.equal(status, 400, `'${name}' was accepted`);
    }
  });
});
