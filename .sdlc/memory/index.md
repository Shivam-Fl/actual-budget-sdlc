# Memory index

One line per entry, describing **when it applies** — an agent reads this before deciding
whether to open the entry itself.

## Always
- [project.md](project.md) — stack, package layout, commands, and the two traps (AQL's compiler, the duplicated sqlite backends). Read before any planning.
- [conventions.md](conventions.md) — release notes, migrations, propagated fields, tests, PRs. Read before writing code or opening a PR.

## Situational
- [qa/environment.md](qa/environment.md) — the :3001 preview, and the two console errors already ticketed. Read before browser QA, and before reporting a console error.
- [qa/selectors.md](qa/selectors.md) — stable test ids for the transaction table, modals and column toggles. Read before writing any Playwright selector.
- [patterns/](patterns/) — bug shapes this repo has produced. Grep by symptom.
  - [AQL `$or` branches join with OR](patterns/aql-or-branches-join-with-or.md) — a compound AQL filter matches too many rows.
  - [Escaping hides test failures](patterns/sql-string-escaping-hides-test-failures.md) — a regression test passes on unfixed code.
- [decisions/](decisions/) — why things are as they are. Read before proposing a rewrite.