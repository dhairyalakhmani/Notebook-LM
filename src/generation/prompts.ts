import { formatPages } from "../retrieval/retriever.ts";
import type { Passage } from "../retrieval/retriever.ts";

export const REFUSAL = "The sources provided don't cover this.";

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

export function label(passage: Passage, index: number): string {
  const parts = [passage.filename, formatPages(passage.pageStart, passage.pageEnd)];
  const heading = passage.headingPath.join(" > ") || passage.sectionTitle;
  if (heading) parts.push(`"${heading}"`);
  return `[${index + 1}] (${parts.join(", ")})`;
}

export function formatPassages(passages: Passage[]): string {
  return passages.map((passage, index) => `${label(passage, index)}\n${passage.text}`).join("\n\n");
}

export function buildPrompt(question: string, passages: Passage[]): string {
  return `${INSTRUCTIONS}\n\n${formatPassages(passages)}\n\nQuestion: ${question}\n`;
}
