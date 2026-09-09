import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import * as config from "../config.ts";
import type { Chunk } from "../models.ts";

const DB_FILENAME = "vectors.db";

const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vectors (
    chunk_id    TEXT NOT NULL,
    notebook    TEXT NOT NULL,
    document_id TEXT NOT NULL,
    model_id    TEXT NOT NULL,
    dimensions  INTEGER NOT NULL,
    vector      BLOB NOT NULL,
    -- Composite for the same reason as documents: chunk ids are derived from the
    -- file's content hash, so two notebooks holding one PDF share them. With
    -- chunk_id alone as the key, adding the file to a second notebook moved
    -- every vector out of the first.
    PRIMARY KEY (notebook, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_vectors_notebook ON vectors(notebook);
CREATE INDEX IF NOT EXISTS idx_vectors_document ON vectors(document_id);
`;

interface VectorRow extends Record<string, SQLOutputValue> {
  chunk_id: string;
  document_id: string;
  vector: Uint8Array<ArrayBuffer>;
}

function toBlob(vector: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new Float32Array(vector).buffer);
}

function fromBlob(blob: Uint8Array<ArrayBuffer>): Float32Array {
  // .slice() gives a copy whose buffer starts at offset 0, which Float32Array needs.
  const copy = blob.slice();
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

export class VectorStore {
  private db: DatabaseSync;
  private cache = new Map<
    string,
    { ids: string[]; documentIds: string[]; vectors: Float32Array[] }
  >();

  constructor(storageDir: string = config.STORAGE_DIR) {
    mkdirSync(storageDir, { recursive: true });
    this.db = new DatabaseSync(join(storageDir, DB_FILENAME));
    // WAL so the API server can read while a forked ingest writes.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    this.db.exec(SCHEMA);
  }

  private migrate(): void {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    const columns = (this.db.prepare("PRAGMA table_info(vectors)").all() as { name: string }[]).map(
      (column) => column.name,
    );
    const keyed = (
      this.db.prepare("PRAGMA index_list(vectors)").all() as { origin: string }[]
    ).some((index) => index.origin === "pk");
    const current = columns.length > 0 && columns.includes("model_id") && keyed;
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

  add(notebook: string, chunks: Chunk[], vectors: number[][], modelId: string): void {
    if (chunks.length === 0) return;
    if (chunks.length !== vectors.length) {
      throw new Error(
        `got ${chunks.length} chunks but ${vectors.length} vectors - they must pair up`,
      );
    }

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

  modelsIn(notebook: string): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT model_id FROM vectors WHERE notebook = ?")
      .all(notebook) as { model_id: string }[];
    return rows.map((row) => row.model_id);
  }

  private load(notebook: string): {
    ids: string[];
    documentIds: string[];
    vectors: Float32Array[];
  } {
    const cached = this.cache.get(notebook);
    if (cached) return cached;
    const rows = this.db
      .prepare("SELECT chunk_id, document_id, vector FROM vectors WHERE notebook = ?")
      .all(notebook) as VectorRow[];
    const loaded = {
      ids: rows.map((row) => row.chunk_id),
      documentIds: rows.map((row) => row.document_id),
      vectors: rows.map((row) => fromBlob(row.vector)),
    };
    this.cache.set(notebook, loaded);
    return loaded;
  }

  search(
    notebook: string,
    vector: number[],
    k: number,
    modelId: string,
    documentIds?: readonly string[],
  ): [string, number][] {
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

    const { ids, documentIds: owners, vectors } = this.load(notebook);
    if (ids.length === 0) return [];

    const query = new Float32Array(vector);
    const scope = documentIds && documentIds.length > 0 ? new Set(documentIds) : null;

    const scored: [string, number][] = [];
    for (const [index, candidate] of vectors.entries()) {
      if (scope && !scope.has(owners[index]!)) continue;
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

  deleteDocument(documentId: string, notebook?: string): void {
    if (notebook === undefined) {
      this.db.prepare("DELETE FROM vectors WHERE document_id = ?").run(documentId);
    } else {
      this.db
        .prepare("DELETE FROM vectors WHERE document_id = ? AND notebook = ?")
        .run(documentId, notebook);
    }
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
