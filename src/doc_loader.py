from pathlib import Path
import fitz
from src.models import DocumentPage
class PDFDocumentLoader:
    def __init__(self, file_path: str):
        self.file_path = Path(file_path)

    def load(self) -> list[DocumentPage]:
        if not self.file_path.exists():
            raise FileNotFoundError(
                f"PDF file not found: {self.file_path}"
            )
        if self.file_path.suffix.lower() != ".pdf":
            raise ValueError(
                f"Expected a PDF file, got: {self.file_path.suffix}"
            )
        pages = []
        with fitz.open(self.file_path) as pdf:
            for page_number, page in enumerate(pdf, start = 1):
                pages.append(
                    DocumentPage(
                        text = page.get_text(),
                        page_number = page_number,
                        source = self.file_path.name,
                    )
                )
        return pages