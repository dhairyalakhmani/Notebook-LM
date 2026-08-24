# archive/

Code from the first attempt, kept only as reference. Nothing here is imported.

- `groq_categorizer_v1.py` — the 3-pass Groq labelling pipeline (profile -> label ->
  consolidate). It was removed from `src/` because labels are the wrong backbone for
  retrieval (see STEPS.md, "What we removed and why"). The *prompts* in it are still
  good and get reused in Phase 9 when topics come back as a display-only feature.

Delete this folder once Phase 9 is done.
