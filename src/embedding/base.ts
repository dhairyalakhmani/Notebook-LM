export interface Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxInputTokens: number;

  embedDocuments(texts: string[]): Promise<number[][]>;

  embedQuery(text: string): Promise<number[]>;
}
