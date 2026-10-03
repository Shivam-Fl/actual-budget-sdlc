# Bug patterns

One file per recurring bug shape, named for the **symptom** — that is what a future agent
searches for, not the cause.

Each entry states: the symptom as observed, the actual cause, how it was found, and how to
check for it quickly. Written by the Librarian after a bug turns out to be non-obvious.

- `aql-or-branches-join-with-or.md` — an AQL filter matches far more rows than intended.
- `sql-string-escaping-hides-test-failures.md` — a negative test stays green after the guard it
  protects is deleted.

Each of these cost a merged PR and a follow-up review pass to find. They are not derivable from
reading the code, which is why they are here.