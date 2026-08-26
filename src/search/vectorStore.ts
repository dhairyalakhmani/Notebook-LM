import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import * as config from "../config.ts";
import type { Chunk } from "../models.ts";

const DB_FILENAME = "vectors.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vectors (
    chunk_id    TEXT PRIMARY KEY,
    notebook    TEXT NOT NULL,
    document_id TEXT NOT NULL,
    vector      BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vectors_notebook ON vectors(notebook);
CREATE INDEX IF NOT EXISTS idx_vectors_document ON vectors(document_id);
`;

interface VectorRow extends Record<string, SQLOutputValue> {
  chunk_id: string;
  vector: Uint8Array<ArrayBuffer>;
}

/** Vectors go in as raw float32 bytes: 384 dims = 1536 bytes, no encoding games. */
function toBlob(vector: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new Float32Array(vector).buffer);
}

function fromBlob(blob: Uint8Array<ArrayBuffer>): Float32Array {
  // .slice() gives a copy whose buffer starts at offset 0, which Float32Array needs.
  const copy = blob.slice();
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/**
 * Search by meaning.
 *
 * This compares the question's vector against every stored vector and keeps the
 * closest. That sounds slow and isn't: a notebook of 5,000 chunks is 5,000 dot
 * products of 384 numbers, which is a couple of milliseconds. A real vector
 * database (an HNSW index) exists to avoid scanning millions of vectors — at
 * notebook scale it would only add a service to run and a format to debug.
 *
 * The interface below is the part that matters. If a notebook ever grows past a
 * few hundred thousand chunks, swap the body of `search` and nothing else changes.
 */
export class VectorStore {
  private db: DatabaseSync;
  /** Loaded once per notebook per process; dropped whenever vectors change. */
  private cache = new Map<string, { ids: string[]; vectors: Float32Array[] }>();

  constructor(storageDir: string = config.STORAGE_DIR) {
    mkdirSync(storageDir, { recursive: true });
    this.db = new DatabaseSync(join(storageDir, DB_FILENAME));
    this.db.exec(SCHEMA);
  }

  add(notebook: string, chunks: Chunk[], vectors: number[][]): void {
    if (chunks.length === 0) return;
    if (chunks.length !== vectors.length) {
      throw new Error(
        `got ${chunks.length} chunks but ${vectors.length} vectors - they must pair up`,
      );
    }
    const statement = this.db.prepare(
      `INSERT OR REPLACE INTO vectors (chunk_id, notebook, document_id, vector)
       VALUES (?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const [index, chunk] of chunks.entries()) {
        statement.run(chunk.chunkId, notebook, chunk.documentId, toBlob(vectors[index]!));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.cache.delete(notebook);
  }

  private load(notebook: string): { ids: string[]; vectors: Float32Array[] } {
    const cached = this.cache.get(notebook);
    if (cached) return cached;
    const rows = this.db
      .prepare("SELECT chunk_id, vector FROM vectors WHERE notebook = ?")
      .all(notebook) as VectorRow[];
    const loaded = {
      ids: rows.map((row) => row.chunk_id),
      vectors: rows.map((row) => fromBlob(row.vector)),
    };
    this.cache.set(notebook, loaded);
    return loaded;
  }

  /** Returns [chunkId, cosineSimilarity][], best first. */
  search(notebook: string, vector: number[], k: number): [string, number][] {
    const { ids, vectors } = this.load(notebook);
    if (ids.length === 0) return [];

    const query = new Float32Array(vector);
    const scored: [string, number][] = [];
    for (const [index, stored] of vectors.entries()) {
      if (stored.length !== query.length) continue; // a vector from another model
      let dot = 0;
      for (let d = 0; d < query.length; d++) dot += query[d]! * stored[d]!;
      // both sides are unit-length, so the dot product *is* the cosine
      scored.push([ids[index]!, dot]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, k);
  }

  deleteDocument(documentId: string): void {
    this.db.prepare("DELETE FROM vectors WHERE document_id = ?").run(documentId);
    this.cache.clear();
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM vectors").get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
