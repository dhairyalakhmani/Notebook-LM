/**
 * BM25 — keyword scoring, the sparse half of hybrid search.
 *
 * Written out rather than pulled from a package, because it is one formula and the
 * behaviour matters: the rarer a matched word is, the more a match on it is worth.
 * That is exactly why BM25 finds `ERR_4021` and `customer_id` when embeddings can't.
 *
 *   score(doc, query) = SUM over query terms t:
 *        idf(t) * ( f(t,doc) * (k1 + 1) )
 *                 / ( f(t,doc) + k1 * (1 - b + b * len(doc)/avgLen) )
 *
 *   k1  how fast a repeated word stops adding value (1.2-2.0)
 *   b   how much a long document is penalised for being long (0..1)
 */

const K1 = 1.5;
const B = 0.75;

interface Posting {
  doc: number;
  frequency: number;
}

export class BM25 {
  private readonly documentCount: number;
  private readonly lengths: number[];
  private readonly averageLength: number;
  /** term -> which documents contain it, and how often */
  private readonly postings = new Map<string, Posting[]>();

  constructor(corpus: string[][]) {
    this.documentCount = corpus.length;
    this.lengths = corpus.map((tokens) => tokens.length);
    const total = this.lengths.reduce((sum, length) => sum + length, 0);
    this.averageLength = this.documentCount > 0 ? total / this.documentCount : 0;

    for (const [doc, tokens] of corpus.entries()) {
      const frequencies = new Map<string, number>();
      for (const token of tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }
      for (const [term, frequency] of frequencies) {
        let list = this.postings.get(term);
        if (!list) {
          list = [];
          this.postings.set(term, list);
        }
        list.push({ doc, frequency });
      }
    }
  }

  /**
   * Inverse document frequency, in the form Lucene uses. It is always positive, so
   * a very common word contributes almost nothing instead of scoring negatively.
   */
  private idf(documentFrequency: number): number {
    return Math.log(
      1 + (this.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
    );
  }

  /** Scores only the documents that contain at least one query term. */
  scores(queryTokens: string[]): Map<number, number> {
    const scores = new Map<number, number>();
    for (const term of new Set(queryTokens)) {
      const postings = this.postings.get(term);
      if (!postings) continue;
      const idf = this.idf(postings.length);
      for (const { doc, frequency } of postings) {
        const normalisation =
          K1 * (1 - B + (B * this.lengths[doc]!) / (this.averageLength || 1));
        const contribution = (idf * (frequency * (K1 + 1))) / (frequency + normalisation);
        scores.set(doc, (scores.get(doc) ?? 0) + contribution);
      }
    }
    return scores;
  }
}
