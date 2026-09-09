import { http, HttpResponse } from "msw";
import type {
  AskResponseDto,
  NotebookDto,
  NotebookSummaryDto,
  OutlineSectionDto,
  TurnDto,
} from "../../types.ts";

export const DOC_A = "aaaaaaaaaaaa";
export const DOC_B = "bbbbbbbbbbbb";

export const summaries: NotebookSummaryDto[] = [
  {
    name: "networking",
    sources: 2,
    pages: 780,
    createdAt: null,
    lastMessageAt: "2026-01-03T10:00:00.000Z",
  },
  { name: "dbms", sources: 1, pages: 1, createdAt: null, lastMessageAt: null },
];

const sourceA = {
  id: DOC_A,
  kind: "pdf" as const,
  filename: "Networking.pdf",
  title: "Networking",
  pages: 775,
  bytes: 19_712_624,
  addedAt: "2026-01-01T00:00:00.000Z",
  fileUrl: `/api/sources/${DOC_A}/file`,
  stats: {
    blocks: 6120,
    units: 980,
    sections: 499,
    passages: 2474,
    structureScore: 0.72,
    tokenSplitChunks: 3,
    segmenters: ["structural"],
    stages: [
      { stage: "extract" as const, ms: 18_400 },
      { stage: "chunk" as const, ms: 6700 },
      { stage: "embed" as const, ms: 49_700 },
    ],
    embedModel: "BAAI/bge-small-en-v1.5",
  },
};

const sourceB = {
  id: DOC_B,
  kind: "text" as const,
  filename: "dbms-notes.md",
  title: "dbms-notes",
  pages: 1,
  bytes: 609,
  addedAt: "2026-01-02T00:00:00.000Z",
  fileUrl: `/api/sources/${DOC_B}/file`,
  stats: null,
};

const answeredTurn: TurnDto = {
  id: "t42",
  question: {
    text: "how are keys and packets related?",
    searchedFor: null,
    askedAt: "2026-01-03T09:59:00.000Z",
  },
  answeredAt: "2026-01-03T10:00:00.000Z",
  kind: "answer",
  text: "Routers forward packets by destination address [1]. A primary key identifies a row [2].",
  citations: [
    {
      marker: 1,
      sourceId: DOC_A,
      filename: "Networking.pdf",
      pageStart: 48,
      pageEnd: 48,
      pageLabel: "p. 48",
      section: ["1.4 Delay"],
      quote: "Routers forward packets using the destination address in the header.",
      page: 48,
    },
    {
      marker: 2,
      sourceId: DOC_B,
      filename: "dbms-notes.md",
      pageStart: 48,
      pageEnd: 48,
      pageLabel: "p. 48",
      section: ["1. USER & ACCESS DOMAIN"],
      quote: "The customer_id column is the primary key of the Customer table.",
      page: 48,
    },
  ],
  passages: [
    {
      marker: 1,
      sourceId: DOC_A,
      filename: "Networking.pdf",
      pageLabel: "p. 48",
      section: ["1.4 Delay"],
      fused: 0.5,
      cosine: 0.81,
      bm25: 12.2,
      denseRank: 1,
      sparseRank: 2,
      matchCount: 4,
      cited: true,
    },
    {
      marker: 2,
      sourceId: DOC_B,
      filename: "dbms-notes.md",
      pageLabel: "p. 48",
      section: ["1. USER & ACCESS DOMAIN"],
      fused: 0.4,
      // BM25 alone found this one. Null is the interesting case, not a gap.
      cosine: null,
      bm25: 18.9,
      denseRank: null,
      sparseRank: 1,
      matchCount: 1,
      cited: true,
    },
  ],
};

const refusedTurn: TurnDto = {
  id: "t44",
  question: { text: "how does QUIC work?", searchedFor: null, askedAt: "2026-01-03T10:01:00.000Z" },
  answeredAt: "2026-01-03T10:01:02.000Z",
  kind: "refusal",
  refusalText: "The sources provided don't cover this.",
  reason: "model",
  passages: [],
};

export const notebook: NotebookDto = {
  name: "networking",
  sources: [sourceA, sourceB],
  turns: [answeredTurn, refusedTurn],
  totalTurns: 2,
};

const outline: OutlineSectionDto[] = [
  { number: "1.4", title: "Delay, Loss and Throughput", page: 46, depth: 1 },
  { number: null, title: "Deeply nested heading", page: 47, depth: 14 },
];

export const askResponse: AskResponseDto = {
  turn: {
    id: "t99",
    question: { text: "placeholder", searchedFor: null, askedAt: "2026-01-03T11:00:00.000Z" },
    answeredAt: "2026-01-03T11:00:03.000Z",
    kind: "answer",
    text: "Transmission delay is L over R [1].",
    citations: [answeredTurn.kind === "answer" ? answeredTurn.citations[0] : never()],
    passages: [],
  },
  rewritten: false,
  historyLength: 2,
  timings: { rewriteMs: 500, retrieveMs: 700, answerMs: 1300, totalMs: 2600 },
  quota: {
    tokensRemaining: 1468,
    tokensLimit: 8000,
    requestsRemaining: 998,
    requestsLimit: 1000,
    resetTokensMs: 49_000,
    resetRequestsMs: 172_800,
  },
};

function never(): never {
  throw new Error("fixture is malformed");
}

export const asked: { body: unknown }[] = [];

export const handlers = [
  // Signed in by default, so the existing tests exercise the app rather than
  // the sign-in screen. Tests that want the screen override this.
  http.get("/api/health", () =>
    HttpResponse.json({
      apiVersion: 1,
      signupCodeRequired: false,
      groqModel: "test-model",
      embedder: { modelId: "test-embedder", dimensions: 384 },
      notebooks: 2,
    }),
  ),

  http.get("/api/auth/me", () =>
    HttpResponse.json({ user: "tester", createdAt: "2026-01-01T00:00:00.000Z" }),
  ),
  http.post("/api/auth/logout", () => HttpResponse.json({ ok: true })),

  http.get("/api/notebooks", () => HttpResponse.json({ notebooks: summaries })),
  http.get("/api/notebooks/:name", ({ params }) =>
    params["name"] === "networking"
      ? HttpResponse.json(notebook)
      : HttpResponse.json(
          { error: { code: "not_found", message: `no notebook '${String(params["name"])}'` } },
          { status: 404 },
        ),
  ),
  http.get("/api/sources/:id/outline", () => HttpResponse.json({ sections: outline })),
  http.get("/api/sources/:id/file", () => HttpResponse.text("%PDF-1.6")),
  http.post("/api/notebooks/:name/ask", async ({ request }) => {
    const body = (await request.json()) as { question?: string };
    asked.push({ body });
    return HttpResponse.json({
      ...askResponse,
      turn: {
        ...askResponse.turn,
        question: { ...askResponse.turn.question, text: body.question ?? "" },
      },
    });
  }),
];
