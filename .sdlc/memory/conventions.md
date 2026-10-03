# Conventions

What a newcomer's first pull request gets wrong. Read before writing code.

## Release notes

- One file per user-facing change in `upcoming-release-notes/`, named with a **short descriptive
  kebab-case slug** (`fix-weekly-report-final-bucket.md`), not a PR number. Front matter is
  `category:` (exactly one of `Features`, `Enhancements`, `Bugfixes`, `Maintenance`) and
  `authors:` (a YAML list of **GitHub usernames**).
- **`authors` must be a person.** The CI gate rejects `claude`, `github-actions`, anything ending in
  `[bot]`, and any non-string value. Two notes have already shipped crediting `claude` and had to be
  fixed in follow-up PRs; use the PR author's real handle.
- Body is one plain sentence addressed to a user, present-tense verb, no file names or function
  names. `Maintenance` notes may be technical.

## Migrations

- `packages/loot-core/migrations/*.sql` — the filename prefix is a millisecond timestamp, the body is
  wrapped in `BEGIN TRANSACTION;` / `COMMIT;`, and **the file ends with a trailing newline**. Every
  pre-existing migration does; one that does not is drift, not a style choice. Check with
  `tail -c1 <file> | xxd -p` → `0a`.
- A new column also needs a field in `packages/loot-core/src/server/aql/schema/index.ts` or AQL will
  not see it.

## Adding a field that other code propagates

When a new column is copied onto a derived row — a merge survivor, a transfer mirror leg — grep for
the **existing** sibling column (`schedule`) and check every site that writes it. A field added in
one place and propagated in another produces a row that is linked but missing its identity. The
review on #23 found exactly this: `mergeTransactions` copied `schedule` and not `schedule_occurrence`,
and `addTransfer`/`updateTransfer` did the same. Read paths are not the only places that matter.

## Tests

- Vitest, run from the repo root with `yarn workspace <pkg> run test` (or `yarn test` via lage).
  Playwright e2e under `packages/desktop-client/e2e/`, page models in `e2e/page-models/` — extend a
  page model rather than writing fresh locators.
- Desktop-client unit tests that touch server behaviour mock the connection with
  `vi.mock('@actual-app/core/platform/client/connection', () => import('#mocks/connection'))`. See
  `custom-spreadsheet.test.ts` for the shape.
- A negative test is only worth writing if it **fails when the guard is removed**. Assert exact
  counts, not upper bounds. See
  [the escaping pattern](patterns/sql-string-escaping-hides-test-failures.md).

## Pull requests

Titles are prefixed `[AI]` and the template is left blank — both are covered in
`.github/agents/pr-and-commit-rules.md`, follow it exactly. Agents authoring anything on GitHub
prefix it with 🤖.