from abc import ABC, abstractmethod
from src.models import DocumentPage, Section
class Chunker(ABC):
    @abstractmethod
    def split(self, pages: list[DocumentPage]) -> list[Section]:
        pass
