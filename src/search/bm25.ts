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

  private idf(documentFrequency: number): number {
    return Math.log(1 + (this.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
  }

  scores(queryTokens: string[]): Map<number, number> {
    const scores = new Map<number, number>();
    for (const term of new Set(queryTokens)) {
      const postings = this.postings.get(term);
      if (!postings) continue;
      const idf = this.idf(postings.length);
      for (const { doc, frequency } of postings) {
        const normalisation = K1 * (1 - B + (B * this.lengths[doc]!) / (this.averageLength || 1));
        const contribution = (idf * (frequency * (K1 + 1))) / (frequency + normalisation);
        scores.set(doc, (scores.get(doc) ?? 0) + contribution);
      }
    }
    return scores;
  }
}
