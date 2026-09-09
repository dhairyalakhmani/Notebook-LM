// Must come first: config.ts reads process.env at module scope.
import "../env.ts";

import { ingestFile } from "../notebook/ingest.ts";
import { NotebookStore } from "../notebook/store.ts";
import { VectorStore } from "../search/vectorStore.ts";
import { sourceKind } from "./mapping.ts";
import type { IngestEventDto } from "./dto.ts";
import type { IngestReporter } from "../notebook/ingestReporter.ts";

interface Request {
  notebook: string;
  filePath: string;
  displayName: string;
}

function emit(event: IngestEventDto): void {
  if (!process.send) {
    console.error("ingestWorker must be forked, not run directly");
    process.exit(2);
  }
  process.send(event);
}

const reporter: IngestReporter = {
  stage: (stage, status, ms) =>
    emit({ type: "stage", stage, status, ...(ms === undefined ? {} : { ms }) }),
  progress: (stage, done, total) => emit({ type: "progress", stage, done, total }),
  log: (level, message) => emit({ type: "log", level, message }),
  finished: () => {},
};

process.on("message", (message: Request) => {
  void (async () => {
    const store = new NotebookStore();
    const vectorStore = new VectorStore();
    try {
      const outcome = await ingestFile(message.notebook, message.filePath, {
        store,
        vectorStore,
        reporter,
        displayName: message.displayName,
      });

      switch (outcome.kind) {
        case "added":
        case "already-added": {
          const document = outcome.document;
          const source = store
            .sourcesIn(message.notebook)
            .find((candidate) => candidate.document.documentId === document.documentId);
          emit({
            type: outcome.kind === "added" ? "done" : "already-added",
            source: {
              id: document.documentId,
              kind: sourceKind(document.sourceType),
              filename: document.filename,
              title: document.title,
              pages: document.pageCount,
              bytes: source?.byteSize ?? null,
              addedAt: document.addedAt,
              // The file was just written by the upload, so it is there.
              fileUrl: `/api/sources/${document.documentId}/file`,
              stats: outcome.kind === "added" ? outcome.stats : (source?.stats ?? null),
            },
          });
          break;
        }
        case "needs-ocr":
          emit({ type: "needs-ocr", reasons: outcome.reasons });
          break;
        case "no-text":
          emit({ type: "no-text" });
          break;
      }
    } catch (error) {
      emit({
        type: "error",
        error: {
          code: "internal",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      store.close();
      vectorStore.close();
      process.exit(0);
    }
  })();
});
