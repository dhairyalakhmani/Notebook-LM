import json
from pydantic import BaseModel, ValidationError
from src.llm.client import LLMClient
from src.models import Section
BATCH_SIZE = 6
PROFILE_SAMPLE_SECTIONS = 4
PROFILE_SAMPLE_CHARS = 600
MIN_CANONICAL_LABELS = 3
CONSOLIDATION_RATIO = 0.6
class LabelItem(BaseModel):
    id: str
    categories: list[str]
    keywords: list[str]

class LabelResponse(BaseModel):
    results: list[LabelItem]

class ConsolidateResponse(BaseModel):
    canonical: dict[str, str]

class DocumentProfile(BaseModel):
    description: str
    example_categories: list[str]

GENERIC_PROFILE = DocumentProfile(
    description = "type unknown - infer it from the sections themselves",
    example_categories = ["recurring concerns, patterns, or decisions"],
)

PROFILE_PROMPT = """Below are titles and excerpts from one document.

Reply with JSON only:
{"description": "...", "example_categories": ["...", "..."]}

- "description": one sentence naming what kind of document this is and what it covers.
- "example_categories": 4-6 example labels for cross-cutting THEMES that sections of
  a document like this could share. A theme is a recurring idea or concern, not a
  restatement of a section's topic. For a database design document that might be
  "denormalization" or "audit trail"; for a legal contract, "indemnity" or
  "termination rights"; for a research paper, "sampling bias" or "reproducibility".

Document:

"""

LABEL_PROMPT_TEMPLATE = """You are tagging sections of the following document.

Document: {description}

Every section title in the document, so you can see what runs across them:
{outline}

For each section, return:
- "categories": 2-4 broad THEMES that this section demonstrates.
  A theme is a cross-cutting idea that could also appear in other sections.
  It must NOT simply restate what the section is about, and it must be a label
  that at least one other section in the outline above could also carry.
  Examples of the right kind of label for this document: {examples}.
- "keywords": 3-6 specific terms taken verbatim from the section itself.

Use lowercase for every label. Reuse the same wording across sections when the
idea is the same - consistency matters more than variety.

Reply with JSON only, in exactly this shape:
{{"results": [{{"id": "s01", "categories": ["..."], "keywords": ["..."]}}]}}

Include one entry for every section id given below. Sections:

"""

CONSOLIDATE_PROMPT_TEMPLATE = """Below is a list of category labels produced
independently for different sections of one document, described as:
{description}

Merge them into a shared vocabulary of about {target} labels. Merge two ways:
- Duplicates worded differently ("audit trail", "auditing", "audit logging").
- A narrow label into the broader theme it is an instance of, when several narrow
  labels point at the same underlying concern.

A label only earns its place if more than one section could carry it. A label that
merely restates one section's topic should be merged into something more general.
A label that is already canonical maps to itself.

Reply with JSON only:
{{"canonical": {{"original label": "canonical label"}}}}

Every label below must appear as a key. Labels:

"""

def _format_batch(batch: list[Section]) -> str:
    parts = []
    for section in batch:
        parts.append(
            f"id: {section.section_id}\n"
            f"title: {section.title}\n"
            f"text: {section.text}\n"
        )
    return "\n---\n".join(parts)

def _parse(raw: str, model: type[BaseModel]):
    try:
        return model.model_validate(json.loads(raw))
    except (json.JSONDecodeError, ValidationError) as exc:
        print(f"  ! could not parse response: {exc}")
        return None

def _apply(section: Section, item: LabelItem) -> None:
    section.categories = [c.lower().strip() for c in item.categories]
    section.keywords = [k.lower().strip() for k in item.keywords]

def _label_prompt(profile: DocumentProfile, sections: list[Section]) -> str:
    return LABEL_PROMPT_TEMPLATE.format(
        description = profile.description,
        outline = "\n".join(f"- {s.title}" for s in sections),
        examples = ", ".join(profile.example_categories),
    )

def profile_document(sections: list[Section], llm: LLMClient) -> DocumentProfile:
    sample = "\n\n---\n\n".join(
        f"{s.title}\n{s.text[:PROFILE_SAMPLE_CHARS]}"
        for s in sections[:PROFILE_SAMPLE_SECTIONS]
    )
    profile = _parse(
        llm.generate(PROFILE_PROMPT + sample, json_mode = True), DocumentProfile
    )
    if profile is None:
        print("  ! profiling failed, using the generic prompt")
        return GENERIC_PROFILE
    print(f"  document looks like: {profile.description}")
    return profile

def label_sections(
    sections: list[Section],
    llm: LLMClient,
    profile: DocumentProfile = GENERIC_PROFILE,
) -> None:
    prompt = _label_prompt(profile, sections)
    by_id = {s.section_id: s for s in sections}
    for start in range(0, len(sections), BATCH_SIZE):
        batch = sections[start : start + BATCH_SIZE]
        ids = [s.section_id for s in batch]
        print(f"  labelling {ids[0]}..{ids[-1]}")
        parsed = _parse(
            llm.generate(prompt + _format_batch(batch), json_mode = True),
            LabelResponse,
        )
        if parsed:
            for item in parsed.results:
                section = by_id.get(item.id)
                if section is not None:
                    _apply(section, item)
    for section in sections:
        if section.categories:
            continue
        print(f"  retrying {section.section_id} on its own")
        parsed = _parse(
            llm.generate(prompt + _format_batch([section]), json_mode = True),
            LabelResponse,
        )
        if parsed and parsed.results:
            _apply(section, parsed.results[0])

def consolidate_categories(
    sections: list[Section],
    llm: LLMClient,
    profile: DocumentProfile = GENERIC_PROFILE,
) -> dict[str, str]:
    labels = sorted({c for s in sections for c in s.categories})
    if not labels:
        return {}
    target = max(MIN_CANONICAL_LABELS, round(len(labels) * CONSOLIDATION_RATIO))
    prompt = CONSOLIDATE_PROMPT_TEMPLATE.format(
        description = profile.description, target = target
    )
    print(f"  {len(labels)} labels -> aiming for about {target}")
    parsed = _parse(
        llm.generate(
            prompt + "\n".join(f"- {label}" for label in labels), json_mode = True
        ),
        ConsolidateResponse,
    )
    if parsed is None:
        print("  ! consolidation failed, keeping original labels")
        return {}
    for section in sections:
        section.categories = sorted(
            {parsed.canonical.get(c, c).lower().strip() for c in section.categories}
        )
    return parsed.canonical
