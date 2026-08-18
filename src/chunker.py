import re
from uuid import uuid4
from src.config import ChunkingConfig
from src.models import DocumentChunk, DocumentPage
from src.tokenizer import TokenCounter
class RecursiveChunker:
    def __init__(self,token_counter: TokenCounter,config: ChunkingConfig,):
        self.token_counter = token_counter
        self.config = config
    def chunk_pages(self,pages: list[DocumentPage],document_id: str) -> list[DocumentChunk]:
        chunks = []
        for page in pages:
            sections = self._extract_sections(page.text)
            for section_title, section_text in sections:
                parent_id = str(uuid4())
                parent_text = section_text.strip()
                child_texts = self._recursive_split(
                    parent_text,
                    self.config.child_target_tokens,
                )
                for child_text in child_texts:
                    chunks.append(
                        DocumentChunk(
                            chunk_id=str(uuid4()),
                            document_id=document_id,
                            parent_id=parent_id,
                            text=child_text,
                            source=page.source,
                            page_number=page.page_number,
                            section=section_title,
                        )
                    )
        return chunks
    def _extract_sections(
        self,
        text: str,
    ) -> list[tuple[str | None, str]]:
        lines = [
            line.strip()
            for line in text.splitlines()
            if line.strip()
        ]
        sections = []
        current_title = None
        current_lines = []
        for line in lines:
            if self._looks_like_heading(line):
                if current_lines:
                    sections.append(
                        (
                            current_title,
                            "\n".join(current_lines),
                        )
                    )
                current_title = line
                current_lines = []
            else:
                current_lines.append(line)
        if current_lines:
            sections.append(
                (
                    current_title,
                    "\n".join(current_lines),
                )
            )
        return sections
    def _looks_like_heading(self, line: str) -> bool:
        return bool(
            re.match(
                r"^\d+(\.\d+)*\s+[A-Z][A-Z\s&-]+$",
                line,
            )
        )
    def _recursive_split(
        self,
        text: str,
        max_tokens: int,
    ) -> list[str]:
        if self.token_counter.count(text) <= max_tokens:
            return [text]
        paragraphs = [
            p.strip()
            for p in re.split(r"\n\s*\n", text)
            if p.strip()
        ]
        if len(paragraphs) > 1:
            return self._combine_parts(
                paragraphs,
                max_tokens,
            )
        sentences = [
            s.strip()
            for s in re.split(
                r"(?<=[.!?])\s+",
                text,
            )
            if s.strip()
        ]
        if len(sentences) > 1:
            return self._combine_parts(
                sentences,
                max_tokens,
            )
        return self._split_by_tokens(
            text,
            max_tokens,
        )
    def _combine_parts(
        self,
        parts: list[str],
        max_tokens: int,
    ) -> list[str]:
        chunks = []
        current = []
        for part in parts:
            candidate = " ".join(
                current + [part]
            )
            if (
                current
                and self.token_counter.count(candidate)
                > max_tokens
            ):
                chunks.append(
                    " ".join(current)
                )
                current = [part]

            else:
                current.append(part)
        if current:
            chunks.append(
                " ".join(current)
            )
        return chunks
    def _split_by_tokens(
        self,
        text: str,
        max_tokens: int,
    ) -> list[str]:
        tokens = self.token_counter.encode(text)
        chunks = []
        for start in range(
            0,
            len(tokens),
            max_tokens,
        ):
            chunk_tokens = tokens[
                start:start + max_tokens
            ]
            chunks.append(
                self.token_counter.decode(
                    chunk_tokens
                )
            )
        return chunks