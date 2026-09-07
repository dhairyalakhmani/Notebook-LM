/**
 * Turning a follow-up into a question retrieval can actually search for.
 *
 * "Explain that further" contains nothing to retrieve. Embed it and you get the
 * vector for a generic instruction; run BM25 on it and you match every chunk
 * containing "further". The conversation holds the missing subject, so the fix
 * is to put it back into the question *before* searching.
 *
 * Three approaches were available, and the trade-off is worth understanding:
 *
 *  1. **Reuse the previous turn's passages.** Free, no model call. Wrong the
 *     moment a follow-up changes subject ("and what about UDP?"), which is a
 *     large share of real follow-ups.
 *  2. **Glue the previous question onto this one** and search that. Also free,
 *     and it half-works: it drags in the old subject even when the user has
 *     moved on, biasing retrieval towards what was already discussed.
 *  3. **Ask the model to rewrite it standalone.** One extra call, and the one
 *     chosen here.
 *
 * (3) costs a few hundred tokens against the ~6,600 the answer itself uses, so
 * about 5% more, and roughly half a second. That buys correct behaviour on both
 * pronoun follow-ups and subject changes, rather than a heuristic that fails
 * silently. The call is skipped entirely when there is no history, so a first
 * question is exactly as fast as it was before.
 *
 * Note the direction of information flow: history reaches the *question* and
 * never the answer prompt. See chat.ts for why that boundary matters.
 */

import type { CompletionModel } from "../llm/client.ts";
import type { ChatMessage } from "../models.ts";

/** Prior answers are quoted only far enough to resolve a reference. */
const ANSWER_PREVIEW_CHARS = 400;

/**
 * The examples are not decoration - the rules alone were not obeyed.
 *
 * Measured: with rules only, "and what about BGP?" after a conversation about
 * packet delay was rewritten to "How does BGP relate to transmission,
 * propagation, processing and queuing delay?" - a question the book genuinely
 * does not answer, so the system correctly refused it. A rewriter that invents
 * unanswerable questions manufactures FALSE REFUSALS, which is the worst
 * failure this project has. The second example exists specifically to stop that.
 */
const PROMPT = `Rewrite the user's LATEST question so that it can be understood on its own, by someone who cannot see the conversation.

Rules:
- Replace pronouns and back-references ("it", "that", "this", "those", "the same", "the second one") with what they actually refer to in the conversation.
- Keep the user's own words and intent wherever you can. You are rewriting, not improving.
- If the latest question already stands on its own, return it EXACTLY as written, unchanged.
- If the latest question names a NEW topic, rewrite it as a standalone question about that topic ALONE. Never join it to an earlier topic.
- Never answer the question.
- Return ONLY the rewritten question, on one line, with no preamble or quotes.

Examples:

Conversation:
User: What are the four delay components?
Assistant: Processing, queuing, transmission and propagation delay.
Latest question: which of those varies the most?
Rewritten question: Which of processing, queuing, transmission and propagation delay varies the most?

Conversation:
User: What are the four delay components?
Assistant: Processing, queuing, transmission and propagation delay.
Latest question: and what about BGP?
Rewritten question: What is BGP?

Conversation:
User: How does DNS work?
Assistant: DNS translates hostnames into IP addresses.
Latest question: How does TCP provide reliable data transfer?
Rewritten question: How does TCP provide reliable data transfer?`;

function transcript(history: ChatMessage[]): string {
  return history
    .map((message) => {
      const label = message.role === "user" ? "User" : "Assistant";
      const text =
        message.role === "assistant" && message.text.length > ANSWER_PREVIEW_CHARS
          ? `${message.text.slice(0, ANSWER_PREVIEW_CHARS)}...`
          : message.text;
      return `${label}: ${text}`;
    })
    .join("\n");
}

export function buildFollowupPrompt(question: string, history: ChatMessage[]): string {
  return `${PROMPT}\n\nConversation so far:\n${transcript(history)}\n\nLatest question: ${question}\n\nRewritten question:`;
}

export interface ResolvedQuestion {
  /** What retrieval should search for. */
  question: string;
  /** True when the rewrite changed it, so the CLI and UI can show both. */
  rewritten: boolean;
}

/**
 * The longest a rewritten question may be. For calibration, the longest real
 * question in this project's eval set is ~160 characters, so this admits any
 * legitimate rewrite while rejecting a paragraph.
 */
const MAX_REWRITE_CHARS = 250;

/**
 * A rewrite is only allowed to *rephrase*. The failure to guard against is a
 * model that answers instead of rewriting: retrieval would then go looking for
 * an answer nobody asked for, which is far worse than searching the literal
 * follow-up. So anything shaped like prose rather than a question is rejected,
 * and the user's own words are used instead.
 *
 * Two independent checks, because either alone lets something through: a long
 * single-sentence explanation has no sentence breaks to count, and a short
 * two-sentence answer is under any sane length cap.
 */
function usable(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length < 8) return false;
  if (trimmed.includes("\n")) return false;
  if (trimmed.length > MAX_REWRITE_CHARS) return false;
  // One question, or at most two for a genuinely two-part one. Three sentences
  // is the model explaining.
  if ((trimmed.match(/[.!?]\s+\S/g) ?? []).length > 1) return false;
  return true;
}

export async function resolveQuestion(
  question: string,
  history: ChatMessage[],
  model: CompletionModel,
): Promise<ResolvedQuestion> {
  // No conversation means nothing to resolve, and no reason to pay for a call.
  if (history.length === 0) return { question, rewritten: false };

  let candidate: string;
  try {
    candidate = await model.generate(buildFollowupPrompt(question, history), {
      temperature: 0,
    });
  } catch {
    // A rewrite is an optimisation, not a requirement. If it fails - rate limit,
    // network - searching the question as typed still works for the many
    // follow-ups that happen to be self-contained.
    return { question, rewritten: false };
  }

  const cleaned = candidate.trim().replace(/^["'`]|["'`]$/g, "");
  if (!usable(cleaned)) return { question, rewritten: false };
  return { question: cleaned, rewritten: cleaned !== question.trim() };
}
