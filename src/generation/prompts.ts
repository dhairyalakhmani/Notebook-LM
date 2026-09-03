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
 * Note the shape as well as the words. The restrictions come first and last, and
 * the depth instructions sit in the middle, because a model attends most to the
 * start and end of its instructions - the guards get both ends.
 *
 * "As fully as the passages allow, and no further" is the entire idea. Depth is
 * tied to the source rather than to a length, so it cannot be read as licence to
 * pad: an instruction like "give a detailed answer" would be a target the model
 * could hit by inventing, and this one can only be hit by using more of the
 * document. The third bullet exists to protect the *honest short answer* - the
 * corpus gives `passenger_capacity` three words, and 24 words back is correct
 * rather than lazy.
 */
export const INSTRUCTIONS = `Answer the question using ONLY the passages below.

Answer as fully as the passages allow, and no further:
- Give the reasoning the passages state, not only the conclusion. Where a passage
  says why a design choice was made, include that explanation.
- Use every passage that bears on the question, not only the closest one.
- If the passages support only a short answer, give a short answer. Never pad, and
  never generalise beyond what is written.

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
