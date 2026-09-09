import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  answerQuestion,
  citedMarkers,
  formatAnswer,
  normalizeMarkers,
  refused,
  ungrounded,
} from "../src/generation/answer.ts";
import { REFUSAL, buildPrompt } from "../src/generation/prompts.ts";
import type { CompletionModel } from "../src/llm/client.ts";
import type { Passage } from "../src/retrieval/retriever.ts";

const NOTEBOOK = "test-notebook";

function stubModel(reply: string): CompletionModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    generate(prompt: string): Promise<string> {
      prompts.push(prompt);
      return Promise.resolve(reply);
    },
  };
}

function passage(overrides: Partial<Passage> = {}): Passage {
  return {
    chunkId: "p1",
    documentId: "doc1",
    filename: "Schema Notes.pdf",
    title: "Schema Notes",
    pageStart: 3,
    pageEnd: 4,
    headingPath: ["2. BILLING DOMAIN", "Payments"],
    sectionTitle: "Payments",
    blockKinds: ["paragraph"],
    text: "Failed charges are retried three times over seventy-two hours.",
    match: {
      chunkId: "c1",
      fused: 0.0328,
      dense: 0.71,
      sparse: 14.27,
      denseRank: 1,
      sparseRank: 1,
    },
    matchCount: 2,
    ...overrides,
  };
}

describe("buildPrompt", () => {
  it("numbers each passage and labels it with its real source", () => {
    const prompt = buildPrompt("how are failed charges retried?", [
      passage(),
      passage({
        chunkId: "p2",
        filename: "billing.md",
        pageStart: 1,
        pageEnd: 1,
        headingPath: ["Billing"],
        text: "A refund returns to the original payment method.",
      }),
    ]);

    assert.match(prompt, /\[1\] \(Schema Notes\.pdf, p\. 3-4, "2\. BILLING DOMAIN > Payments"\)/);
    assert.match(prompt, /\[2\] \(billing\.md, p\. 1, "Billing"\)/);
    assert.match(prompt, /Question: how are failed charges retried\?/);
    // The two rules that keep an answer honest have to actually be in there.
    assert.ok(prompt.includes(REFUSAL));
    assert.ok(prompt.includes("ONLY the passages"));
    assert.ok(prompt.indexOf("[1] (Schema") < prompt.indexOf("[2] (billing"));
  });

  it("falls back to the section title, then to no heading at all", () => {
    assert.match(
      buildPrompt("q", [passage({ headingPath: [], sectionTitle: "Payments" })]),
      /\(Schema Notes\.pdf, p\. 3-4, "Payments"\)/,
    );
    assert.match(
      buildPrompt("q", [passage({ headingPath: [], sectionTitle: null })]),
      /\(Schema Notes\.pdf, p\. 3-4\)/,
    );
  });
});

describe("citedMarkers", () => {
  it("deduplicates, sorts, and drops markers that point at nothing", () => {
    assert.deepEqual(citedMarkers("Facts [2]. More [1]. Again [2].", 3), [1, 2]);
    // [7] against three passages is an invented citation, not a source.
    assert.deepEqual(citedMarkers("Something [7] and [0] and [2].", 3), [2]);
    assert.deepEqual(citedMarkers("Two at once [1][3].", 3), [1, 3]);
    assert.deepEqual(citedMarkers("No markers here.", 3), []);
  });
});

describe("normalizeMarkers", () => {
  it("accepts the full-width brackets gpt-oss emits instead of ASCII ones", () => {
    // Observed live: a fully grounded answer whose citations were all invisible.
    assert.equal(
      normalizeMarkers("Domains isolate concerns【1】【3】."),
      "Domains isolate concerns[1][3].",
    );
    assert.equal(normalizeMarkers("A column【 5 】."), "A column[5].");
    assert.equal(normalizeMarkers("Already ascii [2]."), "Already ascii [2].");
  });

  it("makes those citations countable, end to end", async () => {
    const answer = await answerQuestion("q", NOTEBOOK, {
      passages: [passage(), passage({ chunkId: "p2" })],
      model: stubModel("The schema splits into domains【1】【2】."),
    });

    assert.deepEqual(answer.used, [1, 2]);
    assert.equal(ungrounded(answer), false);
  });
});

describe("answerQuestion", () => {
  it("answers from the passages and reports which were cited", async () => {
    const model = stubModel("Three times over seventy-two hours [1].");
    const answer = await answerQuestion("how many retries?", NOTEBOOK, {
      passages: [passage(), passage({ chunkId: "p2" })],
      model,
    });

    assert.equal(answer.origin, "model");
    assert.deepEqual(answer.used, [1]);
    assert.equal(refused(answer), false);
    assert.equal(ungrounded(answer), false);
    assert.equal(model.prompts.length, 1);
  });

  it("refuses without calling the model when nothing was retrieved", async () => {
    const model = stubModel("should never be asked");
    const answer = await answerQuestion("what is the cafeteria menu?", NOTEBOOK, {
      passages: [],
      model,
    });

    assert.equal(answer.text, REFUSAL);
    assert.equal(answer.origin, "no-passages");
    assert.equal(refused(answer), true);
    assert.deepEqual(model.prompts, [], "the model must not be called");
  });

  it("passes the model's own refusal through as a refusal", async () => {
    const answer = await answerQuestion("q", NOTEBOOK, {
      passages: [passage()],
      model: stubModel(REFUSAL),
    });

    assert.equal(answer.origin, "model");
    assert.equal(refused(answer), true);
    // A refusal cites nothing, and that is correct rather than ungrounded.
    assert.equal(ungrounded(answer), false);
  });

  it("flags an answer that states facts but cites nothing", async () => {
    const answer = await answerQuestion("q", NOTEBOOK, {
      passages: [passage()],
      model: stubModel("Failed charges are retried three times."),
    });

    assert.equal(ungrounded(answer), true);
    assert.match(formatAnswer(answer), /cites nothing/);
  });

  describe("the relevance floor", () => {
    it("is off by default, so a weak passage still reaches the model", async () => {
      const model = stubModel("An answer [1].");
      const answer = await answerQuestion("q", NOTEBOOK, {
        passages: [passage({ match: { ...passage().match, dense: 0.11 } })],
        model,
      });

      assert.equal(answer.origin, "model");
      assert.equal(model.prompts.length, 1);
    });

    it("refuses below the floor, without calling the model", async () => {
      const model = stubModel("should never be asked");
      const answer = await answerQuestion("what is the cafeteria menu?", NOTEBOOK, {
        passages: [
          passage({ match: { ...passage().match, dense: 0.47 } }),
          passage({ chunkId: "p2", match: { ...passage().match, dense: 0.42 } }),
        ],
        model,
        minRelevance: 0.55,
      });

      assert.equal(answer.origin, "below-relevance-floor");
      assert.equal(refused(answer), true);
      // The passages are kept, so the eval can see what it turned down.
      assert.equal(answer.passages.length, 2);
      assert.deepEqual(model.prompts, []);
    });

    it("answers when any passage clears the floor", async () => {
      const answer = await answerQuestion("q", NOTEBOOK, {
        passages: [
          passage({ match: { ...passage().match, dense: 0.42 } }),
          passage({ chunkId: "p2", match: { ...passage().match, dense: 0.71 } }),
        ],
        model: stubModel("An answer [2]."),
        minRelevance: 0.55,
      });

      assert.equal(answer.origin, "model");
    });

    it("never refuses on a keyword-only hit, which has no cosine at all", async () => {
      const answer = await answerQuestion("inspection_id", NOTEBOOK, {
        passages: [
          passage({
            match: {
              chunkId: "c4",
              fused: 0.0164,
              dense: null,
              sparse: 8.1,
              denseRank: null,
              sparseRank: 1,
            },
          }),
        ],
        model: stubModel("It is the primary key [1]."),
        minRelevance: 0.9,
      });

      assert.equal(answer.origin, "model");
    });
  });
});

describe("formatAnswer", () => {
  it("lists only the sources the answer actually cited", () => {
    const answer = {
      text: "Three times [1].",
      passages: [passage(), passage({ chunkId: "p2", filename: "billing.md" })],
      used: [1],
      origin: "model" as const,
    };

    const formatted = formatAnswer(answer);
    assert.match(formatted, /Sources:/);
    assert.match(formatted, /\[1\] \(Schema Notes\.pdf, p\. 3-4/);
    assert.ok(!formatted.includes("billing.md"), "an uncited passage is not a source");
  });

  it("prints a refusal with no source list", () => {
    const formatted = formatAnswer({
      text: REFUSAL,
      passages: [passage()],
      used: [],
      origin: "no-passages" as const,
    });

    assert.equal(formatted, REFUSAL);
  });
});
