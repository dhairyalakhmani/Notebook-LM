export interface Message {
  title: string;
  body: string;
  action?: string;
}

export const messages = {
  // ── notebooks ────────────────────────────────────────────────────────────
  notebooksEmpty: {
    title: "No notebooks yet",
    body: "A notebook is a set of sources you can ask questions about. Add a document and one is created for you.",
    action: "Create a notebook",
  },
  notebooksFailed: {
    title: "Could not load your notebooks",
    body: "The API did not answer. It runs as a separate process — check that `npm run api` is running.",
    action: "Try again",
  },
  notebookDelete: {
    title: "Delete this notebook?",
    body: "Its conversation is deleted for good. Sources shared with another notebook are kept.",
    action: "Delete",
  },

  notebookMissing: {
    title: "No such notebook",
    body: "This notebook has no sources and no history, so there is nothing to open.",
    action: "Back to your notebooks",
  },

  // ── sources ──────────────────────────────────────────────────────────────
  sourcesEmpty: {
    title: "Nothing to read yet",
    body: "Answers here are quoted from documents you add, and nothing else. Add one to begin.",
    action: "Add a source",
  },
  sourcesFailed: {
    title: "Could not load the sources",
    body: "The notebook's own record could not be read.",
    action: "Try again",
  },
  sourceUnavailable: {
    title: "This document is not on disk",
    body: "It was indexed before the original file was kept, so it can still be searched but not displayed. Run `npm run notebook -- relink data` to link it back by content hash.",
  },
  sourceRemoved: {
    title: "That source was removed",
    body: "It is no longer part of this notebook.",
  },

  // ── the viewer ───────────────────────────────────────────────────────────
  viewerIdle: {
    title: "No document open",
    body: "Pick a source, or click a citation in an answer to open the page it came from.",
  },
  viewerLoading: {
    title: "Opening the document",
    body: "Only the pages you look at are downloaded.",
  },
  viewerNotPdf: {
    title: "Shown as text",
    body: "This source is not a PDF, so there are no pages to render — the extracted text is below.",
  },
  outlineEmpty: {
    title: "No sections detected",
    body: "This document has no headings the extractor could find. It is still fully searchable.",
  },

  // ── the thread ───────────────────────────────────────────────────────────
  threadEmpty: {
    title: "Ask something",
    body: "Every answer is quoted from your sources, with a citation you can open.",
  },
  thinking: {
    title: "Searching your sources",
    body: "Both halves of the search run, then the model reads what came back.",
  },
  askFailed: {
    title: "That question did not go through",
    body: "Nothing was saved, so you can send it again.",
    action: "Retry",
  },
  quotaWait: {
    title: "Waiting for quota",
    body: "The free tier allows 8,000 tokens a minute and a grounded question uses most of that. This one will send itself.",
  },

  refusedByModel: {
    title: "Not in your sources",
    body: "The model read the passages that came back and would not answer from them. Nothing was invented — this is the system working.",
  },
  refusedByFloor: {
    title: "Nothing relevant enough",
    body: "The closest passage scored below the relevance floor, so the model was never asked.",
  },
  noPassages: {
    title: "No passages matched",
    body: "Both halves of the search came back empty, so the model was never called.",
  },
  ungrounded: {
    title: "This answer cites nothing",
    body: "It stated things without pointing at a passage. Not a refusal and not a grounded answer — treat it as unverified.",
  },

  blockedNoSources: {
    title: "Add a source first",
    body: "There is nothing to search, so there is nothing to answer from.",
    action: "Add a source",
  },
  blockedScopeEmpty: {
    title: "No sources selected",
    body: "Every source is unticked, so the search has nowhere to look.",
    action: "Select all",
  },

  // ── generic ──────────────────────────────────────────────────────────────
  loading: { title: "Loading", body: "" },
  unexpected: {
    title: "Something went wrong",
    body: "This is a bug rather than something you did.",
    action: "Reload",
  },
  routeMissing: {
    title: "Nothing here",
    body: "That address does not match anything in the app.",
    action: "Back to your notebooks",
  },
} as const satisfies Record<string, Message>;

export type MessageId = keyof typeof messages;

export function messageForError(kind: string): Message {
  switch (kind) {
    case "network":
      return messages.notebooksFailed;
    case "not-found":
      return messages.notebookMissing;
    case "quota":
      return messages.quotaWait;
    case "unsupported-file":
      return {
        title: "That file type is not supported",
        body: "PDF, DOCX, HTML, Markdown and plain text can be ingested.",
      };
    case "too-large":
      return { title: "That file is too large", body: "The limit is 200 MB." };
    case "aborted":
      return { title: "Cancelled", body: "" };
    default:
      return messages.unexpected;
  }
}
