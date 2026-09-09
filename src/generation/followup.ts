import type { CompletionModel } from "../llm/client.ts";
import type { ChatMessage } from "../models.ts";

const ANSWER_PREVIEW_CHARS = 400;

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
  question: string;
  rewritten: boolean;
}

const MAX_REWRITE_CHARS = 250;

function usable(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length < 8) return false;
  if (trimmed.includes("\n")) return false;
  if (trimmed.length > MAX_REWRITE_CHARS) return false;
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
    return { question, rewritten: false };
  }

  const cleaned = candidate.trim().replace(/^["'`]|["'`]$/g, "");
  if (!usable(cleaned)) return { question, rewritten: false };
  return { question: cleaned, rewritten: cleaned !== question.trim() };
}
