# Roadmap

Survey of 2026-10-02. Rebuilt from `maintainer/issues.json`, `maintainer/pulls.json` and
`maintainer/closed.json`. First survey on this repository — there was no previous roadmap.

## Shipped

Three fixes landed today, all from the pipeline, all user-visible:

- A rule or filter whose "matches" value is typed as an incomplete regular expression no longer
  crashes the app. The bad pattern is reported once in the diagnostic rather than once per row.
- A weekly custom report covers its whole final week instead of only its first day.
- The running balance column — and the toggle that shows it — stays available when an account's
  transactions are sorted oldest-first rather than newest-first.

## In flight

- **#4 → PR #9** (`sdlc/issue-4`, open). Custom report "show empty rows" ignores unchecked
  categories. At QA.
- **#6 → PR #15** (`sdlc/issue-6`, open). Posting any upcoming transaction for a schedule posts
  the *first* one instead of the one picked. At QA.
- **#7** in planning. Posting a scheduled transaction early does not remove the schedule. Carries
  a recorded decision from @Shivam-Fl permitting a `packages/loot-core/migrations/**` addition
  (the migration runner and sync-server migrations stay reserved).
- **#14** in planning — see Next.
- **#1** parked for a human (`sdlc:needs-human`).

## Next

1. **Split #13, #14 and #16 before any of them is planned.** Each is one ticket carrying five to
   seven findings that share no files and no fix: a rename, a comment rewording, a work-order
   scope correction and a genuine behavioural defect in the same list. Each says "split this if
   they turn out to be unrelated" — they are. Reason: as written they cannot be sized as one work
   order, and #14 is the next to be planned, so it is the one that would be planned badly.
2. **The release-note author check** (filed this survey). Two of the three release notes this
   pipeline shipped carry `authors: [claude]`, and the CI gate that validates them only checks
   that the field exists and is an array. It reaches the published changelog as "— thanks
   @claude". Reason: it is the one recurring finding that reaches users and that a check in this
   repository can actually prevent, rather than one more line in a follow-up ticket.
3. **Decide whether browser tests run at all in this fork** — see Blocked. Everything the
   pipeline has shipped so far is UI behaviour, and none of it is covered by a check that CI
   collects.

## Blocked, and on whom

- **#13 and #16 are labelled `sdlc:blocked`, but nothing is blocking them.** Both say
  `Depends on #2` / `Depends on #8`, and both of those parents are closed. They were filed three
  and four seconds after their parent closed, so the dependency was already satisfied on arrival —
  and #14, filed five seconds after #3 closed in exactly the same way, came out of the same
  moment labelled `sdlc:planning` and was picked up. Three identical filings, two outcomes. This
  is pipeline plumbing rather than repository work, so it is not a ticket here; it wants a human
  to look at why the wake did not reach two of the three.
- **The e2e suite is never executed.** `packages/desktop-client/vite.config.mts` collects
  `src/**/*.{test,spec}.*` only, and `verify.e2e` in `.sdlc/config.yml` is empty, so the
  `packages/desktop-client/e2e/*.test.ts` files — including the two the last three PRs added — run
  under no check in this repository. The review of #2 found exactly this: reverting the one-line
  fix leaves `yarn test` fully green. `.sdlc/config.yml` is a reserved path, so enabling it is a
  human's call, and it is a real CI-minutes decision rather than a one-line change.
- **There is no spec, so there is nothing to trace requirements against.** `spec.paths` names
  `docs/spec` and `SPEC.md`; neither exists. No spec index, no project brief, no `Covers:` line on
  any issue, and consequently **no Spec coverage issue exists** — the coverage table is not
  deferred, it was never created because there are no sections to enumerate. Until a person
  decides what the spec of this fork is, coverage cannot be measured. Worth one conversation,
  not a ticket: writing a spec is a decision about what the product should be, which is the
  owner's, not the pipeline's.
- **#1** is parked on a person, not on work (`sdlc:needs-human`).

## Epics

**None are open.** No issue in `maintainer/issues.json` carries `sdlc:epic`, so there is no epic
dependency graph to write: no epic waits on another, and nothing is waiting on an epic.

The natural epic-shaped body of work — the scheduled-transaction area behind #6, #7 and the
upstream report behind #5 — has not been written down as one. It is eventual rather than next:
each of those three is individually plannable today, so opening an epic for them would put a
backlog against an architecture nobody has needed yet.
