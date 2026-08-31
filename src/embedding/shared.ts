/**
 * Logic that must be identical in every Embedder implementation.
 *
 * The local ONNX path and the hosted API path have to produce *comparable*
 * vectors, or a notebook embedded with one and queried with the other returns
 * plausible nonsense. The query prefix, the pooling choice and the
 * normalisation are all part of that contract, so they live here rather than
 * being written twice.
 */

/**
 * bge is an *asymmetric* retriever: it was trained with this exact sentence in
 * front of every query and nothing in front of stored passages. Measured on this
 * project, including it widens the gap between a relevant and an irrelevant
 * passage by about 9%. It is not decoration.
 */
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

/** bge takes its sentence vector from the [CLS] token, not the token average.
 *  Confirmed against the model's own 1_Pooling/config.json. */
export const POOLING = "cls" as const;

/**
 * Scales a vector to unit length.
 *
 * `vectorStore.search` computes a raw dot product and calls it cosine, which is
 * only true for unit vectors. The local pipeline guarantees that with
 * `normalize: true`; a hosted API makes no such promise. So every implementation
 * normalises before returning, unconditionally - it is cheap and it removes a
 * failure mode that produces wrong rankings with no error.
 */
export function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  // An all-zero vector cannot be normalised. It should never happen, but
  // dividing by zero would poison the whole search with NaN.
  if (length === 0 || !Number.isFinite(length)) return vector.slice();
  return vector.map((value) => value / length);
}

/** True when the vector is already unit length, within floating-point noise. */
export function isUnitLength(vector: number[], tolerance = 1e-3): boolean {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.abs(Math.sqrt(sum) - 1) <= tolerance;
}

/** Text that would embed to nothing meaningful. An empty string still produces a
 *  valid-looking unit vector ([CLS][SEP]), which would then be searchable. */
export function isEmbeddable(text: string): boolean {
  return text.trim().length > 0;
}
