import re
from rank_bm25 import BM25Okapi
from src.models import Chunk
from src.notebook.store import NotebookStore
WORD = re.compile(r"[a-z0-9_]+")

def tokenize(text: str) -> list[str]:
    return WORD.findall(text.lower())

class KeywordIndex:
    def __init__(self, chunk_ids: list[str], corpus: list[list[str]]):
        self.chunk_ids = chunk_ids
        self.bm25 = BM25Okapi(corpus) if corpus else None
        
    @classmethod
    def for_notebook(
        cls, notebook: str, store: NotebookStore | None = None
    ) -> "KeywordIndex":
        chunks: list[Chunk] = (store or NotebookStore()).child_chunks(notebook)
        return cls(
            [chunk.chunk_id for chunk in chunks],
            [tokenize(chunk.text) for chunk in chunks],
        )

    def search(self, query: str, k: int) -> list[tuple[str, float]]:
        """Returns [(chunk_id, bm25_score)], best first, zero-scores dropped."""
        if self.bm25 is None:
            return []
        scores = self.bm25.get_scores(tokenize(query))
        ranked = sorted(zip(self.chunk_ids, scores), key = lambda pair: pair[1],
                        reverse = True)
        return [(chunk_id, float(score)) for chunk_id, score in ranked[:k] if score > 0] 