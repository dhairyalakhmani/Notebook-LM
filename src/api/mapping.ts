import { REFUSAL } from "../generation/prompts.ts";
import { formatPages } from "../retrieval/retriever.ts";
import type {
  BlockKindDto,
  CitationDto,
  IngestStageDto,
  IngestStatsDto,
  NonEmpty,
  NotebookSummaryDto,
  OutlineSectionDto,
  PassageDto,
  SourceDto,
  SourceKindDto,
  TurnDto,
  TurnOutcomeDto,
} from "./dto.ts";
import type {
  BlockKind,
  ChatMessage,
  Citation,
  Document,
  IngestStage,
  IngestStats,
  OutlineSection,
  StoredPassage,
} from "../models.ts";
import type { Passage } from "../retrieval/retriever.ts";
import type { Answer } from "../generation/answer.ts";
import type { AskResult } from "../notebook/chat.ts";
import type { QuotaSnapshot } from "../llm/errors.ts";
import type { AskResponseDto, QuotaDto } from "./dto.ts";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _blockKindsAgree: Exact<BlockKindDto, BlockKind> = true;
const _stagesAgree: Exact<IngestStageDto, IngestStage> = true;
void _blockKindsAgree;
void _stagesAgree;

// ─────────────────────────────────────────────────────────────────── sources

export function sourceKind(sourceType: string): SourceKindDto {
  const extension = sourceType.replace(/^\./, "").toLowerCase();
  if (extension === "pdf") return "pdf";
  if (extension === "docx") return "docx";
  if (extension === "html" || extension === "htm" || extension === "xhtml") return "html";
  return "text";
}

export function toIngestStatsDto(stats: IngestStats): IngestStatsDto {
  return {
    blocks: stats.blocks,
    units: stats.units,
    sections: stats.sections,
    passages: stats.passages,
    structureScore: stats.structureScore,
    tokenSplitChunks: stats.tokenSplitChunks,
    segmenters: stats.segmenters,
    stages: stats.stages,
    embedModel: stats.embedModel,
  };
}

export function toSourceDto(
  source: {
    document: Document;
    sourcePath: string | null;
    byteSize: number | null;
    stats: IngestStats | null;
  },
  fileExists: boolean,
): SourceDto {
  const { document } = source;
  return {
    id: document.documentId,
    kind: sourceKind(document.sourceType),
    filename: document.filename,
    title: document.title,
    pages: document.pageCount,
    bytes: source.byteSize,
    addedAt: document.addedAt,
    fileUrl: fileExists ? `/api/sources/${document.documentId}/file` : null,
    stats: source.stats ? toIngestStatsDto(source.stats) : null,
  };
}

export function toOutlineDto(section: OutlineSection): OutlineSectionDto {
  return {
    number: section.number,
    title: section.title,
    page: section.page,
    depth: section.depth,
  };
}

export function toNotebookSummaryDto(summary: {
  notebook: string;
  sources: number;
  pages: number;
  createdAt: string | null;
  lastMessageAt: string | null;
}): NotebookSummaryDto {
  return {
    name: summary.notebook,
    sources: summary.sources,
    pages: summary.pages,
    createdAt: summary.createdAt,
    lastMessageAt: summary.lastMessageAt,
  };
}

// ────────────────────────────────────────────────────────── scores & citations

export function toPassageDto(passage: Passage, marker: number, cited: boolean): PassageDto {
  return {
    marker,
    sourceId: passage.documentId,
    filename: passage.filename,
    pageLabel: formatPages(passage.pageStart, passage.pageEnd),
    section: passage.headingPath,
    fused: passage.match.fused,
    cosine: passage.match.dense,
    bm25: passage.match.sparse,
    denseRank: passage.match.denseRank,
    sparseRank: passage.match.sparseRank,
    matchCount: passage.matchCount,
    cited,
  };
}

export function storedPassageToDto(passage: StoredPassage): PassageDto {
  return {
    marker: passage.marker,
    sourceId: passage.documentId,
    filename: passage.filename,
    pageLabel: formatPages(passage.pageStart, passage.pageEnd),
    section: passage.headingPath,
    fused: passage.fused,
    cosine: passage.cosine,
    bm25: passage.bm25,
    denseRank: passage.denseRank,
    sparseRank: passage.sparseRank,
    matchCount: passage.matchCount,
    cited: passage.cited,
  };
}

export function toCitationDto(
  citation: Citation,
  resolveSourceId: (filename: string) => string | null,
): CitationDto {
  return {
    marker: citation.marker,
    sourceId: citation.sourceId ?? resolveSourceId(citation.filename),
    filename: citation.filename,
    pageStart: citation.pageStart,
    pageEnd: citation.pageEnd,
    pageLabel: formatPages(citation.pageStart, citation.pageEnd),
    section: citation.headingPath,
    quote: citation.quote ?? null,
    page: citation.pageStart,
  };
}

// ────────────────────────────────────────────────────────────────────── turns

function isRefusalText(text: string): boolean {
  return text.toLowerCase().includes(REFUSAL.toLowerCase());
}

function storedOutcome(message: ChatMessage, citations: CitationDto[]): TurnOutcomeDto {
  const passages = (message.passages ?? []).map(storedPassageToDto);

  if (citations.length > 0) {
    return {
      kind: "answer",
      text: message.text,
      citations: citations as unknown as NonEmpty<CitationDto>,
      passages,
    };
  }

  if (message.text.trim() === "") return { kind: "no-passages" };
  if (isRefusalText(message.text)) {
    return { kind: "refusal", refusalText: message.text, reason: "model", passages };
  }

  return { kind: "ungrounded", text: message.text, passages };
}

export function toTurnDtos(
  messages: readonly ChatMessage[],
  resolveSourceId: (filename: string) => string | null,
): TurnDto[] {
  const turns: TurnDto[] = [];
  let pendingUser: ChatMessage | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      pendingUser = message;
      continue;
    }
    const citations = message.citations.map((citation) => toCitationDto(citation, resolveSourceId));
    turns.push({
      id: `t${message.messageId}`,
      question: {
        text: pendingUser?.text ?? "",
        searchedFor: pendingUser?.resolvedQuestion ?? null,
        askedAt: pendingUser?.createdAt ?? message.createdAt,
      },
      answeredAt: message.createdAt,
      ...storedOutcome(message, citations),
    });
    pendingUser = null;
  }

  return turns;
}

function liveOutcome(answer: Answer, citations: CitationDto[]): TurnOutcomeDto {
  const cited = new Set(answer.used);
  const passages = answer.passages.map((passage, index) =>
    toPassageDto(passage, index + 1, cited.has(index + 1)),
  );

  if (answer.origin === "no-passages") return { kind: "no-passages" };

  if (answer.origin === "below-relevance-floor") {
    return {
      kind: "refusal",
      refusalText: answer.text,
      reason: "below-relevance-floor",
      passages,
    };
  }

  if (isRefusalText(answer.text)) {
    return { kind: "refusal", refusalText: answer.text, reason: "model", passages };
  }

  if (citations.length === 0) {
    return { kind: "ungrounded", text: answer.text, passages };
  }

  return {
    kind: "answer",
    text: answer.text,
    citations: citations as unknown as NonEmpty<CitationDto>,
    passages,
  };
}

function toQuotaDto(quota: QuotaSnapshot | null): QuotaDto | null {
  return quota === null ? null : { ...quota };
}

export function toAskResponseDto(result: AskResult, citations: CitationDto[]): AskResponseDto {
  return {
    turn: {
      id: result.assistantMessageId === null ? "t-live" : `t${result.assistantMessageId}`,
      question: {
        text: result.question,
        searchedFor: result.rewritten ? result.searchedFor : null,
        askedAt: new Date().toISOString(),
      },
      answeredAt: new Date().toISOString(),
      ...liveOutcome(result.answer, citations),
    },
    rewritten: result.rewritten,
    historyLength: result.historyLength,
    timings: result.timings,
    quota: toQuotaDto(result.quota),
  };
}
