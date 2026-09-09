import type { Document, IngestStage, IngestStats } from "../models.ts";

export type { IngestStage };

const STAGE_LABELS: Record<IngestStage, string> = {
  extract: "extract",
  quality: "quality check",
  clean: "clean",
  chunk: "chunk",
  embed: "embed",
  store: "store",
};

export function stageLabel(stage: IngestStage): string {
  return STAGE_LABELS[stage];
}

export interface IngestReporter {
  stage(stage: IngestStage, status: "start" | "done", ms?: number): void;
  progress(stage: IngestStage, done: number, total: number): void;
  log(level: "info" | "warn", message: string): void;
  finished(document: Document, stats: IngestStats): void;
}

export const silentReporter: IngestReporter = {
  stage: () => {},
  progress: () => {},
  log: () => {},
  finished: () => {},
};

export function consoleReporter(): IngestReporter {
  return {
    stage: () => {},
    progress: () => {
      // The CLI printed a single line per stage, not a live counter.
    },
    log: (level, message) => {
      console.log(level === "warn" ? `  ! ${message}` : `  ${message}`);
    },
    finished: (document, stats) => {
      const total = stats.stages.reduce((sum, entry) => sum + entry.ms, 0);
      console.log(`  ingest took ${(total / 1000).toFixed(1)}s:`);
      for (const { stage, ms } of stats.stages) {
        console.log(
          `    ${stageLabel(stage).padEnd(14)} ${(ms / 1000).toFixed(1).padStart(6)}s  ` +
            `${((100 * ms) / total).toFixed(0).padStart(3)}%`,
        );
      }
    },
  };
}
