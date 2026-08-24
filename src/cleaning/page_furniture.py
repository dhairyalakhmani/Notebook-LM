import re
from collections import Counter
from src.models import DocumentPage
EDGE_LINES = 2      
REPEAT_RATIO = 0.6 
MIN_PAGES_TO_JUDGE = 3  
DIGITS = re.compile(r"\d+")
PAGE_NUMBER = re.compile(
    r"^(page\s*)?[ivxlcdm\d]+(\s*(/|of|-)\s*\d+)?$", re.IGNORECASE
)

def _fingerprint(text: str) -> str:
    """'Page 3 of 40' and 'Page 4 of 40' must look like the same line."""
    return DIGITS.sub("#", text.lower()).strip()

def find_furniture(pages: list[DocumentPage]) -> set[str]:
    if len(pages) < MIN_PAGES_TO_JUDGE:
        return set()
    counts: Counter[str] = Counter()
    for page in pages:
        edge = page.lines[:EDGE_LINES] + page.lines[-EDGE_LINES:]
        for fingerprint in {_fingerprint(line.text) for line in edge}:
            counts[fingerprint] += 1
    threshold = len(pages) * REPEAT_RATIO
    return {f for f, n in counts.items() if f and n >= threshold}

def strip_furniture(pages: list[DocumentPage]) -> list[DocumentPage]:
    furniture = find_furniture(pages)
    judgeable = len(pages) >= MIN_PAGES_TO_JUDGE
    cleaned: list[DocumentPage] = []
    for page in pages:
        last = len(page.lines) - 1
        kept = []
        for index, line in enumerate(page.lines):
            at_edge = index < EDGE_LINES or index > last - EDGE_LINES
            if _fingerprint(line.text) in furniture:
                continue
            if at_edge and judgeable and PAGE_NUMBER.match(line.text.strip()):
                continue
            kept.append(line)
        cleaned.append(
            DocumentPage(
                text = "\n".join(line.text for line in kept),
                page_number = page.page_number,
                source = page.source,
                lines = kept,
            )
        )
    return cleaned