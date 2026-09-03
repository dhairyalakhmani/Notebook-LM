// Every tunable in one place. Values that change what gets stored are marked
// BAKED IN: changing them means re-ingesting every document.

// ---------------------------------------------------------------- models
export const GROQ_MODEL = "openai/gpt-oss-120b";
/** The reranker stays local: it runs on ~30 candidates at query time only. */
export const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

// ------------------------------------------------------------ embeddings
/**
 * Which embedder produces vectors. BAKED IN - not just the model, the provider:
 * the same weights served two ways can differ in pooling, normalisation and
 * revision, and the resulting vectors are not comparable.
 *
 *   "hf-api" - hosted HuggingFace Inference. Needs HF_TOKEN and a network.
 *   "local"  - in-process ONNX. Offline, and what the tests use.
 */
export const EMBEDDING_PROVIDER: "hf-api" | "local" = "hf-api";

/** The ONNX conversion published for transformers.js. Local path only. */
export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5"; // BAKED IN
/**
 * The original repo, which is what the API serves. `Xenova/*` repos hold ONNX
 * files for transformers.js and are not served by the Inference API, so the two
 * paths need different ids for the same weights.
 */
export const HF_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"; // BAKED IN

/**
 * Endpoint template. `{model}` is substituted. Kept in config because
 * HuggingFace has moved its inference routing more than once - if the shape
 * changes again this is the only line to edit.
 */
export const HF_API_URL =
  "https://router.huggingface.co/hf-inference/models/{model}/pipeline/feature-extraction";

/** Expected vector length. Checked against what the API returns, so a wrong
 *  model id fails immediately instead of filling the store with bad vectors. */
export const EMBEDDING_DIMENSIONS = 384;

// -- hosted request shaping. Round trips dominate, so batches want to be large;
// -- these caps exist because the endpoint rejects oversized payloads.
export const HF_BATCH_SIZE = 64;
/** Also cap by bytes: a batch of long chunks hits the size limit before 64. */
export const HF_BATCH_BYTES = 60_000;
/** Requests in flight. Enough for throughput, low enough to avoid 429s. */
export const HF_CONCURRENCY = 3;
export const HF_TIMEOUT_MS = 30_000;
export const HF_MAX_ATTEMPTS = 5;
export const HF_BACKOFF_MS = 1_000;

/**
 * Local batching. Measured: batch 64 natural order = 61.6ms/chunk, batch 1 =
 * 24.8ms, batch 16 length-sorted = 20.9ms. Padding waste, not round trips, is
 * the cost in-process - which is why this number is so much smaller than the
 * hosted one.
 */
export const LOCAL_EMBED_BATCH = 16;

/** Cache embeddings by content hash, so a failed or repeated ingest does not
 *  pay for the same text twice. Matters far more for a metered API. */
export const CACHE_EMBEDDINGS = true;

/**
 * How many model tokens one tiktoken token may turn into.
 *
 * Chunk budgets are counted in cl100k (tiktoken), because parents are read by
 * the LLM. The embedding model counts in BERT WordPiece, which is a different
 * vocabulary and produces *more* tokens for the same text - measured at up to
 * 1.20x on this project's documents, and considerably worse for CJK, code and
 * long identifiers.
 *
 * That matters because a model silently truncates anything past its input limit
 * (verified: a 1202-token input returns a vector identical to its first 512
 * tokens, with no error). This ratio converts a tiktoken budget into a
 * worst-case model-token estimate so the overflow can be caught instead.
 */
export const MODEL_TOKEN_RATIO = 1.35;

// ------------------------------------------------ layer 0: extraction
/**
 * How far apart two runs may sit vertically and still be one line, as a
 * fraction of font size. A fixed value cannot serve 9pt body text and an 18pt
 * heading at once.
 */
export const LINE_BAND_RATIO = 0.3;
/** Floor for the above, in points, so tiny text still bands. */
export const LINE_BAND_MIN = 1.5;
/**
 * Horizontal gap between two runs, as a fraction of font size, that means "a
 * space was here". Many PDFs position text by coordinate and emit no space run
 * at all; without this the words either side are concatenated.
 */
export const WORD_GAP_RATIO = 0.22;
/** A gap this large is a table cell boundary, not a word space. */
export const CELL_GAP_RATIO = 1.2;
/** What a cell boundary becomes in the text, so the table detector can see it. */
export const CELL_SEPARATOR = "   ";
/** A gutter must be at least this fraction of page width to split columns. */
export const MIN_GUTTER_RATIO = 0.035;
/**
 * ...and at most this fraction. A real column gutter is narrow - a few percent
 * of the page. A wide band of whitespace is something else, most often the gap
 * between table cells, and splitting there would tear every row in half.
 */
export const MAX_GUTTER_RATIO = 0.15;
/**
 * A column must hold at least this fraction of its fair share of the page's runs
 * (fair share being 1/N for N columns). Rejects a margin note or stray footnote
 * posing as a column, and scales to any column count.
 */
export const MIN_COLUMN_SHARE = 0.4;

/** A page with fewer characters than this has effectively no text layer. */
export const MIN_CHARS_PER_PAGE = 60;
/** This share of text-poor pages means the document needs re-extraction. */
export const OCR_PAGE_RATIO = 0.4;
/** Share of U+FFFD above which the text is mojibake, not language. */
export const MAX_REPLACEMENT_RATIO = 0.02;
/** Share of one-character words above which a font encoding is broken. */
export const MAX_SHORT_WORD_RATIO = 0.5;

// ------------------------------------------------- layer 1: structure
/** A line this much larger than body text is probably a heading. */
export const HEADING_SIZE_RATIO = 1.15;
/** Longer than this many words and it is a sentence, not a heading. */
export const MAX_HEADING_WORDS = 14;
/**
 * How much agreement between signals (bold, size, numbering, caps, outdent) is
 * needed to call a line a heading. A larger font alone scores 2 and passes;
 * bold alone scores 1 and does not, because bold sentences are common.
 */
export const HEADING_MIN_CONFIDENCE = 2;
/** A vertical gap this much bigger than the normal line gap starts a paragraph. */
export const PARAGRAPH_GAP_RATIO = 1.4;
/** Consecutive list items merge into one block up to this size. */
export const MAX_MERGED_BLOCK_TOKENS = 400;

// ---------------------------------------------- layer 2: segmentation
/**
 * Below this share of heading blocks, a document is treated as unstructured and
 * goes to semantic segmentation instead of heading-based grouping.
 */
export const MIN_STRUCTURE_SCORE = 0.05;
/** Ask the LLM for boundaries only when a run is at least this many blocks. */
export const LLM_SEGMENT_MIN_BLOCKS = 4;
/** Blocks sent to the segmenter in one call. */
export const LLM_SEGMENT_WINDOW = 40;
/** Off by default: ingest stays fully offline until this is switched on. */
export const USE_LLM_SEGMENTATION = false;

// ------------------------------------------------------ layer 3: size
export const CHILD_MAX_TOKENS = 350; // BAKED IN
export const PARENT_MAX_TOKENS = 1200; // BAKED IN
export const CHILD_OVERLAP_TOKENS = 60; // BAKED IN
/** A unit smaller than this is folded into its neighbour rather than stored alone. */
export const MIN_UNIT_TOKENS = 25; // BAKED IN
/** Heading path prepended to each child so a chunk read alone says what it is. */
export const PREPEND_HEADING_PATH = true; // BAKED IN
/**
 * Build parents from sibling sections that share a heading ancestor, rather than
 * one parent per section. On a document of many short sections this is what
 * makes parent expansion worth doing: retrieving one table returns the whole
 * domain it belongs to. Grouping never crosses PARENT_MAX_TOKENS and never
 * merges sections the document did not already nest together.
 */
export const GROUP_PARENTS_BY_ANCESTOR = true; // BAKED IN

// -------------------------------------------------------- retrieval
export const CANDIDATES_K = 30;
export const RERANK_KEEP = 8;
export const CONTEXT_K = 5;
export const USE_RERANKER = false;

export const STORAGE_DIR = "storage";
