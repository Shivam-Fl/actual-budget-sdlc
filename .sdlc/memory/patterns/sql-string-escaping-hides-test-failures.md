# A sqlite test that passes on unfixed code because of string escaping

**Symptom.** A regression test guarding a crash stays green after you delete the guard. In
`packages/loot-core/src/platform/server/sqlite/index.test.ts` the invalid-regexp guard tests passed
with `logger.log` removed outright — they asserted `toBeLessThanOrEqual(1)`, so zero logs satisfied
them, and a *different* case used a SQL literal whose backslashes collapsed into a pattern that was
perfectly valid, so it never reached the `catch` at all.

**Cause.** Two independent mistakes that mask each other.

1. **Over-escaped SQL literals.** `"...REGEXP('\\\\', string)"` in a JS string literal is the
   4-character SQL text `'\\'` — a valid escaped-backslash regex. One backslash, `"REGEXP('\\',
   string)"`, is what actually reaches `regexp()` as an unparseable pattern. The number of
   backslashes in the test source is not the number of characters the function receives.
2. **Upper-bound assertions.** `toBeLessThanOrEqual(n)` on a log or call count passes at zero.
   Exact counts (`toBe(1)`, `toBe(2)`) are what make the assertion falsifiable.

**How to check quickly.** Before trusting a negative test in this repo, mutate the source it is
supposed to guard — delete the `logger.log`, remove the `try`/`catch` — and re-run. If the test
still passes, it is not testing the thing. Every "this should not happen" test here should fail on
the unfixed code. `sqlite` calls a user-defined function only when it scans a row, so a
"does not throw" case on an **empty table** is vacuous and passes with or without the guard; that
case was deleted for this reason.

**Related, same file.** The dedupe `Set` for reported invalid regexps is held in a `createRegexp()`
closure created per `openDatabase` call, not at module scope. A module-level `Set` makes the count
depend on process lifetime, so a test's expected count depends on which tests ran before it. If you
add a second SQLite-backed test file, it needs its own set — `index.ts` (sql.js) and
`index.electron.ts` (better-sqlite3) define the function independently and share no module state.