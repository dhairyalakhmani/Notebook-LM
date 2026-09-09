export const API_VERSION = 1;

export const MIN_QUOTE_CHARS = 12;

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────── errors

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "name_taken"
  | "not_found"
  | "conflict"
  | "unsupported_type"
  | "payload_too_large"
  | "rate_limited"
  | "needs_ocr"
  | "no_text"
  | "internal";

export interface ApiErrorDto {
  error: {
    code: ErrorCode;
    message: string;
    retryAfterMs?: number;
    phase?: "rewrite" | "answer" | "unknown";
    reasons?: readonly string[];
  };
}

// ──────────────────────────────────────────────────────────────────── health

export interface HealthDto {
  /** Whether registering needs a signup code. The sign-in screen asks, so it
   *  can leave the field out entirely when nothing is required. */
  signupCodeRequired: boolean;
  apiVersion: number;
  groqModel: string;
  embedder: { modelId: string; dimensions: number };
  notebooks: number;
}

// ─────────────────────────────────────────────────────────────────── sources

export type SourceKindDto = "pdf" | "docx" | "html" | "text";

export type BlockKindDto = "heading" | "paragraph" | "listItem" | "table" | "caption" | "unknown";

export type IngestStageDto = "extract" | "quality" | "clean" | "chunk" | "embed" | "store";

export interface IngestStatsDto {
  blocks: number;
  units: number;
  sections: number;
  passages: number;
  structureScore: number;
  tokenSplitChunks: number;
  segmenters: readonly string[];
  stages: readonly { stage: IngestStageDto; ms: number }[];
  embedModel: string;
}

export interface SourceDto {
  id: string;
  kind: SourceKindDto;
  filename: string;
  title: string;
  pages: number;
  bytes: number | null;
  addedAt: string;
  fileUrl: string | null;
  stats: IngestStatsDto | null;
}

export interface OutlineSectionDto {
  number: string | null;
  title: string;
  page: number | null;
  depth: number;
}

// ──────────────────────────────────────────────────────── citations & scores

export interface CitationDto {
  marker: number;
  sourceId: string | null;
  filename: string;
  pageStart: number | null;
  pageEnd: number | null;
  pageLabel: string;
  section: readonly string[];
  quote: string | null;
  page: number | null;
}

export interface PassageDto {
  marker: number;
  sourceId: string;
  filename: string;
  pageLabel: string;
  section: readonly string[];
  fused: number;
  cosine: number | null;
  bm25: number | null;
  denseRank: number | null;
  sparseRank: number | null;
  matchCount: number;
  cited: boolean;
}

// ────────────────────────────────────────────────────────────────────── chat

export type NonEmpty<T> = readonly [T, ...T[]];

export interface AskedQuestionDto {
  text: string;
  searchedFor: string | null;
  askedAt: string;
}

export type TurnOutcomeDto =
  | {
      kind: "answer";
      text: string;
      citations: NonEmpty<CitationDto>;
      passages: readonly PassageDto[];
    }
  | { kind: "ungrounded"; text: string; passages: readonly PassageDto[] }
  | {
      kind: "refusal";
      refusalText: string;
      reason: "model" | "below-relevance-floor";
      passages: readonly PassageDto[];
    }
  | { kind: "no-passages" };

export type TurnDto = {
  id: string;
  question: AskedQuestionDto;
  answeredAt: string;
} & TurnOutcomeDto;

// ───────────────────────────────────────────────────────────────── notebooks

export interface NotebookSummaryDto {
  name: string;
  sources: number;
  pages: number;
  createdAt: string | null;
  lastMessageAt: string | null;
}

export interface NotebookDto {
  name: string;
  sources: readonly SourceDto[];
  turns: readonly TurnDto[];
  totalTurns: number;
}

// ─────────────────────────────────────────────── retrieval, without any LLM

export interface PassageSearchDto {
  query: string;
  ms: number;
  passages: readonly PassageDto[];
}

// ─────────────────────────────────────────────────────────────────── asking

export interface AskRequestDto {
  question: string;
  sourceIds?: readonly string[];
  k?: number;
  history?: boolean;
}

export interface QuotaDto {
  tokensRemaining: number | null;
  tokensLimit: number | null;
  requestsRemaining: number | null;
  requestsLimit: number | null;
  resetTokensMs: number | null;
  resetRequestsMs: number | null;
}

export interface AskTimingsDto {
  rewriteMs: number;
  retrieveMs: number;
  answerMs: number;
  totalMs: number;
}

export interface AskResponseDto {
  turn: TurnDto;
  rewritten: boolean;
  historyLength: number;
  timings: AskTimingsDto;
  quota: QuotaDto | null;
}

// ────────────────────────────────────────────────────────────────── ingesting

export type IngestEventDto =
  | { type: "queued"; position: number }
  | {
      type: "stage";
      stage: IngestStageDto;
      status: "start" | "done";
      ms?: number;
    }
  | {
      type: "progress";
      stage: IngestStageDto;
      done: number;
      total: number;
      detail?: string;
    }
  | { type: "log"; level: "info" | "warn"; message: string }
  | { type: "done"; source: SourceDto }
  | { type: "already-added"; source: SourceDto }
  | { type: "needs-ocr"; reasons: readonly string[] }
  | { type: "no-text" }
  | { type: "cancelled" }
  | { type: "error"; error: ApiErrorDto["error"] };

export type IngestStatusDto = "queued" | "running" | "done" | "skipped" | "failed" | "cancelled";

export interface IngestJobDto {
  jobId: string;
  notebook: string;
  filename: string;
  bytes: number;
  status: IngestStatusDto;
  startedAt: string;
  finishedAt: string | null;
  events: readonly IngestEventDto[];
}

export interface UploadAcceptedDto {
  status: "accepted";
  jobId: string;
}

export interface UploadDuplicateDto {
  status: "already-added";
  source: SourceDto;
}

export type UploadResponseDto = UploadAcceptedDto | UploadDuplicateDto;

export interface DeleteSourceDto {
  removed: boolean;
  chunksRemoved: boolean;
  fileRemoved: boolean;
}

export interface DeleteNotebookDto {
  removed: boolean;
  sourcesReleased: number;
  messagesRemoved: number;
}

// ------------------------------------------------------------------ accounts

export const MIN_PASSWORD_CHARS = 10;
export const MAX_PASSWORD_CHARS = 200;

/** Who the session belongs to. The password never appears in any DTO. */
export interface SessionDto {
  user: string;
  createdAt: string;
}

export interface RegisterRequestDto {
  user: string;
  password: string;
  /** Required only when the deployment sets a signup code. */
  code?: string;
}

export interface LoginRequestDto {
  user: string;
  password: string;
}
