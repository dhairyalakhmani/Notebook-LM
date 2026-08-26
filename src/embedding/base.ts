export interface Embedder {
  /** Embed passages that are being stored. */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** Embed one question being asked. Not the same call as above — see hfEmbedder.ts. */
  embedQuery(text: string): Promise<number[]>;
}
