import { join, resolve } from "node:path";

// ---------------------------------------------------------------- models
export const GROQ_MODEL = "openai/gpt-oss-120b";
export const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

// ------------------------------------------------------------ embeddings
export const EMBEDDING_PROVIDER: "hf-api" | "local" = "hf-api";

export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5"; // BAKED IN
export const HF_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"; // BAKED IN

export const HF_API_URL =
  "https://router.huggingface.co/hf-inference/models/{model}/pipeline/feature-extraction";

export const EMBEDDING_DIMENSIONS = 384;

export const HF_BATCH_SIZE = 64;
export const HF_BATCH_BYTES = 60_000;
export const HF_CONCURRENCY = 3;
export const HF_TIMEOUT_MS = 30_000;
export const HF_MAX_ATTEMPTS = 5;
export const HF_BACKOFF_MS = 1_000;

export const LOCAL_EMBED_BATCH = 16;

export const CACHE_EMBEDDINGS = true;

export const MODEL_TOKEN_RATIO = 1.35;

// ------------------------------------------------ layer 0: extraction
export const LINE_BAND_RATIO = 0.3;
export const LINE_BAND_MIN = 1.5;
export const WORD_GAP_RATIO = 0.22;
export const CELL_GAP_RATIO = 1.2;
export const CELL_SEPARATOR = "   ";
export const MIN_GUTTER_RATIO = 0.035;
export const MAX_GUTTER_RATIO = 0.15;
export const MIN_COLUMN_SHARE = 0.4;

export const MIN_CHARS_PER_PAGE = 60;
export const OCR_PAGE_RATIO = 0.4;
export const MAX_REPLACEMENT_RATIO = 0.02;
export const MAX_SHORT_WORD_RATIO = 0.5;

// ------------------------------------------------- layer 1: structure
export const HEADING_SIZE_RATIO = 1.15;
export const MAX_HEADING_WORDS = 14;
export const HEADING_MIN_CONFIDENCE = 2;
export const PARAGRAPH_GAP_RATIO = 1.4;
export const MAX_MERGED_BLOCK_TOKENS = 400;

// ---------------------------------------------- layer 2: segmentation
export const MIN_STRUCTURE_SCORE = 0.05;
export const LLM_SEGMENT_MIN_BLOCKS = 4;
export const LLM_SEGMENT_WINDOW = 40;
export const USE_LLM_SEGMENTATION = false;

// ------------------------------------------------------ layer 3: size
export const CHILD_MAX_TOKENS = 350; // BAKED IN
export const PARENT_MAX_TOKENS = 1200; // BAKED IN
export const CHILD_OVERLAP_TOKENS = 60; // BAKED IN
export const MIN_UNIT_TOKENS = 25; // BAKED IN
export const PREPEND_HEADING_PATH = true; // BAKED IN
export const GROUP_PARENTS_BY_ANCESTOR = true; // BAKED IN

// -------------------------------------------------------- retrieval
export const CANDIDATES_K = 30;
export const RERANK_KEEP = 8;
export const CONTEXT_K = 5;
export const USE_RERANKER = false;

export const MIN_RELEVANCE_COSINE = 0;

export const STORAGE_DIR =
  process.env["NOTEBOOK_STORAGE_DIR"] ?? resolve(import.meta.dirname, "..", "storage");

// Deliberately not per-user: cache entries are keyed by a hash of the text, so
// they carry no notion of who ingested what, and sharing them means the second
// person to add a document pays 9ms instead of 50 seconds. The forked ingest
// worker runs with NOTEBOOK_STORAGE_DIR pointed at one user's directory, so
// without this the cache would silently become per-user too.
export const CACHE_DIR = process.env["NOTEBOOK_CACHE_DIR"] ?? STORAGE_DIR;

export const SOURCES_DIR = join(STORAGE_DIR, "sources");

export const TMP_DIR = join(STORAGE_DIR, "tmp");

// ---------------------------------------------------------------- api server
export const API_HOST = "127.0.0.1";

// PORT is what every platform-as-a-service injects; NOTEBOOK_API_PORT is the
// local override. Read here rather than interpolated into a start command, so
// the command itself needs no shell and works the same on Windows.
export const API_PORT = Number(process.env["NOTEBOOK_API_PORT"] ?? process.env["PORT"] ?? 8787);

// Set NOTEBOOK_SIGNUP_CODE to require it when registering. Without it anyone
// who has the URL can create an account and spend this deployment's LLM quota.
export const SIGNUP_CODE = process.env["NOTEBOOK_SIGNUP_CODE"] ?? null;

// Session cookies are marked Secure only where the connection is https, so
// that signing in over http://localhost still works.
export const REQUIRE_SECURE_COOKIE = process.env["NOTEBOOK_SECURE_COOKIE"] === "1";

export const INGEST_MAX_CONCURRENT = 1;

export const JOB_RETENTION_MS = 10 * 60 * 1000;
