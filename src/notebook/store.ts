import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import * as config from "../config.ts";
import type {
  BlockKind,
  BoundaryReason,
  ChatMessage,
  Chunk,
  Citation,
  Document,
  IngestStats,
  OutlineSection,
  StoredPassage,
} from "../models.ts";

const DB_FILENAME = "notebook.db";
const BATCH = 500; // SQLite caps how many "?" placeholders one statement may have

const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
    document_id TEXT NOT NULL,
    notebook    TEXT NOT NULL,
    title       TEXT NOT NULL,
    filename    TEXT NOT NULL,
    source_type TEXT NOT NULL,
    page_count  INTEGER NOT NULL,
    added_at    TEXT NOT NULL,
    -- Where the ingested original lives, relative to STORAGE_DIR, so the
    -- directory can move without rewriting rows. NULL for documents added
    -- before the file was kept (see \`notebook relink\`).
    source_path TEXT,
    byte_size   INTEGER,
    -- The ChunkingReport and stage timings, as JSON. Display metadata only:
    -- never filtered or aggregated, and the stage list has to be able to grow
    -- without a migration. Same convention as heading_path and citations.
    ingest_stats TEXT,
    -- Composite, not document_id alone. The id is a hash of the file's bytes, so
    -- the same PDF added to two notebooks has one id - and with document_id as
    -- the sole primary key, INSERT OR REPLACE silently MOVED the document out of
    -- the first notebook instead of sharing it.
    PRIMARY KEY (notebook, document_id)
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
CREATE TABLE IF NOT EXISTS messages (
    message_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    notebook          TEXT NOT NULL,
    role              TEXT NOT NULL,
    text              TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    citations         TEXT NOT NULL DEFAULT '[]',
    resolved_question TEXT,
    -- The retrieval scores behind an assistant turn, as JSON. Without this the
    -- scores panel is empty for every turn read back from history, which is
    -- most of them.
    passages          TEXT NOT NULL DEFAULT '[]'
);
-- A notebook has always existed only because a document row names it, so an
-- empty notebook was unrepresentable - and you cannot upload INTO a notebook
-- that does not exist yet. This table gives one an identity of its own; a row
-- here is not required for a notebook to appear, so nothing about the old
-- behaviour changes.
CREATE TABLE IF NOT EXISTS notebooks (
    name       TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_parent   ON chunks(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(notebook, message_id);
`;

interface DocumentRow extends Record<string, SQLOutputValue> {
  document_id: string;
  title: string;
  filename: string;
  source_type: string;
  page_count: number;
  added_at: string;
}

interface MessageRow extends Record<string, SQLOutputValue> {
  message_id: number;
  notebook: string;
  role: string;
  text: string;
  created_at: string;
  citations: string;
  resolved_question: string | null;
  passages: string | null;
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

function leadingNumber(title: string): string | null {
  return /^(\d+(?:\.\d+)*)[.)]?\s+\S/.exec(title)?.[1] ?? null;
}

function stripLeadingNumber(title: string): string {
  const number = leadingNumber(title);
  return number ? title.slice(number.length).replace(/^[.)]?\s+/, "") : title;
}

function parseList<T>(json: string): T[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseObject<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
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

function toMessage(row: MessageRow): ChatMessage {
  return {
    messageId: row.message_id,
    notebook: row.notebook,
    role: row.role === "assistant" ? "assistant" : "user",
    text: row.text,
    createdAt: row.created_at,
    citations: parseList<Citation>(row.citations),
    passages: parseList<StoredPassage>(row.passages ?? "[]"),
    resolvedQuestion: row.resolved_question,
  };
}

export class NotebookStore {
  private db: DatabaseSync;

  constructor(storageDir: string = config.STORAGE_DIR) {
    mkdirSync(storageDir, { recursive: true });
    this.db = new DatabaseSync(join(storageDir, DB_FILENAME));

    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");

    this.migrate();
    this.db.exec(SCHEMA);
    this.ensureColumns();
  }

  private ensureColumns(): void {
    const wanted: Record<string, Record<string, string>> = {
      documents: {
        source_path: "TEXT",
        byte_size: "INTEGER",
        ingest_stats: "TEXT",
      },
      messages: {
        passages: "TEXT NOT NULL DEFAULT '[]'",
      },
    };

    for (const [table, columns] of Object.entries(wanted)) {
      const present = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (column) => column.name,
        ),
      );
      if (present.size === 0) continue;

      for (const [column, definition] of Object.entries(columns)) {
        if (present.has(column)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };

    const columns = (this.db.prepare("PRAGMA table_info(chunks)").all() as { name: string }[]).map(
      (column) => column.name,
    );
    const existing = columns.length > 0;
    const documentColumns = (
      this.db.prepare("PRAGMA index_list(documents)").all() as { origin: string }[]
    ).length;
    const current = existing && columns.includes("heading_path") && documentColumns > 0;

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

  addDocument(
    notebook: string,
    document: Document,
    meta: {
      sourcePath?: string | null;
      byteSize?: number | null;
      stats?: IngestStats | null;
    } = {},
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO documents
           (document_id, notebook, title, filename, source_type, page_count, added_at,
            source_path, byte_size, ingest_stats)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        document.documentId,
        notebook,
        document.title,
        document.filename,
        document.sourceType,
        document.pageCount,
        document.addedAt,
        meta.sourcePath ?? null,
        meta.byteSize ?? null,
        meta.stats ? JSON.stringify(meta.stats) : null,
      );
  }

  setIngestStats(notebook: string, documentId: string, stats: IngestStats): void {
    this.db
      .prepare("UPDATE documents SET ingest_stats = ? WHERE notebook = ? AND document_id = ?")
      .run(JSON.stringify(stats), notebook, documentId);
  }

  documentsWithoutSource(): {
    notebook: string;
    documentId: string;
    filename: string;
    sourcePath: string | null;
  }[] {
    return this.db
      .prepare(
        `SELECT notebook, document_id AS documentId, filename,
                source_path AS sourcePath
           FROM documents ORDER BY notebook, filename`,
      )
      .all() as {
      notebook: string;
      documentId: string;
      filename: string;
      sourcePath: string | null;
    }[];
  }

  documentPath(documentId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT source_path FROM documents
          WHERE document_id = ? AND source_path IS NOT NULL LIMIT 1`,
      )
      .get(documentId) as { source_path: string } | undefined;
    return row?.source_path ?? null;
  }

  setSourcePath(documentId: string, sourcePath: string, byteSize: number | null): number {
    const result = this.db
      .prepare("UPDATE documents SET source_path = ?, byte_size = ? WHERE document_id = ?")
      .run(sourcePath, byteSize, documentId);
    return Number(result.changes);
  }

  getDocument(documentId: string): Document | null {
    const row = this.db
      .prepare("SELECT * FROM documents WHERE document_id = ? LIMIT 1")
      .get(documentId) as DocumentRow | undefined;
    return row ? toDocument(row) : null;
  }

  notebooksWith(documentId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM documents WHERE document_id = ?")
      .get(documentId) as { n: number };
    return row.n;
  }

  listNotebooks(): {
    notebook: string;
    sources: number;
    pages: number;
    addedAt: string;
    createdAt: string | null;
    lastMessageAt: string | null;
  }[] {
    const rows = this.db
      .prepare(
        `WITH names AS (
             SELECT notebook AS name FROM documents
             UNION SELECT name FROM notebooks
             UNION SELECT notebook FROM messages
           )
           SELECT names.name AS notebook,
                  (SELECT COUNT(*) FROM documents d WHERE d.notebook = names.name)
                    AS sources,
                  (SELECT COALESCE(SUM(page_count), 0) FROM documents d
                    WHERE d.notebook = names.name) AS pages,
                  (SELECT MIN(added_at) FROM documents d WHERE d.notebook = names.name)
                    AS added_at,
                  (SELECT created_at FROM notebooks n WHERE n.name = names.name)
                    AS created_at,
                  (SELECT MAX(created_at) FROM messages m WHERE m.notebook = names.name)
                    AS last_message_at
             FROM names
            ORDER BY COALESCE(
                       (SELECT MIN(added_at) FROM documents d WHERE d.notebook = names.name),
                       (SELECT created_at FROM notebooks n WHERE n.name = names.name),
                       ''
                     )`,
      )
      .all() as {
      notebook: string;
      sources: number;
      pages: number;
      added_at: string | null;
      created_at: string | null;
      last_message_at: string | null;
    }[];
    return rows.map((row) => ({
      notebook: row.notebook,
      sources: row.sources,
      pages: row.pages,
      addedAt: row.added_at ?? row.created_at ?? "",
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
    }));
  }

  createNotebook(name: string, createdAt: string = new Date().toISOString()): boolean {
    const existing = this.db.prepare("SELECT 1 FROM notebooks WHERE name = ?").get(name);
    if (existing !== undefined) return false;
    // A notebook that already holds documents exists without a row here.
    const held = this.db.prepare("SELECT 1 FROM documents WHERE notebook = ? LIMIT 1").get(name);
    this.db
      .prepare("INSERT OR IGNORE INTO notebooks (name, created_at) VALUES (?, ?)")
      .run(name, createdAt);
    return held === undefined;
  }

  deleteNotebook(name: string): { documentIds: string[]; messagesRemoved: number } {
    const documentIds = (
      this.db
        .prepare("SELECT document_id AS documentId FROM documents WHERE notebook = ?")
        .all(name) as { documentId: string }[]
    ).map((row) => row.documentId);

    this.db.prepare("DELETE FROM documents WHERE notebook = ?").run(name);
    const messages = this.db.prepare("DELETE FROM messages WHERE notebook = ?").run(name);
    this.db.prepare("DELETE FROM notebooks WHERE name = ?").run(name);

    return { documentIds, messagesRemoved: Number(messages.changes) };
  }

  notebookExists(name: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM notebooks WHERE name = ?
          UNION SELECT 1 FROM documents WHERE notebook = ?
          UNION SELECT 1 FROM messages WHERE notebook = ? LIMIT 1`,
      )
      .get(name, name, name);
    return row !== undefined;
  }

  sourcesIn(notebook: string): {
    document: Document;
    sourcePath: string | null;
    byteSize: number | null;
    stats: IngestStats | null;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM documents WHERE notebook = ? ORDER BY added_at")
      .all(notebook) as (DocumentRow & {
      source_path: string | null;
      byte_size: number | null;
      ingest_stats: string | null;
    })[];

    return rows.map((row) => ({
      document: toDocument(row),
      sourcePath: row.source_path,
      byteSize: row.byte_size,
      stats: parseObject<IngestStats>(row.ingest_stats),
    }));
  }

  listDocuments(notebook: string): Document[] {
    const rows = this.db
      .prepare("SELECT * FROM documents WHERE notebook = ? ORDER BY added_at")
      .all(notebook) as DocumentRow[];
    return rows.map(toDocument);
  }

  deleteDocument(
    notebook: string,
    documentId: string,
  ): { removed: boolean; chunksRemoved: boolean } {
    if (!this.hasDocument(notebook, documentId)) {
      return { removed: false, chunksRemoved: false };
    }
    const last = this.notebooksWith(documentId) === 1;
    this.db.exec("BEGIN");
    try {
      // chunks first: nothing should ever see chunks whose document is gone
      if (last) this.db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
      this.db
        .prepare("DELETE FROM documents WHERE notebook = ? AND document_id = ?")
        .run(notebook, documentId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { removed: true, chunksRemoved: last };
  }

  outline(documentId: string): OutlineSection[] {
    const rows = this.db
      .prepare(
        `SELECT heading_path AS headingPath,
                MIN(page_start) AS page,
                MIN(chunk_index) AS position
           FROM chunks
          WHERE document_id = ? AND parent_id IS NULL
          GROUP BY heading_path
          ORDER BY MIN(chunk_index)`,
      )
      .all(documentId) as { headingPath: string; page: number | null; position: number }[];

    const sections: OutlineSection[] = [];
    for (const row of rows) {
      const path = parseList<string>(row.headingPath);
      const title = path.at(-1);
      // A chunk before the first heading has an empty path and no title to show.
      if (!title) continue;
      sections.push({
        number: leadingNumber(title),
        title: stripLeadingNumber(title),
        page: row.page,
        depth: path.length,
      });
    }
    return sections;
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

  // ------------------------------------------------------------ conversation

  addMessage(message: Omit<ChatMessage, "messageId">): ChatMessage {
    const result = this.db
      .prepare(
        `INSERT INTO messages
           (notebook, role, text, created_at, citations, resolved_question, passages)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.notebook,
        message.role,
        message.text,
        message.createdAt,
        JSON.stringify(message.citations),
        message.resolvedQuestion,
        JSON.stringify(message.passages ?? []),
      );
    return { ...message, messageId: Number(result.lastInsertRowid) };
  }

  messages(notebook: string): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE notebook = ? ORDER BY message_id")
      .all(notebook) as MessageRow[];
    return rows.map(toMessage);
  }

  recentMessages(notebook: string, limit: number): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE notebook = ? ORDER BY message_id DESC LIMIT ?")
      .all(notebook, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  clearMessages(notebook: string): number {
    const result = this.db.prepare("DELETE FROM messages WHERE notebook = ?").run(notebook);
    return Number(result.changes);
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
