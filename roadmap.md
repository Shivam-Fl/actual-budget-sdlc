# Roadmap

Survey of 2026-10-03, rebuilt from `maintainer/issues.json`, `maintainer/pulls.json` and
`maintainer/closed.json`. Eighteen open issues, five open PRs, fifteen issues closed in the
window `closed.json` covers. Everything below is what those files say today, not what the
previous roadmap said — where the two disagree, this one is right and says so.

## Shipped

What a person can do now that they could not before. Capabilities, not PR numbers.

New since the last survey:

- The command palette opens without React's `DialogTitle` accessibility warning.
- Posting an Upcoming transaction for a schedule posts **the occurrence you picked**, not the
  first one — the earlier occurrence you are still owed stays listed and stays payable.
- A schedule link carries its occurrence stamp with it, so a transfer or a rule that re-links a
  transaction keeps the occurrence it paid.
- Upcoming preview ids are parsed by one helper everywhere, including the account balance view
  that had its own inline copy of the parse.
- The sqlite `REGEXP` teardown observer restores whether or not the test that installed it was
  the one that finished first, so the suite no longer depends on test order.

Carried forward from before, still true: the running balance column survives an
oldest-first transaction sort; a weekly custom report covers its whole final week; posting a
scheduled transaction early no longer deletes the schedule, and occurrences are recorded rather
than inferred from dates; a rule or filter whose *matches* value is an incomplete regular
expression reports the bad pattern once instead of crashing or repeating per row; the
release-notes gate rejects `authors:` entries that are not people, survives a deleted
`README.md` as a gate error rather than an uncaught `ENOENT`, and reads diff paths verbatim.

## In flight

- **#48 → PR #53** (`sdlc/issue-48`, open, `sdlc:review`). Six review findings from the command
  palette PR, one of which is that the accessibility assertion itself can pass on unfixed code
  because it reads the console before Playwright has delivered the event.
- **#31 → PR #32** (`sdlc/issue-31`, open, `sdlc:needs-human`). Five review and four QA findings,
  all on the release-notes gate. Four are the same unguarded-I/O defect class on four call sites.
- **#38** (`sdlc:implementing`, no PR yet). Six review and one QA finding from #25.
- **#45** (`sdlc:implementing`). The one child of epic #41 that has been picked up.
- **#51** (`sdlc:planning`). Four review findings from #47.
- **#22 → PR #26** (`sdlc/issue-22`, open). Reports dashboard loads without React's nested-button
  warning. `sdlc:budget-exceeded` with the work done and unmerged.
- **#4 → PR #9** (`sdlc/issue-4`, open). Custom report "show empty rows" ignores unchecked
  categories. Also `sdlc:budget-exceeded`, and open since 2026-10-02 04:33 — the longest stalled
  item in the backlog and the only one with a PR nobody has touched in a day.
- **#52** (no label, no PR). Two review and two QA findings from #46, filed 15:56 today.
- **#42, #43, #44** — the other three children of epic #41, no label and no PR.
- **#20** — the remaining child of epic #14, no label and no PR since it was split at
  2026-10-02 20:22. It is the only piece in the whole backlog that touches money, and it is the
  one that has not been started.
- **#36** (`sdlc:self-fix`) — the pipeline's own list of defects in its plumbing, with one
  stopped for a person. See Blocked.
- **#1** parked on a person (`sdlc:needs-human`).

**Why #20, #42, #43, #44 and #52 have no label.** Not forgotten — the pipeline is at capacity.
`limits.max_in_flight: 4`, and exactly four issues are mid-flight right now: #48 (review), #51
(planning), #38 and #45 (implementing). Every other piece is queued behind those four. This is a
different diagnosis from the previous survey's "never been picked up", and it changes what to do
about it: the work is not stuck, the queue behind it is.

## Next

1. **Give the release-notes gate an end-to-end test** (filed this survey). Reason: five
   consecutive tickets — #17, #24, #28, #31, #52 — have each found a new defect in the same
   two files, and #31 found four instances of one class in a single round. `bin/release-notes-check.mjs`
   is 143 lines and no test imports it; `src/release-notes/util.test.js` covers four of the eight
   things `util.mjs` exports, and `parseReleaseNotes` and `formatNotes` — which decide what ships
   in the published changelog — are in neither. This is the recurrence rule firing: the same bug
   shape five times is one missing test, not five bugs. The previous survey named this and said it
   had filed it; no such issue exists in `issues.json` or `closed.json`, so it is being filed now
   for the first time.
2. **Unblock #13.** See Blocked. Reason: it holds a live money defect reachable today, and it is
   the only such thing in the backlog.
3. **Free a slot in the pipeline.** Reason: four issues are mid-flight and five ready pieces are
   queued behind them, including the only money-touching one. #4 and #22 each finished their work
   and stopped at `sdlc:budget-exceeded` with the diff open; merging those two PRs is the cheapest
   way to get the money defect and the longest-stalled item moving, and it costs a person five
   minutes rather than an agent a full ticket.

## Blocked, and on whom

- **#13 and #5 are labelled `sdlc:blocked` and nothing is blocking either.** #13 says
  `Depends on #2`; #2 closed four seconds before #13 was filed. #5 carries no `Depends on` at all
  and has been blocked since intake. The previous survey saw this on #13 and #16; #16 recovered
  and was worked, #13 did not. This is pipeline plumbing, not repository work, so it is not a
  ticket — it wants a human to look at why the wake reaches some of these and not others.
- **#13 holds a live money defect.** The #2 fix widened `canCalculateBalance()` to accept an
  ascending date sort, but `runningBalance` still seeds prepended scheduled rows from
  `balances[transactions[0].id]` (`packages/desktop-client/src/components/accounts/Account.tsx:155`),
  and under an ascending sort `transactions[0]` is the *oldest* row, whose balance is its own
  amount rather than the account total. Every upcoming scheduled row on an account sorted
  oldest-first displays a balance seeded from the wrong base. Read the code — it is in that state
  on `main` today. It is written up as the second finding in #13's body and is deliberately not
  re-filed here, because a duplicate racing the original helps nobody. It is called out because
  it is the most severe thing in the backlog and it is sitting behind a label nothing justifies.
- **Two PRs are finished and unmerged.** #9 and #26 are both `sdlc:budget-exceeded`: the budget
  bought the diff and there is nothing left to review or merge it. That is a decision about budget,
  not a failure to work, and it is the only thing standing between #13's sibling work and done.
- **One self-fix is stopped on a credential.** #36 lists the pipeline's own defects from the last
  24 hours. Its first, a missing transcript-recovery step in the QA workflow, was **refused and
  stopped for a person**: the framework's source at `Shivam-Fl/automated-ai-sdlc` could not be
  read, because a private framework needs the `SDLC_FRAMEWORK_TOKEN` secret with read access to
  it. Until that secret exists, the pipeline cannot review its own fix for a defect it has already
  diagnosed.
- **The e2e suite is never executed.** `verify.e2e` in `.sdlc/config.yml` is empty, so the 22
  `packages/desktop-client/e2e/*.test.ts` files run under no check in this repository. The review
  of #2 demonstrated the cost exactly: reverting the one-line fix that shipped the running-balance
  bug leaves `yarn test` fully green. `.sdlc/config.yml` is a reserved path, so this is a human's
  call, and it is a real CI-minutes decision rather than a one-line change.
- **Every open PR violates the `[AI]` title rule.** PRs #9, #26, #32, #37 and #53 are all titled
  `fix: …` or `memory: …`. `.github/agents/pr-and-commit-rules.md` requires the prefix on every PR
  title and reaches every agent's context through `CLAUDE.md`. It has now been flagged as a review
  finding on four separate tickets — #14, #31, #48 and #52 — and violated on every PR since. Not
  filed: the only places to fix it are reserved paths (`.github/**`, `.sdlc/bin/**`), so a ticket
  could do nothing but stop at its plan for a person. It is a human's rename.
- **There is still no spec, and therefore still no Spec coverage issue.** `spec.paths` names
  `docs/spec` and `SPEC.md`; neither exists on this branch, and `docs/` does not exist at all. No
  issue carries a `Covers:` line and none is a coverage table — not deferred, never created,
  because there are no sections to enumerate. Until a person decides what the spec of this fork
  is, coverage cannot be measured. Worth one conversation, not a ticket: writing a spec is a
  decision about what the product should be, and that is the owner's.
- **#1 and #31 are parked on people**, not on work.

## Epics

Two open epics. Neither waits on the other, and nothing waits on either — no `epic_links` are
proposed, because a dependency is "this cannot be built yet" and there is no such edge here.

```
- #14  Follow-ups from #3 (weekly report end-date)  — in flight, 1 of 3 children closed
                             #21 closed; #22 has a PR open, budget-exceeded;
                             #20 not started — the only money-touching piece in the backlog
- #41  Follow-ups from #6 (schedule occurrences)    — in flight, 0 of 4 children closed
                             #45 implementing; #42, #43, #44 queued behind max_in_flight
```

#14 and #41 are the only issues labelled `sdlc:epic`. Both are follow-up mega-tickets from a
merged PR, both were split into independent children, and none of those children declares a
`Depends on` another, so nothing inside either epic is waiting on anything. Each will close when
its children do.

The epic-shaped body of work that is *not* written down: the other five follow-up mega-tickets
(#13, #31, #38, #48, #51, #52) each carry four to nine findings across unrelated files and no two
of them share a fix, and only #14 and #41 carry the `sdlc:epic` label. A person applies that
label, so this is a labelling decision rather than a ticket — but it is the clearest single
observation this survey has about why the queue is as deep as it is.