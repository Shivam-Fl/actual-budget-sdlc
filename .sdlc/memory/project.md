# Project

**Actual Budget** — local-first personal finance app. TypeScript/React, Yarn 4 monorepo, MIT,
~4.4k tracked files. Upstream is `github.com/actualbudget/actual`; this checkout is a fork that
carries the SDLC pipeline in `.sdlc/`.

## Stack
node >= 22.18 (`.nvmrc` pins v24.18.1) · yarn ^4.9.1, **always run yarn commands from the repo
root**, never from a workspace directory.

## Top-level layout
- `packages/` — `loot-core` (business logic, AQL query layer, migrations), `desktop-client`
  (React UI, aliased `@actual-app/web`), `desktop-electron`, `api`, `sync-server`, `crdt`,
  `component-library`, `docs`, `plugins-service`, `cli`, `mobile-client`, `ci-actions`
  (the release-notes gate), `vite-plugin-peggy`
- `upcoming-release-notes/` — one Markdown file per user-facing change; CI validates it
- `.sdlc/` — this pipeline: agents, QA harness, memory
- `CLAUDE.md` → `AGENTS.md` — the repo's own agent guide, extensive and accurate

## Commands
```bash
yarn typecheck    # tsgo -p tsconfig.root.json --noEmit && lage typecheck
yarn lint         # oxfmt --check . && oxlint --type-aware --quiet
yarn test         # lage test --continue  (caches in .lage/)
yarn test:debug   # no cache
yarn e2e          # Playwright, desktop-client
yarn vrt          # visual regression; yarn vrt:docker for a consistent env
yarn start        # Vite dev server on :3001
```

## Non-obvious
- **AQL is the query layer**, not SQL strings. `packages/loot-core/src/server/aql/compiler.ts`
  compiles a query builder to SQL, and its flattening rules have sharp edges — see
  [the `$or` pattern](patterns/aql-or-branches-join-with-or.md) before writing a compound filter.
- **`loot-core/src/platform/server/sqlite/` has two parallel implementations**, `index.ts` (sql.js,
  browser) and `index.electron.ts` (better-sqlite3). They define the same SQL functions
  independently and share no module state. A fix to one is not a fix to the other.
- **`lage` caches test results** in `.lage/`; clear it when results look impossible.
- **Native modules** (`better-sqlite3`, `bcrypt`) need build tools; they are pre-installed in the
  Cloud VM.
- The **release-notes gate is real CI** (`packages/ci-actions/bin/release-notes-check.mjs`) and will
  fail a PR over an author handle, a category, or a malformed front matter. See
  [conventions](conventions.md).