from pathlib import Path
import chromadb
from src import config
from src.models import Chunk
COLLECTION_NAME = "child_chunks"

class VectorStore:
    def __init__(self, storage_dir: str = config.STORAGE_DIR):
        path = Path(storage_dir) / "chroma"
        path.mkdir(parents = True, exist_ok = True)
        self.client = chromadb.PersistentClient(path = str(path))
        self.collection = self.client.get_or_create_collection(
            name = COLLECTION_NAME,
            metadata = {"hnsw:space": "cosine"},
        )

    def add(self, notebook: str, chunks: list[Chunk], vectors: list[list[float]]) -> None:
        if not chunks:
            return
        self.collection.upsert(
            ids = [c.chunk_id for c in chunks],
            embeddings = vectors,
            documents = [c.text for c in chunks],
            metadatas = [
                {
                    "notebook": notebook,
                    "document_id": c.document_id,
                    "parent_id": c.parent_id or "",
                    "page_number": c.page_number if c.page_number is not None else -1,
                    "section_title": c.section_title or "",
                }
                for c in chunks
            ],
        )

    def search(
        self, notebook: str, vector: list[float], k: int
    ) -> list[tuple[str, float]]:
        if self.collection.count() == 0:
            return []
        result = self.collection.query(
            query_embeddings = [vector],
            n_results = k,
            where = {"notebook": notebook},
        )
        ids = result["ids"][0]
        distances = result["distances"][0]
        return [(chunk_id, 1.0 - distance) for chunk_id, distance in zip(ids, distances)]

    def delete_document(self, document_id: str) -> None:
        self.collection.delete(where = {"document_id": document_id})

    def count(self) -> int:
        return self.collection.count()