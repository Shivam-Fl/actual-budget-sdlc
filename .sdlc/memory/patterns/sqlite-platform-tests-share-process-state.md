# The sqlite platform tests share one process, and `vi.restoreAllMocks()` is file-scoped

## Symptom

Two shapes, both in `packages/loot-core/src/platform/server/sqlite/`:

- A regression test that **passes when run alone and fails in a full-file run**, or the
  reverse — the failure depends on which tests ran before it.
- A `beforeAll` that installs a global mock appears to work for the first test and then
  silently stops applying. Specifically: `global.fetch` was the real jsdom `fetch` again
  from the second test onward, so the sql.js wasm fetch only resolved for test one.

## Cause

`vi.restoreAllMocks()` restores **every spy in the file**, not just the ones a given test
installed. An `afterEach` calling it therefore also tears down mocks installed by a
`beforeAll` at file scope.

The suite works only because of two arrangements, both of which look incidental:

- `patchFetchForSqlJS` is `vi.spyOn(...).mockImplementation(...)` with no restore of its
  own, so calling it **once per test** from a `beforeEach` is idempotent and the blanket
  restore can no longer outrun it. It is re-armed in `beforeEach`, not just `beforeAll`,
  for exactly this reason.
- The regression test that guards this
  (`'keeps the sql.js wasm fetch patched for each test, not just the first'`) is **last in
  the describe block, and that position is load-bearing**. Placed first it would still
  see the `beforeAll`'s patch, because no `afterEach` has run yet, so it would pass for
  the wrong reason.

## How it was found

By trying to break the test on purpose. Replacing the `beforeEach` body with a bare
`vi.spyOn(global, 'fetch')` that serves nothing left the test **passing** — the old
assertion only checked that `fetch` was a mock function, which a spy that serves nothing
also satisfies. It now fetches the wasm and asserts `res.status === 200`, which
distinguishes the real sql.js patch from an empty spy.

Deleting the `beforeEach` entirely still fails the test in a **full-file** run
(`1 failed | 15 passed`), which is the power that matters.

## The trap to avoid

**`-t '<test name>'` makes these tests vacuous.** Measured: with the `beforeEach`
removed, `vitest --run -c vitest.web.config.ts -t 'keeps the sql.js wasm fetch patched'`
still reports `1 passed | 15 skipped` — because running one test means no earlier test
ran, so nothing restored the patch. A green `-t` run is not evidence for any test in
these two files. Run the **whole file**.

## Related, same root cause

`index.test.ts` and `index.electron.test.ts` keep their teardown in `afterEach` rather
than at the tail of a test body — an assertion failing above the cleanup would otherwise
skip it — and both mirror each other on the order: **restore mocks, then close handles**.
The electron file's REGEXP dedupe `Set` is likewise pinned to the database handle rather
than the process, because `'should report an unparseable pattern once per database
handle, not once per process'` would otherwise pass for the wrong reason when two tests
share a handle.

Hand-written teardown comments in these files were corrected several times because they
described the **pre-fix** state as the current one. If you edit one, read it top to
bottom and check every sentence against the code four lines below it.