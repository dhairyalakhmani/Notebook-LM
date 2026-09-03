// Phase 7, deferred on purpose: a cross-encoder precision pass over the ~30
// candidates. The `Reranker` interface it will implement, and the slot it plugs
// into, are already in retriever.ts - it is a 90MB download and real query-time
// latency, so it waits until Phase 10's numbers show hybrid search alone is not
// good enough.
