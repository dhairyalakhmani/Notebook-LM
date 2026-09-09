import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import * as config from "../config.ts";
import { getEmbedder } from "../embedding/index.ts";
import { askInNotebook } from "../notebook/chat.ts";
import { HANDLED, route } from "./router.ts";
import { badRequest, conflict, HttpError, notFound } from "./errors.ts";
import { readBodyToFile, readJson, sendFile } from "./http.ts";
import {
  documentId,
  documentIdList,
  intQuery,
  notebookName,
  requiredQuery,
  uploadFilename,
} from "./params.ts";
import { cancel, enqueue, getJob, jobsFor, subscribe } from "./jobs.ts";
import { openSse } from "./sse.ts";
import {
  toAskResponseDto,
  toCitationDto,
  toNotebookSummaryDto,
  toOutlineDto,
  toPassageDto,
  toSourceDto,
  toTurnDtos,
} from "./mapping.ts";
import {
  completionModel,
  invalidateNotebook,
  notebookStore,
  retrieverFor,
  sourceFile,
  vectors,
} from "./services.ts";
import type {
  AskRequestDto,
  AskResponseDto,
  DeleteNotebookDto,
  DeleteSourceDto,
  HealthDto,
  IngestJobDto,
  NotebookDto,
  NotebookSummaryDto,
  OutlineSectionDto,
  PassageSearchDto,
  SourceDto,
} from "./dto.ts";
import { API_VERSION, MAX_UPLOAD_BYTES } from "./dto.ts";

function sourcesOf(notebook: string): SourceDto[] {
  return notebookStore()
    .sourcesIn(notebook)
    .map((source) => toSourceDto(source, sourceFile(source.document.documentId) !== null));
}

export function registerReadRoutes(): void {
  route("GET", "/api/health", async (): Promise<HealthDto> => {
    const embedder = await getEmbedder();
    return {
      apiVersion: API_VERSION,
      groqModel: config.GROQ_MODEL,
      embedder: { modelId: embedder.modelId, dimensions: embedder.dimensions },
      notebooks: notebookStore().listNotebooks().length,
    };
  });

  route("GET", "/api/notebooks", (): { notebooks: NotebookSummaryDto[] } => {
    return { notebooks: notebookStore().listNotebooks().map(toNotebookSummaryDto) };
  });

  route("GET", "/api/notebooks/:notebook", ({ params, query }): NotebookDto => {
    const notebook = notebookName(params[0]!);
    const store = notebookStore();
    if (!store.notebookExists(notebook)) throw notFound(`no notebook '${notebook}'`);

    const sources = sourcesOf(notebook);

    const byFilename = new Map(sources.map((source) => [source.filename, source.id]));
    const resolveSourceId = (filename: string) => byFilename.get(filename) ?? null;

    const messages = store.messages(notebook);
    const turns = toTurnDtos(messages, resolveSourceId);
    const limit = intQuery(query, "turns", 100, 1, 1000);

    return {
      name: notebook,
      sources,
      turns: turns.slice(Math.max(0, turns.length - limit)),
      totalTurns: turns.length,
    };
  });

  route(
    "GET",
    "/api/notebooks/:notebook/passages",
    async ({ params, query }): Promise<PassageSearchDto> => {
      const notebook = notebookName(params[0]!);
      const store = notebookStore();
      if (!store.notebookExists(notebook)) throw notFound(`no notebook '${notebook}'`);

      const q = requiredQuery(query, "q");
      const k = intQuery(query, "k", config.CONTEXT_K, 1, 50);
      const sourceIds = documentIdList(query, "sourceIds");

      const retriever = await retrieverFor(notebook);
      const started = performance.now();
      const passages = await retriever.retrieve(q, {
        k,
        ...(sourceIds === undefined ? {} : { documentIds: sourceIds }),
      });
      const ms = performance.now() - started;

      return {
        query: q,
        ms,
        passages: passages.map((passage, index) => toPassageDto(passage, index + 1, false)),
      };
    },
  );

  route("GET", "/api/sources/:id/file", async ({ params, request, response }) => {
    const id = documentId(params[0]!);
    if (!notebookStore().getDocument(id)) throw notFound(`no source ${id}`);

    const path = sourceFile(id);
    if (!path) {
      throw notFound(
        `source ${id} has no file on disk. It was ingested before the original ` +
          `was kept - run \`npm run notebook -- relink <dir>\` to link it by content hash.`,
      );
    }
    await sendFile(request, response, path);
    return HANDLED;
  });

  route("GET", "/api/sources/:id/outline", ({ params }): { sections: OutlineSectionDto[] } => {
    const id = documentId(params[0]!);
    const store = notebookStore();
    if (!store.getDocument(id)) throw notFound(`no source ${id}`);
    return { sections: store.outline(id).map(toOutlineDto) };
  });
}

export function registerWriteRoutes(): void {
  route("POST", "/api/notebooks", ({ request }): Promise<NotebookSummaryDto> =>
    (async () => {
      const body = await readJson<{ name?: unknown }>(request);
      if (typeof body.name !== "string") throw badRequest("a 'name' is required");
      const name = notebookName(body.name);
      const store = notebookStore();
      if (!store.createNotebook(name)) throw conflict(`notebook '${name}' already exists`);
      return {
        name,
        sources: 0,
        pages: 0,
        createdAt: new Date().toISOString(),
        lastMessageAt: null,
      };
    })(),
  );

  route(
    "POST",
    "/api/notebooks/:notebook/ask",
    async ({ params, request }): Promise<AskResponseDto> => {
      const notebook = notebookName(params[0]!);
      const store = notebookStore();
      if (!store.notebookExists(notebook)) throw notFound(`no notebook '${notebook}'`);

      const body = await readJson<AskRequestDto>(request);
      const question = typeof body.question === "string" ? body.question.trim() : "";
      if (question === "") throw badRequest("a 'question' is required");

      const sourceIds = body.sourceIds?.map((id) => documentId(String(id)));

      const result = await askInNotebook(notebook, question, {
        store,
        model: completionModel(),
        retriever: await retrieverFor(notebook),
        ...(body.k === undefined ? {} : { k: Math.min(50, Math.max(1, Math.trunc(body.k))) }),
        ...(sourceIds === undefined ? {} : { sourceIds }),
        ...(body.history === false ? { stateless: true } : {}),
      });

      const byFilename = new Map(
        store
          .sourcesIn(notebook)
          .map((source) => [source.document.filename, source.document.documentId]),
      );
      const citations = result.citations.map((citation) =>
        toCitationDto(citation, (filename) => byFilename.get(filename) ?? null),
      );

      return toAskResponseDto(result, citations);
    },
  );

  route("POST", "/api/notebooks/:notebook/sources", async ({ params, query, request }) => {
    const notebook = notebookName(params[0]!);
    const store = notebookStore();
    if (!store.notebookExists(notebook)) {
      store.createNotebook(notebook);
    }

    const filename = uploadFilename(query);
    const extension = extname(filename).toLowerCase();

    await mkdir(config.TMP_DIR, { recursive: true });
    await mkdir(config.SOURCES_DIR, { recursive: true });

    const staging = join(config.TMP_DIR, `${randomUUID()}${extension}`);

    let received: { bytes: number; hash: string };
    try {
      received = await readBodyToFile(request, staging, MAX_UPLOAD_BYTES);
    } catch (error) {
      await rm(staging, { force: true });
      const message = error instanceof Error ? error.message : String(error);
      throw message.includes("limit")
        ? new HttpError(413, "payload_too_large", message)
        : badRequest(`the upload failed: ${message}`);
    }

    if (received.bytes === 0) {
      await rm(staging, { force: true });
      throw badRequest("the upload was empty");
    }

    // Already here? Nothing to do, and no job to watch.
    if (store.hasDocument(notebook, received.hash)) {
      await rm(staging, { force: true });
      const existing = store
        .sourcesIn(notebook)
        .find((candidate) => candidate.document.documentId === received.hash);
      if (existing) {
        return {
          status: "already-added" as const,
          source: toSourceDto(existing, sourceFile(received.hash) !== null),
        };
      }
    }

    // Move it to its content-addressed home so ingest can adopt it in place.
    const target = join(config.SOURCES_DIR, `${received.hash}${extension}`);
    await rename(staging, target);

    const job = enqueue({
      notebook,
      filename,
      bytes: received.bytes,
      filePath: target,
    });
    return { status: "accepted" as const, jobId: job.jobId };
  });

  route("GET", "/api/ingest/:jobId", ({ params }): IngestJobDto => {
    const job = getJob(params[0]!);
    if (!job) throw notFound(`no ingest job ${params[0]!}`);
    return job;
  });

  route("GET", "/api/notebooks/:notebook/ingests", ({ params }): { jobs: IngestJobDto[] } => {
    return { jobs: jobsFor(notebookName(params[0]!)) };
  });

  route("GET", "/api/ingest/:jobId/events", ({ params, request, response }) => {
    const jobId = params[0]!;
    if (!getJob(jobId)) throw notFound(`no ingest job ${jobId}`);

    const lastSeen = Number(request.headers["last-event-id"] ?? 0);
    const stream = openSse(response);

    const subscription = subscribe(
      jobId,
      Number.isFinite(lastSeen) && lastSeen > 0 ? lastSeen : 0,
      (event, id) => {
        stream.send(event, id);
      },
    );

    if (!subscription || subscription.finished) {
      stream.close();
      return HANDLED;
    }

    request.on("close", () => subscription.unsubscribe());
    return HANDLED;
  });

  route("DELETE", "/api/ingest/:jobId", ({ params }): { cancelled: boolean } => {
    return { cancelled: cancel(params[0]!) };
  });

  route(
    "DELETE",
    "/api/notebooks/:notebook/sources/:id",
    async ({ params }): Promise<DeleteSourceDto> => {
      const notebook = notebookName(params[0]!);
      const id = documentId(params[1]!);
      const store = notebookStore();

      const path = sourceFile(id);
      const { removed, chunksRemoved } = store.deleteDocument(notebook, id);
      if (!removed) throw notFound(`notebook '${notebook}' has no source ${id}`);

      vectors().deleteDocument(id, notebook);

      let fileRemoved = false;
      if (chunksRemoved && path) {
        try {
          await rm(path, { force: true });
          fileRemoved = true;
        } catch {
          // Unreferenced content-addressed bytes lingering is untidy, not broken.
        }
      }

      invalidateNotebook(notebook);
      return { removed, chunksRemoved, fileRemoved };
    },
  );

  route("DELETE", "/api/notebooks/:notebook", async ({ params }): Promise<DeleteNotebookDto> => {
    const notebook = notebookName(params[0]!);
    const store = notebookStore();
    if (!store.notebookExists(notebook)) throw notFound(`no notebook '${notebook}'`);

    // Collected BEFORE the rows go, since afterwards there is nothing to ask.
    const held = store.sourcesIn(notebook).map((source) => ({
      id: source.document.documentId,
      path: sourceFile(source.document.documentId),
    }));

    const { documentIds, messagesRemoved } = store.deleteNotebook(notebook);

    for (const source of held) {
      vectors().deleteDocument(source.id, notebook);
      const stillReferenced = store.notebooksWith(source.id) > 0;
      if (!stillReferenced && source.path) {
        await rm(source.path, { force: true }).catch(() => {
          // Unreferenced bytes left behind are untidy, not broken.
        });
      }
    }

    invalidateNotebook(notebook);
    return { removed: true, sourcesReleased: documentIds.length, messagesRemoved };
  });

  route("DELETE", "/api/notebooks/:notebook/messages", ({ params }): { cleared: number } => {
    const notebook = notebookName(params[0]!);
    const store = notebookStore();
    if (!store.notebookExists(notebook)) throw notFound(`no notebook '${notebook}'`);
    return { cleared: store.clearMessages(notebook) };
  });
}
