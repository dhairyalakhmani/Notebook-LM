import "dotenv/config";
import OpenAI from "openai";
import * as config from "../config.ts";

/** Groq speaks the OpenAI API, so the official client works against it unchanged. */
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export interface GenerateOptions {
  jsonMode?: boolean;
  /** 0 by default: the same question should give the same answer. */
  temperature?: number;
}

export class LLMClient {
  private client: OpenAI;
  readonly model: string;

  constructor(model: string = config.GROQ_MODEL) {
    const apiKey = process.env["GROQ_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "GROQ_API_KEY not found. Add it to a .env file in the project root.",
      );
    }
    this.client = new OpenAI({ apiKey, baseURL: GROQ_BASE_URL });
    this.model = model;
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? 0,
      ...(options.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
    });
    return response.choices[0]?.message?.content ?? "";
  }
}
