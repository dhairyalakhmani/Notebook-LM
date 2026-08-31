/**
 * Turning text into vectors.
 *
 * The interface states its own contract, because the vector store needs to know
 * what produced the numbers it is holding. Two 384-dimensional vectors from
 * different models are not "slightly different" - they are incomparable, and
 * mixing them returns confident nonsense with no error anywhere. `modelId` is
 * what lets that be caught.
 */
export interface Embedder {
  /** Exactly identifies what produced these vectors, stored beside them. */
  readonly modelId: string;
  /** Vector length. Asked of the model, never assumed. */
  readonly dimensions: number;
  /** Longest input the model will actually read. Anything beyond this is
   *  silently truncated by the model, so callers may need to check. */
  readonly maxInputTokens: number;

  /** Embed passages that are being stored. Returns one vector per input, in the
   *  same order. Vectors are unit length. */
  embedDocuments(texts: string[]): Promise<number[][]>;

  /** Embed one question being asked. Not the same call as above: bge is an
   *  asymmetric retriever and queries get a prefix that passages do not. */
  embedQuery(text: string): Promise<number[]>;
}
