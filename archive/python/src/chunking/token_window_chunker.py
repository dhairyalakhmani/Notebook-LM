from src.chunking.base import Chunker
from src.models import DocumentPage, Section
from src.tokenizer import TiktokenCounter
DEFAULT_MAX_TOKENS = 400
DEFAULT_OVERLAP_TOKENS = 60
class TokenWindowChunker(Chunker):
    def __init__(
        self,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
        counter: TiktokenCounter | None = None,
    ):
        self.max_tokens = max_tokens
        self.overlap_tokens = overlap_tokens
        self.counter = counter or TiktokenCounter()

    def windows(self, text: str) -> list[str]:
        blocks = [b.strip() for b in text.split("\n") if b.strip()]
        if not blocks:
            return []
        sized = [(b, self.counter.count(b)) for b in blocks]
        windows: list[str] = []
        current: list[tuple[str, int]] = []
        total = 0
        for block, size in sized:
            if current and total + size > self.max_tokens:
                windows.append("\n".join(b for b, _ in current))
                carried: list[tuple[str, int]] = []
                carried_total = 0
                for item in reversed(current):
                    if carried_total + item[1] > self.overlap_tokens:
                        break
                    carried.insert(0, item)
                    carried_total += item[1]
                current, total = carried, carried_total
            current.append((block, size))
            total += size
        if current:
            windows.append("\n".join(b for b, _ in current))
        return windows

    def split(self, pages: list[DocumentPage]) -> list[Section]:
        if not pages:
            return []
        source = pages[0].source
        text = "\n".join(page.text for page in pages)
        sections = []
        for window in self.windows(text):
            sections.append(
                Section(
                    section_id = f"s{len(sections) + 1:02d}",
                    title = f"{source} (part {len(sections) + 1})",
                    text = window,
                    source = source,
                    page_number = pages[0].page_number,
                    parent_heading = None,
                    token_count = self.counter.count(window),
                )
            )
        return sections
