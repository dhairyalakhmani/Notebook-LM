import re
import unicodedata
from dataclasses import replace
from src.models import DocumentPage, TextLine
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
SPACES = re.compile(r"[ \t\u00a0]+")
ENDS_HYPHENATED = re.compile(r"[A-Za-z]-$")
REPLACEMENTS = {
    "\u2018": "'", "\u2019": "'",   
    "\u201c": '"', "\u201d": '"',       
    "\u2013": "-", "\u2014": "-",        
    "\u2022": "-",                       
}

def normalize_line(text: str) -> str:
    text = unicodedata.normalize("NFKC", text) 
    for bad, good in REPLACEMENTS.items():
        text = text.replace(bad, good)
    text = CONTROL.sub("", text)
    return SPACES.sub(" ", text).strip()

def _merge_hyphenated(lines: list[TextLine]) -> list[TextLine]:
    merged: list[TextLine] = []
    for line in lines:
        previous = merged[-1] if merged else None
        if (
            previous is not None
            and ENDS_HYPHENATED.search(previous.text)
            and line.text[:1].islower()
        ):
            head, _, tail = line.text.partition(" ")
            merged[-1] = replace(previous, text = previous.text[:-1] + head)
            if tail:
                merged.append(replace(line, text = tail))
            continue
        merged.append(line)
    return merged

def normalize_pages(pages: list[DocumentPage]) -> list[DocumentPage]:
    cleaned: list[DocumentPage] = []
    for page in pages:
        lines = [replace(line, text = normalize_line(line.text)) for line in page.lines]
        lines = _merge_hyphenated([line for line in lines if line.text])
        cleaned.append(
            DocumentPage(
                text = "\n".join(line.text for line in lines),
                page_number = page.page_number,
                source = page.source,
                lines = lines,
            )
        )
    return cleaned