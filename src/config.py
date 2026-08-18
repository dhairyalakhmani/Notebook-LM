from dataclasses import dataclass
@dataclass(frozen = True)
class ChunkingConfig:
    parent_target_tokens: int = 2000
    child_target_tokens: int = 500
    child_overlap_tokens: int = 50
    