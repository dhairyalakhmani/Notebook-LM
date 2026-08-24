from collections import Counter
from src.chunking.base import Chunker
from src.chunking.token_window_chunker import TokenWindowChunker
from src.models import DocumentPage, Section, TextLine
from src.tokenizer import TiktokenCounter
HEADING_SIZE_RATIO = 1.15
MAX_HEADING_WORDS = 14
SENTENCE_ENDINGS = (".", ",", ";")
BRACKET_PAIRS = (("(", ")"), ("[", "]"), ("{", "}"))
DEFAULT_MIN_TOKENS = 20
DEFAULT_MAX_TOKENS = 400
def _body_font_size(lines: list[TextLine]) -> float | None:
    weights: Counter[float] = Counter()
    for line in lines:
        if line.font_size is not None and not line.is_bold:
            weights[line.font_size] += len(line.text)
    if not weights:
        return None
    return weights.most_common(1)[0][0]

def _is_heading(line: TextLine, body_size: float | None) -> bool:
    if line.heading_level is not None:
        return True
    if body_size is None or line.font_size is None:
        return False
    if len(line.text.split()) > MAX_HEADING_WORDS:
        return False
    if line.text.endswith(SENTENCE_ENDINGS):
        return False
    return line.is_bold or line.font_size > body_size * HEADING_SIZE_RATIO

def _is_unterminated(text: str) -> bool:
    if text.count('"') % 2 == 1:
        return True
    return any(text.count(o) > text.count(c) for o, c in BRACKET_PAIRS)

class HeadingChunker(Chunker):
    def __init__(
        self,
        min_tokens: int = DEFAULT_MIN_TOKENS,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        counter: TiktokenCounter | None = None,
    ):
        self.min_tokens = min_tokens
        self.max_tokens = max_tokens
        self.counter = counter or TiktokenCounter()

    def split(self, pages: list[DocumentPage]) -> list[Section]:
        lines = [line for page in pages for line in page.lines]
        if not lines:
            return []
        body_size = _body_font_size(lines)
        raw: list[dict] = []
        current: dict | None = None
        for line in lines:
            if _is_heading(line, body_size):
                if (
                    current is not None
                    and not current["body"]
                    and _is_unterminated(current["title"])
                ):
                    current["title"] = f"{current['title']} {line.text}"
                    continue
                current = {
                    "title": line.text,
                    "page_number": line.page_number,
                    "body": [],
                }
                raw.append(current)
            elif current is not None:
                current["body"].append(line.text)
        return self._build_sections(raw, pages[0].source)

    def _build_sections(self, raw: list[dict], source: str) -> list[Section]:
        parent: str | None = None
        sections: list[Section] = []
        windower = TokenWindowChunker(
            max_tokens = self.max_tokens, counter = self.counter
        )
        for item in raw:
            body = "\n".join(item["body"]).strip()
            if not body:
                parent = item["title"]
                continue
            tokens = self.counter.count(body)
            if sections and tokens < self.min_tokens:
                previous = sections[-1]
                previous.text = f"{previous.text}\n{item['title']}\n{body}"
                previous.token_count = self.counter.count(previous.text)
                continue
            pieces = windower.windows(body) if tokens > self.max_tokens else [body]
            for index, piece in enumerate(pieces, start = 1):
                title = item["title"]
                if len(pieces) > 1:
                    title = f"{title} (part {index}/{len(pieces)})"
                sections.append(
                    Section(
                        section_id = f"s{len(sections) + 1:02d}",
                        title = title,
                        text = piece,
                        source = source,
                        page_number = item["page_number"],
                        parent_heading = parent,
                        token_count = self.counter.count(piece),
                    )
                )
        return sections
