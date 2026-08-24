import sqlite3
from pathlib import Path
from src import config
from src.models import Chunk, Document
DB_FILENAME = "notebook.db"
SCHEMA = """
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
"""

def _to_document(row: sqlite3.Row) -> Document:
    return Document(
        document_id = row["document_id"],
        title = row["title"],
        filename = row["filename"],
        source_type = row["source_type"],
        page_count = row["page_count"],
        added_at = row["added_at"],
    )


def _to_chunk(row: sqlite3.Row) -> Chunk:
    return Chunk(
        chunk_id = row["chunk_id"],
        document_id = row["document_id"],
        parent_id = row["parent_id"],
        text = row["text"],
        page_number = row["page_number"],
        section_title = row["section_title"],
        token_count = row["token_count"],
    )

class NotebookStore:
    def __init__(self, storage_dir: str = config.STORAGE_DIR):
        directory = Path(storage_dir)
        directory.mkdir(parents = True, exist_ok = True)
        self.conn = sqlite3.connect(directory / DB_FILENAME)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def has_document(self, notebook: str, document_id: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM documents WHERE notebook = ? AND document_id = ?",
            (notebook, document_id),
        ).fetchone()
        return row is not None

    def add_document(self, notebook: str, document: Document) -> None:
        self.conn.execute(
            """INSERT OR REPLACE INTO documents
               (document_id, notebook, title, filename, source_type,
                page_count, added_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                document.document_id, notebook, document.title, document.filename,
                document.source_type, document.page_count, document.added_at,
            ),
        )
        self.conn.commit()

    def get_document(self, document_id: str) -> Document | None:
        row = self.conn.execute(
            "SELECT * FROM documents WHERE document_id = ?", (document_id,)
        ).fetchone()
        return _to_document(row) if row else None

    def list_documents(self, notebook: str) -> list[Document]:
        rows = self.conn.execute(
            "SELECT * FROM documents WHERE notebook = ? ORDER BY added_at",
            (notebook,),
        ).fetchall()
        return [_to_document(row) for row in rows]

    def add_chunks(self, chunks: list[Chunk]) -> None:
        self.conn.executemany(
            """INSERT OR REPLACE INTO chunks
               (chunk_id, document_id, parent_id, text, page_number,
                section_title, token_count)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    c.chunk_id, c.document_id, c.parent_id, c.text,
                    c.page_number, c.section_title, c.token_count,
                )
                for c in chunks
            ],
        )
        self.conn.commit()

    def get_chunks(self, chunk_ids: list[str]) -> dict[str, Chunk]:
        found: dict[str, Chunk] = {}
        for start in range(0, len(chunk_ids), 500):
            batch = chunk_ids[start : start + 500]
            marks = ",".join("?" * len(batch))
            rows = self.conn.execute(
                f"SELECT * FROM chunks WHERE chunk_id IN ({marks})", batch
            ).fetchall()
            for row in rows:
                found[row["chunk_id"]] = _to_chunk(row)
        return found

    def child_chunks(self, notebook: str) -> list[Chunk]:
        rows = self.conn.execute(
            """SELECT c.* FROM chunks c
               JOIN documents d ON d.document_id = c.document_id
               WHERE d.notebook = ? AND c.parent_id IS NOT NULL
               ORDER BY c.chunk_id""",
            (notebook,),
        ).fetchall()
        return [_to_chunk(row) for row in rows]

    def close(self) -> None:
        self.conn.close()