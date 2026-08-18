from abc import ABC, abstractmethod
import tiktoken
class TokenCounter(ABC):
    @abstractmethod
    def count(self, text: str) -> int:
        pass
    @abstractmethod
    def encode(self, text: str) -> list[int]:
        pass
    @abstractmethod
    def decode(self, tokens: list[int]) -> str:
        pass
    

class TiktokenCounter(TokenCounter):
    def __init__(self, encoding_name: str = "cl100k_base"):
        self.encoder = tiktoken.get_encoding(encoding_name)
    def count(self, text: str) -> int:
        return len(self.encoder.encode(text))
    def encode(self, text: str) -> list[int]:
        return self.encoder.encode(text)
    def decode(self, token: list[int]) -> str:
        return self.encoder.decode(tokens)

counter = TiktokenCounter()
print(counter.count("It is recommended to install tiktoken within an activated virtual environment to prevent dependency conflicts:"))