import OpenAI from "openai";
import * as config from "../config.ts";
import { asRateLimitError, readQuota } from "./errors.ts";
import type { QuotaSnapshot } from "./errors.ts";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export interface GenerateOptions {
  jsonMode?: boolean;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface CompletionModel {
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
  readonly lastQuota?: QuotaSnapshot | null;
}

export class LLMClient implements CompletionModel {
  private client: OpenAI;
  readonly model: string;

  lastQuota: QuotaSnapshot | null = null;

  constructor(model: string = config.GROQ_MODEL) {
    const apiKey = process.env["GROQ_API_KEY"];
    if (!apiKey) {
      throw new Error("GROQ_API_KEY not found. Add it to a .env file in the project root.");
    }
    this.client = new OpenAI({
      apiKey,
      baseURL: GROQ_BASE_URL,
      maxRetries: 0,
    });
    this.model = model;
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    try {
      return await this.complete(prompt, options);
    } catch (error) {
      throw asRateLimitError(error) ?? error;
    }
  }

  private async complete(prompt: string, options: GenerateOptions): Promise<string> {
    const { data: response, response: raw } = await this.client.chat.completions
      .create({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: options.temperature ?? 0,
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        ...(options.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      })
      .withResponse();

    this.lastQuota = readQuota(raw.headers);
    return response.choices[0]?.message?.content ?? "";
  }
}
