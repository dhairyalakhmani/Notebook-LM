import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import * as config from "../config.ts";
import type { Chunk } from "../models.ts";

const DB_FILENAME = "vectors.db";

/** Bumped when the row shape changes. Vectors are derived data - they are
 *  rebuilt by re-ingesting, never migrated. */
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vectors (
    chunk_id    TEXT PRIMARY KEY,
    notebook    TEXT NOT NULL,
    document_id TEXT NOT NULL,
    model_id    TEXT NOT NULL,
    dimensions  INTEGER NOT NULL,
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
    this.migrate();
    this.db.exec(SCHEMA);
  }

  /** Drops the table when its shape is stale, including a pre-versioning file. */
  private migrate(): void {
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    const columns = (
      this.db.prepare("PRAGMA table_info(vectors)").all() as { name: string }[]
    ).map((column) => column.name);
    const current = columns.length > 0 && columns.includes("model_id");
    if (version === SCHEMA_VERSION && (current || columns.length === 0)) return;

    if (columns.length > 0) {
      console.log(
        `vector store is v${version || 1}, this build needs v${SCHEMA_VERSION} - ` +
          "clearing vectors. Re-add your sources with `notebook add`.",
      );
      this.db.exec("DROP TABLE IF EXISTS vectors");
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * `modelId` is stored with every vector. Two 384-dimensional vectors from
   * different models are not comparable, and nothing about their contents says
   * so - recording the producer is the only way a mismatch can ever be caught.
   */
  add(notebook: string, chunks: Chunk[], vectors: number[][], modelId: string): void {
    if (chunks.length === 0) return;
    if (chunks.length !== vectors.length) {
      throw new Error(
        `got ${chunks.length} chunks but ${vectors.length} vectors - they must pair up`,
      );
    }

    // Refuse to mix models within a notebook. Caught here rather than at query
    // time on purpose: allowing the write would leave the notebook permanently
    // unsearchable, whereas rejecting one ingest leaves it exactly as it was.
    const existing = this.modelsIn(notebook).filter((id) => id !== modelId);
    if (existing.length > 0) {
      throw new Error(
        `notebook '${notebook}' is embedded with ${existing.map((id) => `'${id}'`).join(", ")}, ` +
          `but this ingest used '${modelId}'. Vectors from different models are not ` +
          "comparable. Either embed with the same model, or remove the existing " +
          "sources and re-add them all.",
      );
    }
    const statement = this.db.prepare(
      `INSERT OR REPLACE INTO vectors
         (chunk_id, notebook, document_id, model_id, dimensions, vector)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const [index, chunk] of chunks.entries()) {
        const vector = vectors[index]!;
        statement.run(
          chunk.chunkId,
          notebook,
          chunk.documentId,
          modelId,
          vector.length,
          toBlob(vector),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.cache.delete(notebook);
  }

  /** Which models produced the vectors in a notebook. More than one means the
   *  notebook was embedded inconsistently and cannot be searched coherently. */
  modelsIn(notebook: string): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT model_id FROM vectors WHERE notebook = ?")
      .all(notebook) as { model_id: string }[];
    return rows.map((row) => row.model_id);
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

  /**
   * Returns [chunkId, cosineSimilarity][], best first.
   *
   * `modelId` is the model that embedded the query. A mismatch against what is
   * stored is a hard error, not something to work around: the previous version
   * skipped vectors whose length differed, which meant a model swap quietly
   * returned fewer results, and a swap between two 384-dimensional models
   * returned confident nonsense.
   */
  search(notebook: string, vector: number[], k: number, modelId: string): [string, number][] {
    const stored = this.modelsIn(notebook);
    if (stored.length === 0) return [];

    const foreign = stored.filter((id) => id !== modelId);
    if (foreign.length > 0) {
      throw new Error(
        `notebook '${notebook}' holds vectors from ${foreign.map((id) => `'${id}'`).join(", ")} ` +
          `but the query was embedded with '${modelId}'. Vectors from different models ` +
          "are not comparable - re-add the sources to re-embed them.",
      );
    }

    const { ids, vectors } = this.load(notebook);
    if (ids.length === 0) return [];

    const query = new Float32Array(vector);
    const scored: [string, number][] = [];
    for (const [index, candidate] of vectors.entries()) {
      if (candidate.length !== query.length) {
        throw new Error(
          `vector for chunk '${ids[index]}' has ${candidate.length} dimensions but the ` +
            `query has ${query.length}. Re-add the sources to re-embed them.`,
        );
      }
      let dot = 0;
      for (let d = 0; d < query.length; d++) dot += query[d]! * candidate[d]!;
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
