from sentence_transformers import SentenceTransformer
from src import config
from src.embedding.base import Embedder
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
BATCH_SIZE = 64

class HFEmbedder(Embedder):
    def __init__(self, model_name: str = config.EMBEDDING_MODEL):
        self.model = SentenceTransformer(model_name)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        vectors = self.model.encode(
            texts,
            batch_size = BATCH_SIZE,
            normalize_embeddings = True,
            show_progress_bar = len(texts) > 200,
            convert_to_numpy = True,
        )
        return [vector.tolist() for vector in vectors]

    def embed_query(self, text: str) -> list[float]:
        vector = self.model.encode(
            QUERY_PREFIX + text,
            normalize_embeddings = True,
            convert_to_numpy = True,
        )
        return vector.tolist()

_EMBEDDER: HFEmbedder | None = None

def get_embedder() -> HFEmbedder:
    global _EMBEDDER
    if _EMBEDDER is None:
        _EMBEDDER = HFEmbedder()
    return _EMBEDDER