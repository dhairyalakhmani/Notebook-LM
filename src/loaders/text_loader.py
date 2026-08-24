import re
from src.loaders.base import DocumentLoader
from src.models import DocumentPage, TextLine
MARKDOWN_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
class TextDocumentLoader(DocumentLoader):
    extensions = (".txt", ".md", ".markdown")
    def load(self) -> list[DocumentPage]:
        self._validate()
        raw = self.file_path.read_text(encoding = "utf-8", errors = "replace")
        lines = []
        for line in raw.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            heading = MARKDOWN_HEADING.match(stripped)
            if heading:
                lines.append(
                    TextLine(
                        text = heading.group(2),
                        page_number = 1,
                        heading_level = len(heading.group(1)),
                    )
                )
            else:
                lines.append(TextLine(text = stripped, page_number = 1))
        return [
            DocumentPage(
                text = "\n".join(line.text for line in lines),
                page_number = 1,
                source = self.file_path.name,
                lines = lines,
            )
        ]
