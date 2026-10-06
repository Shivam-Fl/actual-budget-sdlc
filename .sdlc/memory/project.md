# Project

Seeded by `sdlc install` from a scan. **Correct it** — an agent reads this before planning,
and a wrong entry here steers every ticket wrong.

## Stack
node · Yarn 4 workspaces (`packageManager: yarn@4.17.1`) · TypeScript · React

**Use `yarn`, not `npm`.** Every script below is invoked through Yarn 4; `npm run` in a
child workspace is the wrong tool here. Yarn commands run from the repo root.

## Top-level layout
- `packages/` — the workspaces (`loot-core`, `desktop-client`, `api`, `sync-server`,
  `component-library`, `ci-actions`, `docs`, …)
- `bin/`, `scripts/`, `upcoming-release-notes/`, `lage.config.js`

## Commands
- typecheck: `yarn typecheck` (`tsgo -p tsconfig.root.json --noEmit && lage typecheck`)
- lint: `yarn lint` (oxfmt + oxlint)
- unit: `yarn test` (lage, cached in `.lage/`)
- build: `lage build` via the root `build` script
- e2e: `yarn e2e`

## Non-obvious
- **`yarn test` caches per workspace by the files inside that package.**
  `upcoming-release-notes/` is at the repo root and belongs to no package, so a
  note-only change cannot move any cache key. The release-note gate therefore runs as
  its own **uncached** lage task (`release-notes`, `dependsOn: ['release-notes']` in
  `lage.config.js`). If you ever see `» skip @actual-app/ci-actions test` on a run
  that only added a note, the gate did not run — that is the bug the uncached task
  exists to prevent, so report it rather than assuming the note passed.
- `yarn test:debug` runs lage with `--no-cache`. Clear `.lage/` if behaviour is odd.
- `verify.e2e` is empty in `.sdlc/config.yml`, so this pipeline's CI never runs e2e —
  browser verification happens in the QA stage. See `qa/environment.md`.
- Two places a "which module owns this" trap lives: loot-core resolves node vs browser
  by conditional exports (`.api` / `.electron` suffixes), and it splits its vitest suite
  across two configs whose `include` lists differ.
