from pathlib import Path
from src.loaders.base import DocumentLoader
from src.loaders.pdf_loader import PDFDocumentLoader
from src.loaders.text_loader import TextDocumentLoader
from src.models import DocumentPage
LOADERS: tuple[type[DocumentLoader], ...] = (PDFDocumentLoader, TextDocumentLoader)
def load_document(file_path: str) -> list[DocumentPage]:
    for loader_cls in LOADERS:
        if loader_cls.handles(file_path):
            return loader_cls(file_path).load()
    supported = sorted({ext for cls in LOADERS for ext in cls.extensions})
    raise ValueError(
        f"No loader for '{Path(file_path).suffix}'. Supported: {', '.join(supported)}"
    )
