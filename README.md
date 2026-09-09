# NoteBook

Ask questions of your own documents and get answers quoted from them, with the
page they came from — or a refusal, when the sources genuinely do not cover it.

Every answer is your documents' own words, and every citation is clickable:
click one and you land on the page it was taken from, highlighted.

The refusal is the point. A RAG system that invents a plausible answer is worse
than one that says "not in your sources", so the whole pipeline is built so that
the second is the easy outcome and the first is hard.

## Running it

Node 24+ (it runs `.ts` files directly and ships SQLite as `node:sqlite`).

```bash
npm install
cp .env.example .env      # then add GROQ_API_KEY and HF_TOKEN
```

Two processes in development:

```bash
npm run api               # the API on 127.0.0.1:8787
npm run dev               # the browser bundle on localhost:5173
```

Then open **http://localhost:5173** — `localhost`, not `127.0.0.1`, because Vite
binds IPv6 by default.

One process for the built app:

```bash
npm run build && npm run ui   # http://127.0.0.1:8787 serves both
```

### Deploying it

The app has real accounts: people register, sign in, and each gets their own
workspace. Nothing about that needs configuring — but two variables are worth
setting on a deployment.

| variable | why |
|---|---|
| `GROQ_API_KEY` | answers and follow-up rewriting |
| `HF_TOKEN` | embeddings |
| `NOTEBOOK_SIGNUP_CODE` | **recommended.** Without it, anyone who finds the URL can register and spend your Groq quota. With it, only people you give the code to can create an account. |
| `NOTEBOOK_SECURE_COOKIE=1` | **set this behind HTTPS.** It adds `Secure` to the session cookie, so it can never be sent over a plaintext connection. Left off by default so signing in on `http://localhost` works. |

Paste the values **without quotes**. A `.env` file may wrap a token in `"..."`
because dotenv strips those when reading a file, but a platform variable is
taken literally — a quoted token fails as `HuggingFace API 401` at the embed
stage.

The gate itself: `/api/*` requires a session cookie, except `/api/health` and
the four `/api/auth/*` routes. The app shell and its bundle are served to
anyone, because the browser needs them in order to draw the sign-in screen —
no data is in them.

**On Railway** (a container, a volume, and a free HTTPS hostname):

1. New project → deploy from the GitHub repo; the `Dockerfile` is picked up.
2. Add a **volume mounted at `/data`**. Without it every account and notebook
   disappears on the next deploy.
3. Set the variables above.
4. **Keep replicas at 1.** SQLite is one local file with a single writer; two
   replicas would get two volumes and silently diverge.

`PORT` is injected by the platform and read by the container's command, which
binds `0.0.0.0` and sets `NOTEBOOK_STORAGE_DIR=/data`. The image prunes
`@huggingface/transformers` and its two onnxruntime builds — about 600 MB,
needed only for local embedding or the reranker, both lazily imported. It keeps
pdfjs-dist's optional `@napi-rs/canvas`, without which PDF text extraction
crashes on import.

The deployment starts with no accounts and an empty volume. Your local
notebooks stay local: sources are uploaded per account, so you add them again
through the UI on the deployed copy.

**Deleting really frees the volume.** Removing a source deletes its chunks, its
vectors and — when no other notebook still references those bytes — the stored
original. Then both databases are compacted, because SQLite marks freed pages
for reuse rather than returning them: without that step a deleted notebook
occupies its space for ever. The WAL companions are folded in and truncated at
the same time, which is a larger saving than it sounds; the server logs what it
handed back.

The one thing that only grows is `embeddings.db`, the content-hash embedding
cache. It is never pruned, deliberately — it is what makes re-ingesting a
document free. It is also pure cache: delete the file and it rebuilds, at the
cost of re-embedding.

**Each account gets its own workspace.** Registering creates a directory under
`storage/users/<name>/`, holding its own `notebook.db`, `vectors.db` and
`sources/`. Two people can own a notebook of the same name without colliding,
and neither can see or delete the other's. Accounts themselves live in
`accounts.db` at the storage root: scrypt password hashes, and sessions stored
as a hash of the token so the database holds nothing usable.

Isolation is by **directory, not by an owner column**, which is both simpler and
stronger: there is no query that could forget a `WHERE` clause and return
someone else's notebooks, because the rows are not in the same file. It needed
no schema change — the stores already took a storage directory. Asking for
another person's notebook returns `404`, because it genuinely is not there.

The one thing deliberately shared is `embeddings.db`, the content-hash embedding
cache. Entries are keyed by a hash of the text and carry no notion of who
ingested what, so sharing it means the second person to add a document waits
9 ms instead of 50 seconds.

**What isolation does not fix: the quota.** 8000 tokens/minute is per API key,
and everyone shares yours, so it is roughly one question a minute *for the whole
deployment*, not per person. Raise the Groq tier before inviting anyone. Uploads
are fine — they queue properly and report each waiter's position.

If you used this before accounts existed, your notebooks are at the storage
root where no account can see them. One command moves them, with the server
stopped:

```bash
npm run notebook -- adopt <your-account-name>
```

The CLI works on the same data:

```bash
npm run notebook -- add networking data/some-book.pdf
npm run notebook -- ask networking "why does TCP need congestion control?"
npm run notebook -- relink data      # re-link sources whose file is missing
npm run notebook -- list
```

### Trying a destructive route by hand

`DELETE` on a notebook or a source really deletes — and because sources are
content-addressed, releasing the last reference removes the file that every
notebook holding those bytes was using. Do not point those at `storage/`:

```bash
npm run api:sandbox                  # the API on 8788, against storage-sandbox/
npm run notebook:sandbox -- add demo data/dbms-notes.md
```

Both print which storage they are about to write to before they start. The
sandbox server runs on a different port so it can sit beside `npm run api`
rather than replacing it — being unsure which server answered is half of how
this went wrong the first time. It cost the `dbms` notebook its only source
(row, chunks and file); the tests were all correctly isolated, but the
hand-check had no isolated path to take.

## How it is put together

```
src/                the pipeline, and the API over it
  loaders/          PDF, DOCX, HTML, text -> pages
  cleaning/         page furniture, hyphenation, control characters
  structure/        lines -> blocks -> heading hierarchy
  chunking/         blocks -> parent/child chunks
  embedding/        HF API or local, with a content-hash cache
  search/           BM25 + brute-force cosine, fused
  retrieval/        child match -> parent passage
  generation/       the grounded prompt, the answer, the quote picker
  notebook/         ingest, chat, SQLite store
  api/              dto.ts (the contract), router, handlers, ingest worker
web/src/
  app/              routes, layouts, query client, keymap
  features/         notebooks, sources, chat, viewer
  shared/           http, ui primitives, tokens, every user-facing string
storage/            three SQLite files + the ingested originals (gitignored)
```

Two ideas carry most of the weight.

**One wire contract.** `src/api/dto.ts` defines every shape that crosses between
the server and the browser, and contains **no `import` statements at all** —
which is what lets one file be compiled by both tsconfigs. The server annotates
every handler with its DTO and the browser re-exports the same module, so a
change on one side that the other has not followed is a compile error. A test
enforces the no-imports rule, because a comment asking people not to add one has
a poor record.

**Nothing is simulated.** The previous version of this UI had a typewriter
effect over an already-complete string, a quota countdown ticking at 700ms per
displayed "second", and an ingest progress bar hardcoded to 0.63 with `18.4s`
written into the JSX. All of it is gone. Timings, quota, and ingest progress now
come from the server or are not shown.

## What the numbers actually are

Measured on the 775-page Kurose book (19.7 MB), on this machine:

| | |
|---|---|
| ingest | extract 15.7s, chunk 5.5s, embed 50s cold / 0.3s cached |
| the book becomes | 5767 blocks → 1528 units → 499 sections, 2474 passages |
| a question | ~4s total: rewrite ~0.5s, retrieve ~0.8s, answer ~1.3s |
| Groq free tier | 8000 tokens/minute against a ~6600-token prompt |

That last row is the binding constraint: **roughly one question a minute**, and
prefill dominates, not output. It is why answers are returned whole rather than
token-streamed — streaming would save about a second on a workload where the next
question is sixty seconds away, at the cost of a second LLM code path and marker
normalisation breaking across delta boundaries, which silently loses citations.

`GET /api/notebooks/:name/passages?q=…` runs retrieval with **no LLM call at
all**, which is how you debug ranking without spending quota.

## Checks

```bash
npm run check     # format, lint, both typechecks, both test suites, dep guard
npm test          # 283 backend + 80 browser tests
```

`npm run check` takes several minutes, almost all of it type-aware ESLint.

Three of the lint rules exist for specific bugs this codebase shipped, and are
worth leaving on: `no-floating-promises` (the old client had six
`void fetch().then()` calls with no rejection handler), a `no-restricted-syntax`
ban on `setInterval` outside `shared/lib` (that is where the fake progress
lived), and a ban on building a DOM selector from a CSS-module class name (which
became the literal `".undefined"` when the lookup missed, silently killing the
PDF highlight).

`test/ingest.test.ts` runs real ingests through a forked worker, so it needs
`HF_TOKEN` and a network. It skips itself cleanly without one rather than
failing.

TypeScript is pinned to 5.9 on purpose: TypeScript 7's npm package is a wrapper
around the native Go binary and exports only `version`, so `typescript-eslint`
cannot parse anything with it installed.

## Smoke test by hand

Automated tests cover the pieces; this is the five-minute pass that covers the
product. Start `npm run api` and `npm run dev`.

1. **Sources.** The rail lists your documents with real page counts and sizes.
   Open one: the section list comes from the document's own headings, and the
   ingest numbers are from the run that actually happened.
2. **Ask something in the corpus.** Pick a question from `Questions.md`, e.g.
   *"How do OSPF and BGP differ?"* You should get prose with `[n]` markers, a
   cited-sources list underneath, and the timings in the composer footer.
3. **Click a citation.** The right document opens at the right page with the
   cited sentence highlighted. Copy the URL, open it in a new tab — same view.
4. **Ask something out of the corpus.** *"How does HTTP/3 work internally?"* —
   the answer should be a refusal that reads as a success, with the model's own
   words quoted. This is the behaviour the project exists for.
5. **Ask a follow-up.** Type *"why?"*. The thread should show what retrieval
   actually searched for next to what you typed.
6. **Untick a source.** The composer refuses to send with nothing selected, and
   the viewer keeps showing whatever it was showing — scope decides what is
   *searched*, never what is *displayed*.
7. **Add a source.** Drop a PDF on the rail. You should see real stages, and the
   summary at the end should match the document. Drop the same file again: it
   comes back as already-added, instantly.
8. **Delete a source** while its page is open. It says the source was removed
   rather than silently swapping to a different document. Do this against
   `npm run api:sandbox`, not your own notebooks — see above.
9. **Trip the quota.** Ask several questions in a minute. You should get a
   countdown that matches the server's `Retry-After`, and the question you typed
   should still be there.
10. **Keyboard.** `Ctrl/Cmd+K` to jump between notebooks, `/` to focus the
    composer, `[` and `]` to toggle the panes, `←`/`→` to page.
11. **Theme.** The toggle cycles system → light → dark. Contrast in both is
    enforced by `web/src/test/contrast.test.ts`, which parses the token file.

## Known limits

- **One user, one machine.** No authentication, shared storage, one ingest at a
  time — see [Deploying it](#deploying-it) for what exposing this would need.
- **SQLite calls are synchronous.** Fine at this scale (sub-millisecond reads,
  ~1 question/minute); the one span long enough to matter — ~6s of synchronous
  chunking — runs in a forked process for exactly that reason.
- **The relevance floor is off** (`MIN_RELEVANCE_COSINE = 0`). Measured,
  answerable and unanswerable questions produced overlapping cosine ranges
  (0.568–0.804 against 0.607–0.700), so a similarity threshold cannot gate a
  refusal. Similarity measures whether a passage is *about* the subject, never
  whether it *contains* the answer. Refusal is the prompt's job.
- **The reranker is off** (`USE_RERANKER = false`): recall@1 dropped from 58% to
  42% with it on.
- **A stored turn cannot tell you why it refused.** `Answer.origin` is not
  persisted, so for a turn read back from history the difference between "the
  model declined" and "retrieval found nothing" is not recoverable. Live answers
  are classified exactly.
- **Heading paths in the real book reach 18 levels deep**, because the book's own
  table-of-contents pages were ingested as headings. The outline reports what the
  pipeline produced; the UI clamps the indentation.
