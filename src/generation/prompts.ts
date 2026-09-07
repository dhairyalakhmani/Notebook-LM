/**
 * The grounding prompt. This file is where "a search engine" becomes
 * "NotebookLM", so it is worth reading rather than skimming.
 *
 * Three rules earn their place, and each one exists to stop a specific failure:
 *
 *  1. **Only the passages.** The model knows a great deal about most subjects and
 *     will blend that knowledge with the document without ever signalling that it
 *     did. Preventing exactly this is the reason the product exists.
 *  2. **An exact refusal sentence.** Models are trained to be helpful, and a
 *     helpful model handed five weak passages writes a plausible answer from them.
 *     "I don't know" has to be an explicitly permitted, easy, pre-written path -
 *     and a fixed string, so the eval in Phase 10 can detect it exactly.
 *  3. **A marker on every factual sentence.** This is what makes the answer
 *     checkable. It also measurably reduces drift, because the model has to keep
 *     pointing at real text instead of writing freely.
 */

import { formatPages } from "../retrieval/retriever.ts";
import type { Passage } from "../retrieval/retriever.ts";

export const REFUSAL = "The sources provided don't cover this.";

/**
 * Note the shape as well as the words. The honesty rules come first and last,
 * and the length rules sit in the middle, because a model attends most to the
 * start and end of its instructions - the guards get both ends.
 *
 * **Why there is a length budget at all.** Output tokens are ~99% of the time a
 * user waits, so answer length is a latency decision, not only a style one. An
 * earlier version asked for depth instead and measured 276 words mean, up to
 * 567 - roughly double the generation time. This asks for the middle.
 *
 * Three details are doing the work:
 *
 *  1. **A soft target plus a hard ceiling**, not one number. Given a single
 *     figure, a model pads to reach it or truncates to obey it.
 *  2. **"Cover every part of a multi-part question."** This is the guard against
 *     the budget eating facts, which is the specific risk of capping length -
 *     several of these questions have three or four parts, and a cap without
 *     this line trades correctness for brevity. The eval measures exactly that.
 *  3. **"No section headings, no summary or closing paragraph."** That is where
 *     the bulk actually went: the longest answer was bolded per-topic sections
 *     plus a concluding paragraph restating them.
 */
export const INSTRUCTIONS = `Answer the question using ONLY the passages below.

Be brief. Aim for about 120 words, and never exceed 200.
- Open with the direct answer in the first sentence. Do not restate the question.
- Then add only the reasoning the passages themselves give, and only where it
  changes the answer.
- Cover every part of a multi-part question, briefly. Dropping a part is not
  concision, it is a wrong answer.
- Write prose. No section headings, no summary or closing paragraph, no repetition.
- If the passages support only one sentence, give one sentence.

Every sentence that states a fact must end with its source marker, like [2].
If a fact comes from more than one passage, cite them all, like [1][3].
If the passages do not contain the answer, reply with exactly this and nothing else:
"${REFUSAL}"
Do not use anything you know that is not in the passages. Do not guess.`;

/**
 * The label line for one passage.
 *
 * The full heading path goes in, not just the section title. It is not
 * decoration: the model has to choose which passage to cite, and a notebook of
 * sibling sections produces labels like "Customer" and "Customer_Review" that a
 * path disambiguates and a bare title does not.
 */
export function label(passage: Passage, index: number): string {
  const parts = [passage.filename, formatPages(passage.pageStart, passage.pageEnd)];
  const heading = passage.headingPath.join(" > ") || passage.sectionTitle;
  if (heading) parts.push(`"${heading}"`);
  return `[${index + 1}] (${parts.join(", ")})`;
}

/** Numbered, with the real source on the label line, so the model has something
 *  concrete to point at rather than a bare index. */
export function formatPassages(passages: Passage[]): string {
  return passages
    .map((passage, index) => `${label(passage, index)}\n${passage.text}`)
    .join("\n\n");
}

/**
 * Passages arrive best-first and stay that way. With five passages the effect is
 * small, but models attend more to the beginning and end of a long context than
 * to its middle, and putting the strongest match where it is most likely to be
 * read costs nothing.
 */
export function buildPrompt(question: string, passages: Passage[]): string {
  return `${INSTRUCTIONS}\n\n${formatPassages(passages)}\n\nQuestion: ${question}\n`;
}
