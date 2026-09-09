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

There are no user accounts, so access is a shared-secret gate rather than an
identity model. `NOTEBOOK_AUTH` holds `name:password` pairs, comma-separated,
and the server **refuses to start** if you bind anything but loopback without
it — you cannot expose this unauthenticated by accident.

```bash
NOTEBOOK_AUTH="you:a-long-password,friend:another"   node src/api/server.ts --static web/dist --host 0.0.0.0
```

The gate covers the app shell as well as the API, so an unauthorised visitor
never loads the page. `GET /api/health` is exempt, for platform health checks;
it reveals the model name and embedding dimensions and nothing about any
document.

**On Railway** (a container, a volume, and a free HTTPS hostname):

1. New project → deploy from the GitHub repo; the `Dockerfile` is picked up.
2. Add a **volume mounted at `/data`**. Without it every notebook disappears
   on the next deploy.
3. Set `GROQ_API_KEY`, `HF_TOKEN` and `NOTEBOOK_AUTH`. Paste the values
   **without quotes**: `.env` may wrap a token in `"..."` because dotenv strips
   those when reading a file, but a platform variable is taken literally, and a
   quoted token fails as `HuggingFace API 401` at the embed stage.
4. **Keep replicas at 1.** SQLite is one local file with a single writer; two
   replicas would get two volumes and silently diverge.

`PORT` is injected by the platform and read by the container's command, which
binds `0.0.0.0` and sets `NOTEBOOK_STORAGE_DIR=/data`. The image prunes
`@huggingface/transformers` and its two onnxruntime builds — about 600 MB,
needed only for local embedding or the reranker, both lazily imported. It keeps
pdfjs-dist's optional `@napi-rs/canvas`, without which PDF text extraction
crashes on import.

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

Two things to understand before you add people:

- **One shared workspace.** Everybody who can log in sees every notebook and
  can delete anyone's sources. There is no ownership anywhere in the schema.
- **One shared quota.** 8000 tokens/minute is per API key, so it is roughly one
  question a minute *for the whole deployment*, not per person. Raise the Groq
  tier before inviting anyone. Uploads, by contrast, queue properly and report
  their position.

Running it locally needs none of this: the default bind is loopback, and with
`NOTEBOOK_AUTH` unset there is no gate.

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
