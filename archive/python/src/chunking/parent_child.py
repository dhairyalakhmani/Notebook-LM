from src import config
from src.chunking import chunk_document
from src.chunking.token_window_chunker import TokenWindowChunker
from src.models import Chunk, DocumentPage, Section
from src.tokenizer import TiktokenCounter

def heading_path(section: Section) -> str:
    parts = [part for part in (section.parent_heading, section.title) if part]
    return " > ".join(parts)

def build_parent_child(
    pages: list[DocumentPage],
    document_id: str,
    counter: TiktokenCounter | None = None,
) -> tuple[list[Chunk], list[Chunk]]:
    counter = counter or TiktokenCounter()
    sections, strategy = chunk_document(pages)
    print(f"  chunked by {strategy}: {len(sections)} section(s)")
    parent_windower = TokenWindowChunker(
        max_tokens = config.PARENT_MAX_TOKENS, overlap_tokens = 0, counter = counter
    )
    child_windower = TokenWindowChunker(
        max_tokens = config.CHILD_MAX_TOKENS,
        overlap_tokens = config.CHILD_OVERLAP_TOKENS,
        counter = counter,
    )
    parents: list[Chunk] = []
    children: list[Chunk] = []

    for section in sections:
        path = heading_path(section)
        blocks = (
            [section.text]
            if section.token_count <= config.PARENT_MAX_TOKENS
            else parent_windower.windows(section.text)
        )
        for block in blocks:
            parent_id = f"{document_id}-p{len(parents) + 1:04d}"
            parents.append(
                Chunk(
                    chunk_id = parent_id,
                    document_id = document_id,
                    parent_id = None,
                    text = block,
                    page_number = section.page_number,
                    section_title = path or None,
                    token_count = counter.count(block),
                )
            )
            for piece in child_windower.windows(block):
                text = f"{path}\n{piece}" if path else piece
                children.append(
                    Chunk(
                        chunk_id = f"{document_id}-c{len(children) + 1:05d}",
                        document_id = document_id,
                        parent_id = parent_id,
                        text = text,
                        page_number = section.page_number,
                        section_title = path or None,
                        token_count = counter.count(text),
                    )
                )
    return parents, children