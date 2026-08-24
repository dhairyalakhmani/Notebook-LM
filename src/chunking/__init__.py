from src.chunking.base import Chunker
from src.chunking.heading_chunker import HeadingChunker
from src.chunking.token_window_chunker import TokenWindowChunker
from src.models import DocumentPage, Section
MIN_USEFUL_SECTIONS = 3
def chunk_document(pages: list[DocumentPage]) -> tuple[list[Section], str]:
    sections = HeadingChunker().split(pages)
    if len(sections) >= MIN_USEFUL_SECTIONS:
        return sections, "headings"
    return TokenWindowChunker().split(pages), "token windows"
