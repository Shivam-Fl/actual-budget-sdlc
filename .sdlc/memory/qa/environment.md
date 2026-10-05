# QA environment notes

Environment quirks that cost a QA run each time they are rediscovered.

## `yarn typecheck` does not cover `packages/desktop-client/e2e/`

`packages/desktop-client/tsconfig.json` sets `"exclude": [..., "e2e"]`, and the
project `packages/desktop-client/e2e/tsconfig.json` that would cover it is referenced
by nothing — no `references` entry in the parent tsconfig, no script, no lage task.
`yarn typecheck` runs `tsgo -b && tsc-strict` per workspace, so e2e TypeScript is
simply never compiled.

A green root typecheck is therefore **not** evidence an e2e change compiles. Type an
e2e file by running the project's own config directly:

```bash
yarn workspace @actual-app/web exec tsc -p e2e/tsconfig.json --noEmit 2>&1 | grep '^e2e/'
```

**Filter to `^e2e/`.** As of 2026-10-04 this reports 10 errors, all pre-existing and all
in `packages/loot-core/src/shared/` (`util.ts`, `months.ts`) — files the repo's
`typescript-strict-plugin` setup grandfathers but plain `tsc` does not. They exit
non-zero and are not yours. Only `e2e/`-prefixed lines indicate a real problem in the
e2e tree.

This is why e2e type errors reach review as findings rather than as CI failures.

## Reading a `console` / `pageerror` buffer needs an unconditional settle wait

Both channels deliver over CDP out of band — nothing in the page's own promise chain
waits for them. `packages/desktop-client/e2e/reports.test.ts` collects `pageerror`
into an array and reads it only after `await page.waitForTimeout(PAGE_ERROR_SETTLE_MS)`;
`command-bar.test.ts` does the same for console messages. A DOM assertion (`toBeVisible`)
says nothing about whether a console event has landed yet.

Two rules the suite now encodes, worth copying into any new console assertion:

- The settle wait is **unconditional**, not a race or a `Promise.race` against the first
  warning. A warning that arrives early is as much a regression as one that arrives late.
- The assertion must **prove its own channel delivers**. `command-bar.test.ts` emits a
  probe message per filter alternative from the page and polls for it in a second
  collector. Without that, a channel that silently stopped delivering leaves the test
  green forever. Emit the probe *after* `expect(messages).toEqual([])` — it matches the
  same filter, so emitted first it poisons the buffer it is meant to be independent of.

## Console noise is expected in dev, not a defect

Scoping matters: the schedules e2e asserts only the two controlled/uncontrolled-input
warnings, and says so in a comment. "No console output at all" is not a pass condition
in `yarn start`.

## Running one loot-core test file

`packages/loot-core` splits its suite by environment and the two configs have
**different `include`/`exclude` lists**. `src/platform/server/sqlite/index.test.ts` and
`.../fs/index.test.ts` run only under the web config; the node config explicitly excludes
them. A bare `vitest --run` in that workspace silently skips them.

```bash
# web env (jsdom) — the sqlite/fs platform tests live here
yarn workspace @actual-app/core exec vitest --run -c vitest.web.config.ts src/platform/server/sqlite/index.test.ts
```

Note for anyone adding a regression test there: `-t '<name>'` makes an
order-dependent test vacuous (see `patterns/sqlite-platform-tests-share-process-state.md`).

## E2E is not run by this pipeline's own CI

`.sdlc/config.yml` has `verify.e2e: ""`, and `ci-verify.yml` skips the E2E step when
that is empty. Browser verification happens in the QA stage against a live preview
(`yarn start` on port 3001), not in the verify job. A change that only e2e exercises is
effectively untested until QA runs.