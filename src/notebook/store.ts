import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import * as config from "../config.ts";
import type { BlockKind, BoundaryReason, Chunk, Document } from "../models.ts";

const DB_FILENAME = "notebook.db";
const BATCH = 500; // SQLite caps how many "?" placeholders one statement may have

/**
 * Bumped whenever the chunk shape changes. Chunks are derived data - they can
 * always be rebuilt from the source file - so a stale schema is dropped and
 * rebuilt rather than migrated. Documents are re-ingested, not lost.
 */
const SCHEMA_VERSION = 2;

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
    chunk_id        TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL,
    parent_id       TEXT,
    text            TEXT NOT NULL,
    token_count     INTEGER NOT NULL,
    page_start      INTEGER,
    page_end        INTEGER,
    heading_path    TEXT NOT NULL DEFAULT '[]',
    section_title   TEXT,
    chunk_index     INTEGER NOT NULL DEFAULT 0,
    previous_chunk_id TEXT,
    next_chunk_id   TEXT,
    block_kinds     TEXT NOT NULL DEFAULT '[]',
    boundary_reason TEXT NOT NULL DEFAULT 'document'
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
  token_count: number;
  page_start: number | null;
  page_end: number | null;
  heading_path: string;
  section_title: string | null;
  chunk_index: number;
  previous_chunk_id: string | null;
  next_chunk_id: string | null;
  block_kinds: string;
  boundary_reason: string;
}

/** Metadata stored as JSON is still metadata: parse defensively so one bad row
 *  cannot take down a whole notebook's retrieval. */
function parseList<T>(json: string): T[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
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
    tokenCount: row.token_count,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    headingPath: parseList<string>(row.heading_path),
    sectionTitle: row.section_title,
    chunkIndex: row.chunk_index,
    previousChunkId: row.previous_chunk_id,
    nextChunkId: row.next_chunk_id,
    blockKinds: parseList<BlockKind>(row.block_kinds),
    boundaryReason: row.boundary_reason as BoundaryReason,
  };
}

/** The text side of storage: which sources a notebook holds, and their chunks. */
export class NotebookStore {
  private db: DatabaseSync;

  constructor(storageDir: string = config.STORAGE_DIR) {
    mkdirSync(storageDir, { recursive: true });
    this.db = new DatabaseSync(join(storageDir, DB_FILENAME));
    this.migrate();
    this.db.exec(SCHEMA);
  }

  /** Drops derived tables when the chunk shape has changed. Sources have to be
   *  re-added; nothing that cannot be rebuilt from the original file is lost. */
  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };

    // The version number says what the file *claims* to be; the columns say what
    // it actually is. Check both, so a mis-stamped version cannot leave the
    // process talking to a table that does not have the columns it will write.
    const columns = (
      this.db.prepare("PRAGMA table_info(chunks)").all() as { name: string }[]
    ).map((column) => column.name);
    const existing = columns.length > 0;
    const current = existing && columns.includes("heading_path");

    if (row.user_version === SCHEMA_VERSION && (current || !existing)) return;

    if (existing) {
      console.log(
        `storage schema is v${row.user_version || 1}, this build needs v${SCHEMA_VERSION} - ` +
          `clearing stored chunks. Re-add your sources with \`notebook add\`.`,
      );
      this.db.exec("DROP TABLE IF EXISTS chunks");
      this.db.exec("DROP TABLE IF EXISTS documents");
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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

  /**
   * Removes a source and every chunk belonging to it. Returns false when the
   * notebook does not have that document, so the caller can say so instead of
   * silently doing nothing.
   */
  deleteDocument(notebook: string, documentId: string): boolean {
    if (!this.hasDocument(notebook, documentId)) return false;
    // chunks first: nothing should ever see chunks whose document is gone
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
      this.db.prepare("DELETE FROM documents WHERE document_id = ?").run(documentId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  addChunks(chunks: Chunk[]): void {
    const statement = this.db.prepare(
      `INSERT OR REPLACE INTO chunks
         (chunk_id, document_id, parent_id, text, token_count, page_start, page_end,
          heading_path, section_title, chunk_index, previous_chunk_id, next_chunk_id,
          block_kinds, boundary_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          chunk.tokenCount,
          chunk.pageStart,
          chunk.pageEnd,
          JSON.stringify(chunk.headingPath),
          chunk.sectionTitle,
          chunk.chunkIndex,
          chunk.previousChunkId,
          chunk.nextChunkId,
          JSON.stringify(chunk.blockKinds),
          chunk.boundaryReason,
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
