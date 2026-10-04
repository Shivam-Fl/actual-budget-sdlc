# Roadmap

Survey of 2026-10-04, rebuilt from `maintainer/issues.json`, `maintainer/pulls.json` and
`maintainer/closed.json`: eighteen open issues, eleven open PRs, twenty-one issues closed in
the window `closed.json` covers. Where this disagrees with the previous roadmap, this one is
right and says so — one of its central claims is now false.

## Shipped

What a person can do now that they could not before. Capabilities, not PR numbers.

New since the last survey:

- **Skip next scheduled date is no longer offered on a one-off schedule**, where the write was
  silently dropped by a null guard and the click did nothing at all. One of four call sites had
  reimplemented the eligibility test from `status === 'completed'` instead of reusing the
  predicate the other three share.
- **The release-notes gate validates an edited note, not only an added one.** It destructured
  `{added, changed}` but gated on `added`, so a diff that only edited or renamed a note was
  refused for having added nothing and its contents were never checked. `changed` is a superset
  of `added`, so every case the old gate accepted still passes and every case it rejected is
  now validated for the right reason.
- **Upcoming preview ids are parsed by one helper at every call site**, including the account
  balance view that had its own inline copy of the parse.

Carried forward, still true: the running balance column survives an oldest-first transaction
sort; a weekly custom report covers its whole final week; posting a scheduled transaction early
no longer deletes the schedule, and occurrences are recorded rather than inferred from dates;
a rule or filter whose *matches* value is an incomplete regular expression reports the bad
pattern once instead of crashing; the release-notes gate rejects `authors:` entries that are not
people, survives a deleted `README.md` as a gate error rather than an uncaught `ENOENT`, and
reads diff paths verbatim; the sqlite `REGEXP` teardown observer restores whether or not the
test that installed it finished first.

## In flight

Eleven PRs are open, one per issue below. Nothing in the backlog is mid-pipeline right now —
every open issue carries a terminal label.

- **#43 → PR #71** (`sdlc:qa`). Schedule actions from an upcoming row affect the occurrence you
  clicked. One of the four children of epic #41.
- **#42 → PR #69** (`sdlc:qa`). A posted occurrence is never posted twice, even after its
  transaction is split. Child of #41.
- **#61 → PR #68** (`sdlc:qa`). Five review and three QA findings from #52.
- **#63 → PR #64** (`sdlc:needs-human`). Six review findings from #57.
- **#45 → PR #54** (`sdlc:needs-human`). A schedule's unpaid occurrences all stay listed when
  occurrences are close together. Child of #41.
- **#44 → PR #62** (`sdlc:needs-human`). Upcoming rows stop disappearing when schedule data
  refreshes. Child of #41.
- **#38 → PR #56** (`sdlc:needs-human`). Six review and one QA finding from #25.
- **#31 → PR #32** (`sdlc:needs-human`). Five review and four QA findings on the release-notes
  gate. Open since 2026-10-03 04:10 — the longest-running issue in the backlog.
- **#20** (`sdlc:planning`, no PR). The last child of epic #14, and the only piece in the whole
  backlog that touches money and has never been started. It carries the one unresolved product
  question in any epic: whether a Weekly+Budgeted report widens its end date like every other
  Weekly report, or is deliberately left un-widened.
- **#22 → PR #26** (`sdlc:budget-exceeded`). Reports dashboard loads without React's nested-button
  warning. Work done, diff open.
- **#4 → PR #9** (`sdlc:budget-exceeded`). Custom report "show empty rows" ignores unchecked
  categories. Work done, diff open, and open since 2026-10-02 04:33.
- **#37**, `memory: 2026-10-03` (open, no issue). A Librarian memory PR that has been open since
  the last survey and unmerged. The oldest PR in the queue and the only one nobody is waiting on.
- **#70** (`sdlc:blocked`, no PR). Three review findings from #66. See Blocked.
- **#1** (`sdlc:needs-human`). An upstream app crash on showing reconciled transactions after a
  sort change. Parked on a person.
- **#36** (`sdlc:self-fix`). The pipeline's own list of defects in its plumbing, both refused and
  stopped for a person. See Blocked.

## Next

1. **Unblock #13.** See Blocked. Reason: it holds the most severe defect in the backlog — a
   live money defect reachable today — and it is parked behind a label nothing justifies.
2. **Merge #9 and #26, and rename the open PRs.** Reason: eleven PRs are open and every one is
   finished work waiting on a person. That is the whole of the current bottleneck; no agent is
   idle because work is missing.
3. **Decide what CI runs.** See Blocked. Reason: 22 e2e files, no build gate, and a
   release-notes gate with a 201-line test suite that no workflow invokes. That is a CI-minutes
   decision, not a ticket, and it is the reason every defect in those files was found by an
   agent reading them rather than by a check.

## Blocked, and on whom

- **Three issues are labelled `sdlc:blocked` and nothing is blocking any of them.** #13 says
  `Depends on #2`, which closed four seconds before #13 was filed. #70 says `Depends on #66`,
  which closed at 04:38:09 and #70 was filed at 04:38:13 — the same four-second race, the
  second time it has produced this. #5 carries no `Depends on` at all and has been blocked
  since intake. This is the third observation of one shape: an issue filed against a
  just-merged parent is parked rather than woken. It is pipeline plumbing under `.sdlc/bin/`,
  so it wants a person to look at the wake, not a ticket.
- **#13 holds a live money defect, and it is on `main` today.** The #2 fix widened
  `canCalculateBalance()` to accept an ascending date sort, but `runningBalance` still seeds
  prepended upcoming rows from `balances[transactions[0].id]`
  (`packages/desktop-client/src/components/accounts/Account.tsx:155`). The balance window is
  forced newest-first by `balanceQuery.ts:10`, so `transactions[0]` is the *newest* row under a
  descending sort and the *oldest* under an ascending one — whose running balance is its own
  amount, not the account total. Every upcoming scheduled row on an account sorted oldest-first
  displays a balance seeded from the wrong base. I have read the code; it is in that state now.
  It is written up as the second finding in #13's body and is deliberately **not** re-filed
  here, because a duplicate racing the original helps nobody and #13 is its canonical home. It
  is called out because it is the most severe thing in the backlog and it is sitting behind a
  label that does not apply to it.
- **Eleven PRs are open and none carries the mandatory `[AI]` prefix.** All are titled `fix:` or
  `memory:`. `.github/agents/pr-and-commit-rules.md` requires the prefix on every PR title and
  reaches every agent's context through `CLAUDE.md`. It is now a review finding on six tickets —
  #14, #31, #38, #61, #63, #70 — and violated on every PR since. The count of open PRs has
  doubled since the last survey and the count of violations has gone with it, which is what a
  rule nobody enforces looks like. Not filed: the only places to fix it are reserved paths
  (`.github/**`, `.sdlc/bin/**`), so a ticket could do nothing but stop at its plan for a person.
  It is a human's rename, and it is eleven renames.
- **Two PRs are finished and unmerged.** #9 and #26 are both `sdlc:budget-exceeded`: the budget
  bought the diff and there is nothing left to review or merge it. That is a decision about
  budget, not a failure to work.
- **The e2e suite and the browser build are never executed, and the release-notes gate is never
  invoked.** `verify.e2e` and `verify.build` in `.sdlc/config.yml` are both empty, so CI runs
  typecheck, lint and unit and nothing else; the 22 `packages/desktop-client/e2e/*.test.ts` files
  run under no check. `.github/actions/release-notes/check/action.yml` exists and nothing under
  `.github/` references it. The cost of the first is demonstrated exactly: reverting the
  one-line fix that shipped the running-balance bug leaves `yarn test` fully green. The cost of
  the second is five consecutive tickets — #17, #24, #28, #31, #52 — each finding a new defect in
  the same two files, every one of them found by an agent reading the file rather than by a
  check that ran. `.sdlc/config.yml` and `.github/**` are reserved paths, so this is a human's
  CI-minutes decision and not a ticket.
- **One self-fix is stopped on a credential.** #36 lists the pipeline's own defects from the last
  24 hours. Both were **refused and stopped for a person**: the framework's source at
  `Shivam-Fl/automated-ai-sdlc` could not be read, because a private framework needs the
  `SDLC_FRAMEWORK_TOKEN` secret with read access to it. Until that secret exists, the pipeline
  cannot review its own fix for a defect it has already diagnosed.
- **There is still no spec, and therefore still no Spec coverage issue.** `spec.paths` names
  `docs/spec` and `SPEC.md`; neither exists, and `docs/` does not exist at all. No issue carries
  a `Covers:` line and none is a coverage table — not deferred, never created, because there are
  no sections to enumerate. Until a person decides what the spec of this fork is, coverage
  cannot be measured. Worth one conversation, not a ticket: writing a spec is a decision about
  what the product should be, and that is the owner's.
- **#1 and #31 are parked on people**, not on work.

## Epics

Two open epics. Neither waits on the other, and nothing waits on either — no `epic_links` are
proposed, because a dependency is "this cannot be built yet" and there is no such edge here.

```
- #14  Follow-ups from #3 (weekly report end-date)  — in flight, 1 of 3 children closed
                             #21 closed; #22 has a PR open, budget-exceeded;
                             #20 not started — the only money-touching piece in the backlog
- #41  Follow-ups from #6 (schedule occurrences)    — in flight, 0 of 4 children closed,
                             all four with a PR open: #42→#69, #43→#71, #44→#62, #45→#54
```

The state of #41 is the same shape as #14's one closed child: the splits are healthy, every
child is independently shippable, and none declares a `Depends on` another, so nothing inside
either epic is waiting on anything. Each will close when its children do.

The epic-shaped body of work that is *not* written down: the other six follow-up mega-tickets
(#13, #31, #38, #61, #63, #70) each carry three to nine findings across unrelated files and no
two of them share a fix, and only #14 and #41 carry the `sdlc:epic` label. A person applies that
label, so this is a labelling decision rather than a ticket — but it is the clearest single
observation this survey has about why the queue is as deep as it is.