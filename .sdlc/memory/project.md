# Project

Seeded by `sdlc install` from a scan. **Correct it** — an agent reads this before planning,
and a wrong entry here steers every ticket wrong.

## Stack
node · 4190 tracked files

## Top-level layout
- `CODEOWNERS/`
- `Dockerfile/`
- `bin/`
- `data/`
- `packages/`
- `scripts/`
- `upcoming-release-notes/`

## Commands
- typecheck: `npm run typecheck`
- lint: `npm run lint`
- unit: `npm run test`
- build: `npm run build`
- e2e: `npm run e2e`

## Non-obvious
_Empty. This is the most valuable section and a scan cannot write it._

Add what a newcomer gets wrong: which module owns what, the abstraction that looks
redundant but is not, the test that is slow for a reason, the service that must be running
locally. The Librarian appends here as the system learns, but it starts from what you write.
