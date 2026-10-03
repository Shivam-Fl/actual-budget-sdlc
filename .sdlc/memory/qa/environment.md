# QA environment notes

Env quirks and repro recipes. Read before browser QA.

## The preview

`yarn start` serves the app on **http://localhost:3001**. Use **"View demo"** on the initial setup
screen (after "Don't use a server") — it creates a budget pre-populated with accounts,
transactions, categories and budgeted amounts, which is far more useful than an empty budget.

In constrained environments the Vite dev server serves many unbundled modules and the browser can
die with `ERR_INSUFFICIENT_RESOURCES`. Build and serve statically instead:
`yarn build:browser`, then serve `packages/desktop-client/build/` with `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Content-Policy: require-corp` — without those COOP/COEP
headers the app does not start.

## Console errors that are already known — do not re-file

These are pre-existing and each already has an open ticket. A QA run that reports them again is
filing a duplicate, which costs a human a triage pass.

| Symptom | When | Ticket |
|---|---|---|
| React `validateDOMNesting(...): <button> cannot appear as a descendant of <button>` | Every load of `/reports` only. Not `/reports/custom`, not `/reports/spending`. Zero interaction needed. | #22 |
| React ``Warning: `DialogContent` requires a `DialogTitle` `` | Every Ctrl+K / Ctrl+P open of the command palette. Emitted by cmdk's own Dialog wrapper. | #21 |

## Running the release-notes gate by hand

`packages/ci-actions/bin/release-notes-check.mjs` is a plain Node script and does not need CI, but
it reads two env vars and dies confusingly without them:

```bash
BASE_REF=main GITHUB_STEP_SUMMARY=/tmp/step-summary.md \
  node packages/ci-actions/bin/release-notes-check.mjs
```

- `BASE_REF` unset → `::error::BASE_REF env var is not set`, exit 1.
- `GITHUB_STEP_SUMMARY` unset → the script exits 1 after printing, but it can also die on an
  unhandled `error` event from `fs.createWriteStream` if the *parent directory* of that path does
  not exist (known, ticket filed from QA on #30). Point it at a path whose directory exists.
- The script reads paths out of `git diff`, so it only sees what is committed. An uncommitted note
  is invisible to it.

Three defects in this gate are already known and reported (ENOENT on a deleted
`upcoming-release-notes/`, a non-UTF-8 filename rejected as missing, `::error::` truncation at ~64KB
on a pipe). Check whether they still reproduce before planning them — see #31.