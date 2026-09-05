import "dotenv/config";
import OpenAI from "openai";
import * as config from "../config.ts";

/** Groq speaks the OpenAI API, so the official client works against it unchanged. */
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export interface GenerateOptions {
  jsonMode?: boolean;
  /** 0 by default: the same question should give the same answer. */
  temperature?: number;
  /**
   * How much hidden reasoning a reasoning model does before answering.
   *
   * gpt-oss is a reasoning model, and those tokens are generated, billed and
   * waited on exactly like answer tokens - they are simply not shown. For
   * grounded RAG the work is reading five supplied passages and quoting them,
   * not solving anything, so this is mostly latency with little to buy.
   */
  reasoningEffort?: "low" | "medium" | "high";
}

/**
 * The whole LLM surface this project needs. Any provider that can turn a prompt
 * into text satisfies it - Groq today, anything else later, a fake in tests.
 *
 * Callers depend on this rather than on `LLMClient`, deliberately. `LLMClient`'s
 * constructor throws without GROQ_API_KEY, so a function typed against the class
 * cannot be tested without either a live key or intercepted HTTP; typed against
 * the interface, a three-line stub does it.
 */
export interface CompletionModel {
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
}

/** `implements` is not decoration here: it makes the compiler prove the real
 *  client still satisfies the interface everything else is typed against. */
export class LLMClient implements CompletionModel {
  private client: OpenAI;
  readonly model: string;

  constructor(model: string = config.GROQ_MODEL) {
    const apiKey = process.env["GROQ_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "GROQ_API_KEY not found. Add it to a .env file in the project root.",
      );
    }
    this.client = new OpenAI({
      apiKey,
      baseURL: GROQ_BASE_URL,
      // The SDK default is 2 silent retries with exponential backoff, which
      // turns a rate limit into latency and nothing else: measured, a throttled
      // request took 35-46s while the same call unthrottled took 0.4s, with no
      // error anywhere. A quota problem must look like a quota problem.
      maxRetries: 0,
    });
    this.model = model;
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    try {
      return await this.complete(prompt, options);
    } catch (error) {
      throw LLMClient.describeRateLimit(error) ?? error;
    }
  }

  private async complete(prompt: string, options: GenerateOptions): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? 0,
      ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      ...(options.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
    });
    return response.choices[0]?.message?.content ?? "";
  }

  /** Wraps the call so a 429 says what it is, and how long to wait. */
  private static describeRateLimit(error: unknown): Error | null {
    const details = error as { status?: number; error?: { message?: string } };
    if (details.status !== 429) return null;
    const message = details.error?.message ?? "rate limited";
    return new Error(
      `Groq rate limit hit, so this is a quota problem and not a slow model.
  ${message}`,
    );
  }
}
