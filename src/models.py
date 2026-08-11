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
    page_number: int
    chunk_id: int
