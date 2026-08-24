from abc import ABC, abstractmethod
from pathlib import Path
from src.models import DocumentPage
class DocumentLoader(ABC):
    extensions: tuple[str, ...] = ()
    def __init__(self, file_path: str):
        self.file_path = Path(file_path)
    @classmethod
    def handles(cls, file_path: str) -> bool:
        return Path(file_path).suffix.lower() in cls.extensions
    def _validate(self) -> None:
        if not self.file_path.exists():
            raise FileNotFoundError(f"File not found: {self.file_path}")
        if self.file_path.suffix.lower() not in self.extensions:
            raise ValueError(
                f"{type(self).__name__} expects one of {self.extensions}, "
                f"got: {self.file_path.suffix}"
            )
    @abstractmethod
    def load(self) -> list[DocumentPage]:
        pass
