import { getEncoding } from "js-tiktoken";
import type { Tiktoken } from "js-tiktoken";

export interface TokenCounter {
  count(text: string): number;
  encode(text: string): number[];
  decode(tokens: number[]): string;
}

export class TiktokenCounter implements TokenCounter {
  private encoder: Tiktoken;

  constructor(encodingName: "cl100k_base" | "o200k_base" = "cl100k_base") {
    this.encoder = getEncoding(encodingName);
  }

  count(text: string): number {
    return this.encoder.encode(text).length;
  }

  encode(text: string): number[] {
    return this.encoder.encode(text);
  }

  decode(tokens: number[]): string {
    return this.encoder.decode(tokens);
  }
}
