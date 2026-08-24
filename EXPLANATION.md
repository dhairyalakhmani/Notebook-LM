# EXPLANATION.md — what changed and why

Two rounds of work are recorded here.

**Round 1** implemented STEPS.md: switch the LLM client to Groq, fix the PDF text
extraction, chunk the document, and group chunks by LLM-assigned labels.

**Round 2** removed the assumption that the document is *this particular PDF*.
Round 1 worked, but only on `Schema Architecture Notes.pdf` — it matched literal
strings like `"Frequent Queries:"` and a regex shaped like `Customer_Violation`.
Round 2 replaced every such rule with something derived from the document itself.

---

# Part 1 — The STEPS.md changes

## The problem being solved

Chunking decides what the LLM sees. The model does not go and find the right text;
it reads the box you hand it and writes tags on that box. If a chunk contains fields
from three different tables, the tags describe none of them. Everything below exists
to make the boxes correct before spending a single API call on them.

## 1. Groq instead of OpenAI (`src/llm/client.py`)

The only key available is `GROQ_API_KEY`, but the client was written for OpenAI.
Groq exposes an OpenAI-compatible API, so the `openai` package still works with a
different `base_url`. Two changes were needed:

| Before | After | Why |
|---|---|---|
| `OpenAI()` | `OpenAI(api_key=..., base_url="https://api.groq.com/openai/v1")` | points the same library at Groq |
| `client.responses.create(...)` | `client.chat.completions.create(...)` | `chat.completions` is the endpoint Groq supports |

`load_dotenv()` reads the key from `.env` so it never has to be typed into the shell,
and a missing key raises a named error instead of failing later inside the HTTP layer.

`generate(prompt, json_mode=True)` sets `response_format={"type": "json_object"}`,
which forces valid JSON instead of prose. Every later pass depends on that.

## 2. The PDF text was scrambled (`src/doc_loader.py`)

This was a genuine bug, not a style problem. `page.get_text()` returned the four
table headings **piled at the bottom of the page**, far from the fields they belong to:

```
customer_id (PK): The surrogate key...      <- belongs under Customer
branch_id (PK): Uniquely identifies...      <- belongs under Branch
Customer                                     <- the headings, stranded at the end
Branch
```

**Cause.** A PDF does not store paragraphs. It stores positioned fragments — *spans* —
each with an x/y coordinate. The order they are emitted in is whatever order the
generator wrote them, which is not reading order.

**Fix.** Ignore the given order. Collect every span, sort by y (top to bottom), then
by x (left to right) within a line, and rebuild the lines.

**The gotcha.** Spans on the same visual line can differ in y by about 0.2, because
the 11.3pt code font and the 12pt prose font sit at slightly different heights. Exact
y grouping produces gibberish like `(PK), (FK), , ,`. Grouping anything within **3
points** into one line fixes it. That is `Y_TOLERANCE = 3.0`.

Also switched `import fitz` to `import pymupdf` — same library, `fitz` is the
deprecated name.

## 3. Splitting into sections

With headings back in the right place, splitting became straightforward: one chunk per
database table, plus one per SQL query. Round 1 detected headings with a regex shaped
like a table name, excluded the literal string `"SQL"`, and switched behaviour when it
saw the line `"Frequent Queries:"`. **This is what Round 2 replaced.**

A new `Section` dataclass was added to `src/models.py`. `ParentChunk` and `ChildChunk`
were left untouched — they are reserved for later, when a section grows too big and
needs to become a parent with children.

Section IDs are short (`s01`, `s02`) rather than UUIDs. This is deliberate: the IDs
are sent to the model and asked for back, and models copy short IDs far more reliably
than long random ones.

## 4. Two bugs in `src/tokenizer.py`

1. `decode` took a parameter named `token` but its body used `tokens` — a `NameError`
   on first call.
2. The last two lines constructed a `TiktokenCounter()` and printed at module level,
   so a stray number appeared every time anything imported the file. Deleted.

## 5. Labelling with Groq (`src/llm/categorizer.py`)

Groq has no embeddings endpoint — it runs chat models. So instead of embedding chunks
and comparing vectors, a chat model *describes* each chunk and shared descriptions
stand in for similarity. The labels are readable, so when grouping looks wrong you can
see why.

Two passes, because one is not enough:

**Pass A — label.** Sections go to the model in batches of 6, and it returns
`categories` (broad themes) and `keywords` (specific terms).

**Pass B — consolidate.** When a model invents labels freely it drifts: chunk 3 gets
`audit trail`, chunk 11 gets `auditing`, chunk 14 gets `audit logging`. Those are one
idea under three names, so grouping by exact match silently finds nothing. Pass B shows
the model every label at once and asks it to merge duplicates into one canonical name.

`pydantic` validates each reply. A malformed response fails loudly at one known place
instead of surfacing as a confusing `KeyError` later. A retry loop re-asks for any
section a batch dropped — models occasionally return 5 items when asked for 6.

## 6. `main.py`

`sys.stdout.reconfigure(encoding="utf-8")` runs first. The default PowerShell console
cannot print outside its legacy codepage, so a single emoji or curly quote in a label
raises `UnicodeEncodeError` — at the *end* of the run, after every API call is paid for.

## Round 1 result

22 sections, 2141 tokens, no parse failures, no retries. All three sanity checks from
STEPS.md passed.

---

# Part 2 — Making it work on any document

## The problem

Round 1's splitter could only ever work on one file:

```python
TABLE_HEADING = re.compile(r"^[A-Z][A-Za-z0-9]*(_[A-Za-z0-9]+)*...")
NOT_HEADINGS  = {"SQL"}
QUERIES_MARKER = "Frequent Queries:"
```

A heading was recognised by *looking like a database table name*. The label prompt
opened with "You are tagging sections of a database design document." Point it at a
lease, a paper, or a manual and it produces one giant chunk with meaningless tags.

## The insight

The original PDF already carried its own structure — Round 1 just threw it away by
reducing every span to a bare string. Inspecting the font data shows:

| Font | Size | Bold | What it is |
|---|---|---|---|
| TimesNewRomanPSMT | 12.0 | no | body prose |
| DejaVuSansMono | 11.3 / 9.8 | no | inline code, SQL blocks |
| **DejaVuSansMono-Bold** | 11.3 | **yes** | table names |
| **TimesNewRomanPS-BoldMT** | 9.0 | **yes** | domain headings |
| **TimesNewRomanPSMT** | 18.0 | no | title and query headings |

Every heading is either **bold** or **larger than body text**. Every non-heading is
neither — code blocks are non-bold and *smaller*. That rule needs no vocabulary at
all, so it generalises.

## The new architecture

```
loaders/          format in  -> lines with style hints
chunking/         lines      -> Sections
llm/categorizer   Sections   -> categories + keywords
main.py           wiring
```

The rule is: **loaders extract, chunkers decide.** A loader never decides what a
heading is, so the same heading logic applies no matter which format the text
arrived in.

### `src/models.py` — `TextLine`

The new carrier between the two layers:

```python
@dataclass
class TextLine:
    text: str
    page_number: int
    font_size: float | None = None
    is_bold: bool = False
    heading_level: int | None = None
```

Each loader fills in what its format knows. A PDF knows font size and boldness.
Markdown knows heading level from `#`. A plain `.txt` knows neither, and that is a
supported case, not a failure.

`Section.domain` was renamed to `Section.parent_heading` — "domain" was a word borrowed
from the database document.

### `src/loaders/` — one class per format

`DocumentLoader` is an abstract base declaring `extensions` and `load()`.
`load_document(path)` picks a loader by file extension.

- `PDFDocumentLoader` — the span sorting from Round 1, now also recording font size
  and boldness per line.
- `TextDocumentLoader` — `.txt`, `.md`, `.markdown`. Sets `heading_level` from `#`.

Supporting a new source (DOCX, HTML, a URL) means writing one subclass and adding it
to `LOADERS`. Nothing downstream changes.

One detail in the PDF loader: a line's size comes from the span holding the most
characters, but a line counts as bold **only if every span is bold**. Without that,
the line `license_number (UNIQUE): Benefit: The ultimate legal anchor` would look like
a heading, because `Benefit:` is bold. Requiring the whole line to be bold excludes it.

### `src/chunking/` — two strategies

`HeadingChunker` follows the document's own structure:

1. Find the body font size — the size the most *characters* are set in, ignoring bold
   lines. Weighting by characters rather than by line count means a document with many
   short headings and few long paragraphs still identifies the paragraphs correctly.
2. A line is a heading if it has a Markdown `#`, **or** it is short (≤14 words), does
   not end in `.` `,` `;`, and is either bold or more than 1.15× the body size.
3. A heading with no text of its own before the next heading is a **container**. Its
   title becomes the `parent_heading` breadcrumb for the sections that follow, rather
   than an empty chunk.

Step 3 is the general form of Round 1's `"Frequent Queries:"` hardcode. `1. USER &
ACCESS DOMAIN` has only sub-headings under it, so it becomes a breadcrumb — derived
from the layout, not from a string literal.

`TokenWindowChunker` is the fallback for documents with no structure. It accumulates
lines up to a token budget and splits at line boundaries, never mid-sentence, because a
chunk cut through the middle of a sentence gets labelled badly. Consecutive windows
**overlap** by ~60 tokens so an idea sitting on a boundary still appears whole in at
least one chunk.

`chunk_document(pages)` tries headings first and falls back to windows if fewer than 3
sections come out. It returns the strategy name so the choice is printed rather than
invisible.

The two compose: a heading section over 400 tokens is passed through the window
chunker and emitted as `Title (part 1/3)`. Structure decides *where* to split; size
decides *whether to split further*.

### One bug this uncovered

The query heading

```
1. Available vehicles by category and branch (The "Whiteboard"
Version)
```

wraps across two lines in the PDF. Both are 18pt, so both looked like headings, and
`Version)` became a section title of its own.

Headings wrap in every PDF, so this needed a general fix. The signal is punctuation
left hanging open — an unclosed bracket or an odd number of quotes. `_is_unterminated`
tests for that and rejoins the two lines. It correctly does *not* merge
`Frequent Queries:` with the heading beneath it, because that line is balanced.

### `src/llm/categorizer.py` — three passes

**Pass 1, `profile_document` (new).** Sends the first few sections and asks what kind
of document this is, plus 4–6 example theme labels appropriate to it. This replaces the
hardcoded "database design document" with something read off the text. One cheap call.

On the lease it returns *"Residential lease agreement outlining rent, security deposit,
maintenance responsibilities, and termination provisions."* On the PDF, *"Database
design document for a car-rental platform."* The labelling prompt is built around
whichever it gets.

**Pass 2, `label_sections`.** As before, but the prompt now includes **every section
title in the document** as an outline, and requires that a category be a label at least
one other listed section could also carry. Without this, each batch of 6 is blind to
the rest of the document, so the model cannot tell what is cross-cutting and falls back
to restating each section's topic — which produces labels no two sections share.

**Pass 3, `consolidate_categories`.** Round 1 merged only synonyms. It now also merges a
narrow label into the broader theme it instantiates, aiming for roughly 0.6× the
incoming label count. Synonym merging alone left the lease with 15 unique labels and
**zero** groups.

### `main.py`

Takes a path argument (defaulting to the original PDF) and adds `--no-llm`, which stops
after chunking. Chunking is where the quality is won and it costs nothing to run, so
being able to iterate on it without paying for API calls is worth one flag.

---

## Verification

| Source | Strategy | Result |
|---|---|---|
| `Schema Architecture Notes.pdf` | headings | 22 sections, 2139 tokens, correct breadcrumbs |
| `lease.md` (legal, Markdown) | headings | 5 sections, legal vocabulary, 2 groups |
| `plain.txt` (prose, no headings) | token windows | falls back correctly; overlap verified |

The PDF still produces exactly the 16 tables and 6 queries it did in Round 1 — the same
result, now reached without a single document-specific rule. Its grouping improved from
7 groups to 11. Token count moved 2141 → 2139 because `Version)` is now part of the
heading instead of the body.

`grep` for `Frequent Queries`, `NOT_HEADINGS`, or `TABLE_HEADING` across `src/` returns
nothing.

## Cost

One profiling call, one call per 6 sections, one consolidation call. The 22-section PDF
is 6 calls over roughly 2,400 tokens — fractions of a cent.

---

## Honest limitations

- **Scanned PDFs return nothing.** There is no OCR; a scanned page has no text spans.
- **PDFs that style headings only by position** (indentation or whitespace, with no
  bold and no size change) fall back to token windows. The layout data to do better
  is available in the span bounding boxes; it is not used yet.
- **Grouping quality tracks document size.** The 5-section lease produced one group
  spanning all 5 sections, which is true but not informative. Label-based similarity
  needs enough sections for a theme to be genuinely shared.
- **Very long documents are untested.** The largest run so far is 7 pages. Batching is
  in place, but the outline added to the label prompt grows with the document and will
  eventually need truncating.
- **`semantic_chunker.py` and `prompts.py` are still empty**, as STEPS.md intended.

## Where this goes next

- **HuggingFace embeddings** — `src/llm/embedder.py` using `sentence-transformers`,
  embedding `Section.text` and comparing with cosine similarity. The label-based groups
  built here become the baseline to measure that against.
- **Retrieval** — `search(query)` matching a question's keywords against
  `Section.keywords`.
- **`ParentChunk` / `ChildChunk`** — currently a section over 400 tokens becomes
  `(part 1/3)` sections with no link between them. These two dataclasses are where that
  relationship belongs once retrieval needs it.
