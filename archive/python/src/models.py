import hashlib
from dataclasses import dataclass, field
from pathlib import Path
READ_BLOCK = 1 << 20
ID_LENGTH = 12

def document_id_for_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while block := handle.read(READ_BLOCK):
            digest.update(block)
    return digest.hexdigest()[:ID_LENGTH]

@dataclass
class Document:
    """One source inside a notebook."""
    document_id: str
    title: str
    filename: str
    source_type: str
    page_count: int
    added_at: str


@dataclass
class Chunk:
    chunk_id: str
    document_id: str
    parent_id: str | None
    text: str
    page_number: int | None
    section_title: str | None
    token_count: int
    @property
    def is_child(self) -> bool:
        return self.parent_id is not None

@dataclass
class TextLine:
    text: str
    page_number: int
    font_size: float | None = None
    is_bold: bool = False
    heading_level: int | None = None

@dataclass
class DocumentPage:
    text: str
    page_number: int
    source: str
    lines: list[TextLine] = field(default_factory=list)
    
@dataclass
class Section:
    section_id: str
    title: str
    text: str
    source: str
    page_number: int | None
    parent_heading: str | None
    token_count: int