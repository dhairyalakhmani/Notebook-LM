export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export const POOLING = "cls" as const;

export function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (length === 0 || !Number.isFinite(length)) return vector.slice();
  return vector.map((value) => value / length);
}

export function isUnitLength(vector: number[], tolerance = 1e-3): boolean {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.abs(Math.sqrt(sum) - 1) <= tolerance;
}

export function isEmbeddable(text: string): boolean {
  return text.trim().length > 0;
}
