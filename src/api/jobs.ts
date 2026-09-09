import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import * as config from "../config.ts";
import { invalidateNotebook } from "./services.ts";
import { userRoot } from "./paths.ts";
import type { ChildProcess } from "node:child_process";
import type { IngestEventDto, IngestJobDto, IngestStatusDto } from "./dto.ts";

const WORKER = resolve(import.meta.dirname, "ingestWorker.ts");

interface Job {
  jobId: string;
  user: string | null;
  notebook: string;
  filename: string;
  bytes: number;
  filePath: string;
  stagingPath: string | null;
  status: IngestStatusDto;
  startedAt: string;
  finishedAt: string | null;
  events: IngestEventDto[];
  child: ChildProcess | null;
  listeners: Set<(event: IngestEventDto, id: number) => void>;
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
let running = 0;

const FINAL: Partial<Record<IngestEventDto["type"], IngestStatusDto>> = {
  done: "done",
  "already-added": "skipped",
  "needs-ocr": "skipped",
  "no-text": "skipped",
  error: "failed",
  cancelled: "cancelled",
};

function publish(job: Job, event: IngestEventDto): void {
  job.events.push(event);
  const id = job.events.length;
  for (const listener of job.listeners) listener(event, id);

  const finalStatus = FINAL[event.type];
  if (!finalStatus) return;

  job.status = finalStatus;
  job.finishedAt = new Date().toISOString();
  job.child = null;

  if (event.type === "done") invalidateNotebook(job.user, job.notebook);

  void cleanUp(job);
  running -= 1;
  pump();
}

async function cleanUp(job: Job): Promise<void> {
  if (!job.stagingPath) return;
  try {
    await unlink(job.stagingPath);
  } catch {
    // Already gone. Not a problem.
  }
}

function pump(): void {
  while (running < config.INGEST_MAX_CONCURRENT && queue.length > 0) {
    const jobId = queue.shift()!;
    const job = jobs.get(jobId);
    if (!job || job.status !== "queued") continue;
    start(job);
  }
  queue.forEach((jobId, index) => {
    const waiting = jobs.get(jobId);
    if (waiting) publish(waiting, { type: "queued", position: index + 1 });
  });
}

function start(job: Job): void {
  job.status = "running";
  running += 1;

  const child = fork(WORKER, [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    // The child is a separate process and config.STORAGE_DIR is read from the
    // environment at module load, so this redirects the whole pipeline - store,
    // vectors, sources - at one caller's directory with no change inside it.
    // CACHE_DIR stays at the root so the embedding cache is shared.
    env: {
      ...process.env,
      NOTEBOOK_STORAGE_DIR: userRoot(job.user),
      NOTEBOOK_CACHE_DIR: config.CACHE_DIR,
    },
  });
  job.child = child;

  child.on("message", (event) => publish(job, event as IngestEventDto));

  child.on("error", (error) =>
    publish(job, { type: "error", error: { code: "internal", message: error.message } }),
  );

  child.on("exit", (code, signal) => {
    if (job.status !== "running") return; // a terminal event already arrived
    publish(job, {
      type: "error",
      error: {
        code: "internal",
        message:
          signal === "SIGKILL" || signal === "SIGTERM"
            ? `the ingest process was stopped (${signal})`
            : `the ingest process exited with code ${String(code)} before finishing`,
      },
    });
  });

  child.send({
    notebook: job.notebook,
    filePath: job.filePath,
    displayName: job.filename,
  });
}

export function enqueue(input: {
  user: string | null;
  notebook: string;
  filename: string;
  bytes: number;
  filePath: string;
  stagingPath?: string | null;
}): IngestJobDto {
  const job: Job = {
    jobId: randomUUID(),
    user: input.user,
    notebook: input.notebook,
    filename: input.filename,
    bytes: input.bytes,
    filePath: input.filePath,
    stagingPath: input.stagingPath ?? null,
    status: "queued",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    events: [],
    child: null,
    listeners: new Set(),
  };
  jobs.set(job.jobId, job);
  queue.push(job.jobId);
  pump();
  return snapshot(job);
}

export function snapshot(job: Job | IngestJobDto): IngestJobDto {
  return {
    jobId: job.jobId,
    notebook: job.notebook,
    filename: job.filename,
    bytes: job.bytes,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    events: [...job.events],
  };
}

// Scoped to the caller. A job id is an unguessable UUID, but jobsFor() looks
// up by notebook NAME - and two callers can each own a notebook called
// "shared", so without this one of them could read the other's ingests.
export function getJob(jobId: string, user: string | null): IngestJobDto | null {
  const job = jobs.get(jobId);
  if (!job || job.user !== user) return null;
  return snapshot(job);
}

export function subscribe(
  jobId: string,
  afterId: number,
  listener: (event: IngestEventDto, id: number) => void,
): { unsubscribe: () => void; finished: boolean } | null {
  const job = jobs.get(jobId);
  if (!job) return null;

  for (let index = afterId; index < job.events.length; index++) {
    listener(job.events[index]!, index + 1);
  }

  const finished = job.finishedAt !== null;
  if (finished) return { unsubscribe: () => {}, finished: true };

  job.listeners.add(listener);
  return { unsubscribe: () => job.listeners.delete(listener), finished: false };
}

export function cancel(jobId: string, user: string | null): boolean {
  const job = jobs.get(jobId);
  if (!job || job.user !== user || job.finishedAt !== null) return false;

  if (job.child) {
    job.child.kill("SIGTERM");
    // The exit handler would otherwise report this as a crash.
    publish(job, { type: "cancelled" });
  } else {
    const at = queue.indexOf(jobId);
    if (at !== -1) queue.splice(at, 1);
    publish(job, { type: "cancelled" });
  }
  return true;
}

export function jobsFor(notebook: string, user: string | null): IngestJobDto[] {
  return [...jobs.values()]
    .filter((job) => job.user === user && job.notebook === notebook)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(snapshot);
}

export function sweepJobs(now: number = Date.now()): number {
  let dropped = 0;
  for (const [jobId, job] of jobs) {
    if (job.finishedAt === null) continue;
    if (now - Date.parse(job.finishedAt) < config.JOB_RETENTION_MS) continue;
    jobs.delete(jobId);
    dropped += 1;
  }
  return dropped;
}

export function stopAllJobs(): void {
  for (const job of jobs.values()) job.child?.kill("SIGTERM");
  jobs.clear();
  queue.length = 0;
  running = 0;
}
