import pymupdf
from src.loaders.base import DocumentLoader
from src.models import DocumentPage, TextLine
Y_TOLERANCE = 3.0
BOLD_FLAG = 1 << 4
def _lines_in_reading_order(page, page_number: int) -> list[TextLine]:
    spans = []
    for block in page.get_text("dict")["blocks"]:
        if block["type"] != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                if span["text"].strip():
                    spans.append(span)

    spans.sort(key=lambda s: s["bbox"][1])
    bands: list[tuple[float, list[dict]]] = []
    for span in spans:
        top = span["bbox"][1]
        if bands and abs(top - bands[-1][0]) <= Y_TOLERANCE:
            bands[-1][1].append(span)
        else:
            bands.append((top, [span]))

    lines = []
    for _, band in bands:
        band.sort(key=lambda s: s["bbox"][0])
        text = "".join(s["text"] for s in band).strip()
        if not text:
            continue
        dominant = max(band, key=lambda s: len(s["text"]))
        lines.append(
            TextLine(
                text = text,
                page_number = page_number,
                font_size = round(dominant["size"], 1),
                is_bold = all(s["flags"] & BOLD_FLAG for s in band),
            )
        )
    return lines

class PDFDocumentLoader(DocumentLoader):
    extensions = (".pdf",)
    def load(self) -> list[DocumentPage]:
        self._validate()
        pages = []
        with pymupdf.open(self.file_path) as pdf:
            for page_number, page in enumerate(pdf, start = 1):
                lines = _lines_in_reading_order(page, page_number)
                pages.append(
                    DocumentPage(
                        text = "\n".join(line.text for line in lines),
                        page_number = page_number,
                        source = self.file_path.name,
                        lines = lines,
                    )
                )
        return pages
