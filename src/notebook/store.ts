import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import * as config from "../config.ts";
import type { Chunk, Document } from "../models.ts";

const DB_FILENAME = "notebook.db";
const BATCH = 500; // SQLite caps how many "?" placeholders one statement may have

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
    document_id TEXT PRIMARY KEY,
    notebook    TEXT NOT NULL,
    title       TEXT NOT NULL,
    filename    TEXT NOT NULL,
    source_type TEXT NOT NULL,
    page_count  INTEGER NOT NULL,
    added_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id      TEXT PRIMARY KEY,
    document_id   TEXT NOT NULL,
    parent_id     TEXT,
    text          TEXT NOT NULL,
    page_number   INTEGER,
    section_title TEXT,
    token_count   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_parent   ON chunks(parent_id);
`;

interface DocumentRow extends Record<string, SQLOutputValue> {
  document_id: string;
  title: string;
  filename: string;
  source_type: string;
  page_count: number;
  added_at: string;
}

interface ChunkRow extends Record<string, SQLOutputValue> {
  chunk_id: string;
  document_id: string;
  parent_id: string | null;
  text: string;
  page_number: number | null;
  section_title: string | null;
  token_count: number;
}

function toDocument(row: DocumentRow): Document {
  return {
    documentId: row.document_id,
    title: row.title,
    filename: row.filename,
    sourceType: row.source_type,
    pageCount: row.page_count,
    addedAt: row.added_at,
  };
}

function toChunk(row: ChunkRow): Chunk {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    parentId: row.parent_id,
    text: row.text,
    pageNumber: row.page_number,
    sectionTitle: row.section_title,
    tokenCount: row.token_count,
  };
}

/** The text side of storage: which sources a notebook holds, and their chunks. */
export class NotebookStore {
  private db: DatabaseSync;

  constructor(storageDir: string = config.STORAGE_DIR) {
    mkdirSync(storageDir, { recursive: true });
    this.db = new DatabaseSync(join(storageDir, DB_FILENAME));
    this.db.exec(SCHEMA);
  }

  hasDocument(notebook: string, documentId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM documents WHERE notebook = ? AND document_id = ?")
      .get(notebook, documentId);
    return row !== undefined;
  }

  addDocument(notebook: string, document: Document): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO documents
           (document_id, notebook, title, filename, source_type, page_count, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        document.documentId,
        notebook,
        document.title,
        document.filename,
        document.sourceType,
        document.pageCount,
        document.addedAt,
      );
  }

  getDocument(documentId: string): Document | null {
    const row = this.db
      .prepare("SELECT * FROM documents WHERE document_id = ?")
      .get(documentId) as DocumentRow | undefined;
    return row ? toDocument(row) : null;
  }

  listDocuments(notebook: string): Document[] {
    const rows = this.db
      .prepare("SELECT * FROM documents WHERE notebook = ? ORDER BY added_at")
      .all(notebook) as DocumentRow[];
    return rows.map(toDocument);
  }

  addChunks(chunks: Chunk[]): void {
    const statement = this.db.prepare(
      `INSERT OR REPLACE INTO chunks
         (chunk_id, document_id, parent_id, text, page_number, section_title, token_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // one transaction, not one commit per chunk: thousands of chunks, a few ms
    this.db.exec("BEGIN");
    try {
      for (const chunk of chunks) {
        statement.run(
          chunk.chunkId,
          chunk.documentId,
          chunk.parentId,
          chunk.text,
          chunk.pageNumber,
          chunk.sectionTitle,
          chunk.tokenCount,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getChunks(chunkIds: string[]): Map<string, Chunk> {
    const found = new Map<string, Chunk>();
    for (let start = 0; start < chunkIds.length; start += BATCH) {
      const batch = chunkIds.slice(start, start + BATCH);
      const marks = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM chunks WHERE chunk_id IN (${marks})`)
        .all(...batch) as ChunkRow[];
      for (const row of rows) found.set(row.chunk_id, toChunk(row));
    }
    return found;
  }

  /** Every child chunk in a notebook — what the keyword index is built from. */
  childChunks(notebook: string): Chunk[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM chunks c
           JOIN documents d ON d.document_id = c.document_id
          WHERE d.notebook = ? AND c.parent_id IS NOT NULL
          ORDER BY c.chunk_id`,
      )
      .all(notebook) as ChunkRow[];
    return rows.map(toChunk);
  }

  close(): void {
    this.db.close();
  }
}
