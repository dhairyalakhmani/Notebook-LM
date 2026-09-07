import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildFollowupPrompt, resolveQuestion } from "../src/generation/followup.ts";
import { NotebookStore } from "../src/notebook/store.ts";
import type { CompletionModel } from "../src/llm/client.ts";
import type { ChatMessage } from "../src/models.ts";

const NOTEBOOK = "chat-notebook";

function store(): NotebookStore {
  return new NotebookStore(mkdtempSync(join(tmpdir(), "chat-")));
}

/** Replies with a queue of canned answers, recording every prompt it was given. */
function stubModel(...replies: string[]): CompletionModel & { prompts: string[] } {
  const queue = [...replies];
  const prompts: string[] = [];
  return {
    prompts,
    generate(prompt: string): Promise<string> {
      prompts.push(prompt);
      return Promise.resolve(queue.shift() ?? "");
    },
  };
}

function turn(role: "user" | "assistant", text: string): Omit<ChatMessage, "messageId"> {
  return {
    notebook: NOTEBOOK,
    role,
    text,
    createdAt: new Date().toISOString(),
    citations: [],
    resolvedQuestion: null,
  };
}

describe("conversation storage", () => {
  it("keeps a thread in order, with citations that survive a reload", () => {
    const db = store();
    db.addMessage(turn("user", "How many retries?"));
    db.addMessage({
      ...turn("assistant", "Three times over seventy-two hours [1]."),
      citations: [
        {
          marker: 1,
          filename: "billing.md",
          pageStart: 1,
          pageEnd: 1,
          headingPath: ["Billing"],
        },
      ],
    });

    const thread = db.messages(NOTEBOOK);
    assert.equal(thread.length, 2);
    assert.equal(thread[0]?.role, "user");
    assert.equal(thread[1]?.role, "assistant");
    // Stored by where it points, not by chunk id - so a re-ingest cannot kill it.
    assert.equal(thread[1]?.citations[0]?.filename, "billing.md");
    assert.deepEqual(thread[1]?.citations[0]?.headingPath, ["Billing"]);
  });

  it("keeps each notebook's conversation separate", () => {
    const db = store();
    db.addMessage(turn("user", "a networking question"));
    db.addMessage({ ...turn("user", "a dbms question"), notebook: "other" });

    assert.equal(db.messages(NOTEBOOK).length, 1);
    assert.equal(db.messages("other").length, 1);
    assert.equal(db.messages(NOTEBOOK)[0]?.text, "a networking question");
  });

  it("bounds the history it hands to a prompt, keeping the newest", () => {
    const db = store();
    for (let i = 1; i <= 10; i++) db.addMessage(turn("user", `question ${i}`));

    const recent = db.recentMessages(NOTEBOOK, 4);
    assert.equal(recent.length, 4);
    // Newest four, but still oldest-first so the transcript reads forwards.
    assert.deepEqual(
      recent.map((message) => message.text),
      ["question 7", "question 8", "question 9", "question 10"],
    );
  });

  it("forgets a conversation without touching the sources", () => {
    const db = store();
    db.addDocument(NOTEBOOK, {
      documentId: "doc1",
      title: "Notes",
      filename: "notes.pdf",
      sourceType: "pdf",
      pageCount: 3,
      addedAt: new Date().toISOString(),
    });
    db.addMessage(turn("user", "something"));
    db.addMessage(turn("assistant", "an answer"));

    assert.equal(db.clearMessages(NOTEBOOK), 2);
    assert.equal(db.messages(NOTEBOOK).length, 0);
    assert.equal(db.listDocuments(NOTEBOOK).length, 1, "sources must survive");
  });
});

describe("follow-up resolution", () => {
  const history: ChatMessage[] = [
    { ...turn("user", "What are the four delay components?"), messageId: 1 },
    {
      ...turn("assistant", "Processing, queuing, transmission and propagation delay [1]."),
      messageId: 2,
    },
  ];

  it("does not call the model when there is no history", async () => {
    const model = stubModel("should never be asked");
    const resolved = await resolveQuestion("What is BGP?", [], model);

    assert.equal(resolved.question, "What is BGP?");
    assert.equal(resolved.rewritten, false);
    assert.deepEqual(model.prompts, [], "a first question must cost no extra call");
  });

  it("resolves a back-reference into a standalone question", async () => {
    const model = stubModel("Why does queuing delay matter for the total delay?");
    const resolved = await resolveQuestion("why does that one matter?", history, model);

    assert.equal(resolved.question, "Why does queuing delay matter for the total delay?");
    assert.equal(resolved.rewritten, true);
    // The conversation has to actually reach the rewriter.
    assert.match(model.prompts[0]!, /four delay components/);
  });

  it("leaves an already-standalone question untouched", async () => {
    const model = stubModel("How does OSPF differ from BGP?");
    const resolved = await resolveQuestion("How does OSPF differ from BGP?", history, model);

    assert.equal(resolved.rewritten, false, "unchanged text is not a rewrite");
  });

  it("strips surrounding quotes the model sometimes adds", async () => {
    const model = stubModel('"Why does queuing delay matter?"');
    const resolved = await resolveQuestion("why that?", history, model);

    assert.equal(resolved.question, "Why does queuing delay matter?");
  });

  it("falls back to the literal question when the rewrite is not a question", async () => {
    // A model that answers instead of rewriting. Searching for an answer would
    // send retrieval somewhere the user never asked about.
    const model = stubModel(
      "Queuing delay matters because packets wait in the buffer, and this is " +
        "the component that varies with congestion, unlike the other three which " +
        "are fixed by the link and the distance, so it dominates under load and " +
        "is the one worth measuring in practice when diagnosing slow networks.",
    );
    const resolved = await resolveQuestion("why that?", history, model);

    assert.equal(resolved.question, "why that?");
    assert.equal(resolved.rewritten, false);
  });

  it("falls back when the rewrite is short but still prose", async () => {
    // Under any length cap, so the sentence-shape check is what has to catch it.
    const model = stubModel("Queuing delay matters. It varies with congestion. The rest are fixed.");
    const resolved = await resolveQuestion("why that?", history, model);

    assert.equal(resolved.question, "why that?");
    assert.equal(resolved.rewritten, false);
  });

  it("accepts a genuinely two-part rewritten question", async () => {
    const model = stubModel("What is queuing delay? Why does it matter for total delay?");
    const resolved = await resolveQuestion("why that?", history, model);

    assert.equal(resolved.rewritten, true);
  });

  it("falls back when the model fails entirely", async () => {
    const model: CompletionModel = {
      generate: () => Promise.reject(new Error("rate limited")),
    };
    const resolved = await resolveQuestion("why that?", history, model);

    assert.equal(resolved.question, "why that?");
    assert.equal(resolved.rewritten, false);
  });

  it("shows the rewriter how to handle a subject change", () => {
    // Regression guard for a measured failure: with rules alone, "and what about
    // BGP?" became "How does BGP relate to ... delay?", which the corpus does not
    // answer - so a good rewrite turned into a false refusal.
    const prompt = buildFollowupPrompt("and what about BGP?", history);
    assert.ok(
      prompt.includes("Latest question: and what about BGP?\nRewritten question: What is BGP?"),
    );
    assert.match(prompt, /names a NEW topic/);
  });

  it("quotes the conversation but truncates long prior answers", () => {
    const long: ChatMessage[] = [
      { ...turn("user", "explain everything"), messageId: 1 },
      { ...turn("assistant", "x".repeat(2000)), messageId: 2 },
    ];
    const prompt = buildFollowupPrompt("and then?", long);

    assert.ok(prompt.includes("explain everything"));
    assert.ok(prompt.includes("..."), "a long answer is previewed, not pasted whole");
    assert.ok(prompt.length < 3000, "the rewrite call must stay cheap");
  });
});
