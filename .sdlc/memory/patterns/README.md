# Bug patterns

One file per recurring bug shape, named for the **symptom** — that is what a future agent
searches for, not the cause.

Each entry states: the symptom as observed, the actual cause, how it was found, and how to
check for it quickly. Written by the Librarian after a bug turns out to be non-obvious.

- `split-transaction-drops-its-stamps.md` — a row's identifying stamp survives on the
  split parent, which the default AQL row set cannot see.
- `sqlite-platform-tests-share-process-state.md` — order-dependent tests where a
  file-scoped `vi.restoreAllMocks()` outruns a `beforeAll`.
- `planner-read-comment-wording-as-the-defect.md` — a follow-up ticket that re-reviews
  code that already landed, because the review finding was about a comment.
