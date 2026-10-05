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

**Filter to `^e2e/`.** The command exits non-zero on errors in
`packages/loot-core/src/shared/` (`util.ts`, `months.ts`) that plain `tsc` reports but
the repo's `typescript-strict-plugin` grandfathers — both files carry a
`// @ts-strict-ignore` header, which that plugin honours and `tsc` does not. Those are
not yours. Only `e2e/`-prefixed lines indicate a real problem in the e2e tree.

Do not trust a remembered *count* of those non-`e2e/` errors; it drifts as `loot-core`
changes. Read the current output rather than expecting a fixed number.

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

## The app's "today" and its demo data are frozen under Playwright only

`packages/desktop-client/playwright.config.ts:17` sets `userAgent: 'playwright'`, and
`Platform.isPlaywright` is exactly `navigator.userAgent.includes('playwright')`
(`loot-core/src/shared/platform.ts:11`). That one string switches **two** independent
things off in a real browser session:

- **The clock.** `currentMonth`, `currentWeek`, `currentYear`, `currentDate` and
  `currentDay` (`loot-core/src/shared/months.ts:135-179`) all return hardcoded values
  instead of reading the date — `currentDay()` is literally `'2017-01-01'`,
  `currentMonth()` `'2017-01'`. A schedule created in Playwright is stamped
  `2017-01-01`; the same schedule created in QA's browser is stamped with the real
  current date.
- **The demo budget's randomness.** `#mocks/random` exports
  `Platform.isPlaywright ? pseudoRandom : Math.random` (`mocks/random.ts:16`), and
  `createTestBudget` builds every demo payee, category and transaction amount from it.
  `pseudoRandom` is not random at all: it returns a fixed **3-cycle**
  `0.45, 0.9, 0, 0.45, 0.9, 0, …`, so `pickRandom` over a 5-item list walks only
  `c, e, a, c, e, a, …`. Under Playwright the demo budget is identical on every run;
  in a real browser it differs on every reload.

**Consequence for QA, which drives a real browser at `localhost:3001`:** never assert a
demo-budget *amount*, a *count*, or a *date* against a literal. Write the assertion the
way the merged work orders did — assert the **invariant** (three synthetic rows exist,
each named `Uncategorized` / `Transfers` / `Off budget`, each amount cell non-blank) and
let the figures be whatever the run produced. PR #94's AC-2 does exactly this and says
why in the criterion itself.

The converse bites too: a Playwright test that *does* pin a literal can be right for
Playwright and wrong for QA, because the two environments genuinely disagree about what
"today" is. When a QA failure looks like a date or amount mismatch, check this before
filing it — the value may be correct for the environment it was written in.

`global.IS_TESTING` is the other half of each guard, and it is set only by
`desktop-client/src/setupTests.ts` and `loot-core/src/mocks/setup.ts`, i.e. by vitest,
never by the app bundle. So the browser half of `global.IS_TESTING || Platform.isPlaywright`
is false in QA, and the UA is doing all the work.

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