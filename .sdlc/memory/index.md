# Memory index

One line per entry, describing **when it applies** — an agent reads this before deciding
whether to open the entry itself.

## Always
- [project.md](project.md) — stack, layout, commands. Read before any planning.
- [conventions.md](conventions.md) — release-note gate rules, PR titles, test falsifiability. Read before writing code or opening a PR.

## Situational
- [qa/environment.md](qa/environment.md) — Playwright's UA freezes the app's clock and the demo budget, so QA's real browser disagrees with the e2e suite; `yarn typecheck` skips e2e; console/pageerror settle rules; loot-core's two vitest configs. Read before browser QA, and before asserting any date or amount.
- [qa/selectors.md](qa/selectors.md) — schedules/command-bar selectors and the page models that already encode the waits. Read before writing any e2e selector.
- [patterns/](patterns/) — bug shapes this repo has produced before. Grep by symptom.
  - [split-transaction-drops-its-stamps.md](patterns/split-transaction-drops-its-stamps.md) — a schedule occurrence payable twice after its transaction was split. Read before writing any query that filters transactions by `schedule` or `schedule_occurrence`.
  - [sqlite-platform-tests-share-process-state.md](patterns/sqlite-platform-tests-share-process-state.md) — order-dependent tests in `platform/server/sqlite/`; `-t` makes them vacuous. Read before editing those two files.
  - [planner-read-comment-wording-as-the-defect.md](patterns/planner-read-comment-wording-as-the-defect.md) — why nine PRs re-litigated comments. Read when triaging a follow-up ticket or writing a work order.
- [decisions/](decisions/) — why things are as they are. Read before proposing a rewrite.