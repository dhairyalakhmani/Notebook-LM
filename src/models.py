from dataclasses import dataclass
@dataclass
class DocumentPage:
    text: str
    page_number: int
    source: str
@dataclass
class DocumentChunk:
    text: str
    source: str
    page_number: int | None
    chunk_id: int
    document_id: int
    section: str | None
    parent_id: str | None
