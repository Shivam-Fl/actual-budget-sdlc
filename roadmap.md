# Roadmap

Survey of 2026-10-04, rebuilt from `maintainer/issues.json`, `maintainer/pulls.json` and
`maintainer/closed.json`: **eighteen open issues, twelve open PRs, twenty-six issues closed**
in the window `closed.json` covers. Two open epics. No open issue is marked `untrusted`, so
all eighteen are the pipeline's own and all eighteen were read in full.

Where this disagrees with the previous roadmap, this one is right and says so.

## Shipped

What a person can do now that they could not before. Capabilities, not PR numbers.

Five merges landed since the last survey:

- **A schedule occurrence cannot be paid twice once its transaction has been split.** The
  duplicate-post guard read transactions with AQL's default `splits: 'inline'`, which appends
  `is_parent = 0` — and the split parent is the one row that keeps the `schedule_occurrence`
  stamp, because `makeChild` copies neither `schedule` nor the stamp onto children. A posted
  occurrence whose transaction was later split was invisible to the guard and could be written
  twice, while two sibling queries in the same subsystem already passed `splits: 'all'`.
- **A weekly report's header names the week its final bucket actually covers.** Before, the
  header printed the un-widened end date while the buckets covered the full final week, so the
  two disagreed after the fix. The end-date rule now lives once in `getEffectiveEndDate` in
  `reportRanges.ts` and is called from all three consumption sites instead of being written out
  three times.
- **Skip is hidden when a schedule's recurrence is exhausted**, and only then — a one-off
  schedule's Skip button used to be offered and silently did nothing, because one of four call
  sites reimplemented the eligibility test instead of reusing the shared predicate.
- **Console spies in the e2e suite are attributed to the test that installs them**, so a spy
  installed by one test and torn down by another's ordering is traceable.
- **A double-clicked Schedules row no longer stacks two edit forms.** The row now replaces the
  modal stack rather than pushing onto it.

Carried forward, still true: the running-balance column survives an oldest-first transaction
sort; posting a scheduled transaction early no longer deletes the schedule, and occurrences are
recorded rather than inferred from dates; a rule or filter whose *matches* value is an
incomplete regular expression reports the bad pattern once instead of crashing; the release-notes
gate rejects `authors:` entries that are not people, validates an edited note as well as an added
one, survives a deleted `README.md` as a gate error rather than an uncaught `ENOENT`, and reads
diff paths verbatim; the sqlite `REGEXP` teardown observer restores whether or not the test that
installed it finished first.

## In flight

**Twelve PRs are open and not one of them carries the `[AI]` prefix.** One per issue below
except the two Librarian memory PRs. Nothing in the backlog is mid-pipeline except #72.

- **#72 → PR #81** (`sdlc:implementing`). Five review findings and one QA finding from #42.
  The only issue in the backlog with forward motion. Its first finding is the same
  `(schedule, schedule_occurrence)` stamp read with the wrong `splits` option that #42 just
  fixed, in a fourth consumer — the forecast, at
  `packages/loot-core/src/server/forecast/forecast-filters.ts:83`, which sets
  `.options({ splits: 'inline' })` explicitly. Verified in the tree today.
- **#78 → PR #80** (`sdlc:qa`). Five review findings from #20, on the end-date helper's own
  consolidation.
- **#43 → PR #71** (`sdlc:budget-exceeded`). Schedule actions from an upcoming row affect the
  occurrence you clicked. Child of epic #41.
- **#63 → PR #64** (`sdlc:needs-human`). Six review findings from #57, on the e2e console
  collector.
- **#44 → PR #62** (`sdlc:needs-human`). Upcoming rows stop disappearing when schedule data
  refreshes. Child of #41.
- **#45 → PR #54** (`sdlc:needs-human`). A schedule's unpaid occurrences all stay listed when
  occurrences are close together. Child of #41.
- **#38 → PR #56** (`sdlc:needs-human`). Six review and one QA finding from #25 — the schedule
  stamp surviving a transfer and an unlink onto the wrong schedule.
- **#31 → PR #32** (`sdlc:needs-human`). Five review and four QA findings on the release-notes
  gate. Open since 2026-10-03 04:10 — the longest-running issue in the backlog.
- **#22 → PR #26** (`sdlc:planning`). Reports dashboard loads without React's nested-button
  warning. Child of #14. Diff open, unmerged for two days.
- **#4 → PR #9** (`sdlc:review`). Custom report "show empty rows" ignores unchecked categories.
  Open since 2026-10-02 04:33 — the longest-open diff in the queue.
- **#77**, `memory/ 2026-10-04`, and **#37**, `memory: 2026-10-03`. Two Librarian memory PRs,
  both unmerged; #37 is the oldest PR in the queue and the only one nobody is waiting on.
- **#82** (`sdlc:blocked`), **#75** (`sdlc:blocked`), **#13** (`sdlc:blocked`), **#36**
  (`sdlc:self-fix`). No PR. See Blocked.

The shape of this list is the finding, not the individual lines: **eleven of the twelve PRs are
finished work waiting on a person**, and of the eighteen open issues, fourteen carry a label
that means stopped — four `sdlc:blocked`, six `sdlc:needs-human`, one `sdlc:budget-exceeded`,
one `sdlc:self-fix`, one `sdlc:review`, one `sdlc:planning`. Nothing is queued behind nothing.
No agent is idle because work is missing; work is missing because nothing merges.

## Next

1. **Merge the queue.** Reason: twelve PRs, eleven of them finished, and every one of them a
   complete ticket with a QA or review verdict behind it. This is the whole of the current
   bottleneck, and it is a person's twelve decisions — no agent decision improves it.
2. **Unblock #13.** Reason: it holds the most severe defect in the backlog — a live money defect
   reachable today, on `main` — and it is parked behind a label that does not apply to it.
   Details in Blocked.
3. **Put `[AI]` on twelve PR titles.** Reason: it is a rule the repo states unconditionally and
   reaches every agent through `CLAUDE.md`, it is now a review finding on eight tickets, and it
   has started landing on `main` — five commits there carry a bare `fix:` subject because squash
   merge reuses the PR title. Verified in `git log`: `dff184c`, `dbcdcee`, `97938bb`, `ca80651`,
   `257195f`. The root cause is one line and is not fixable from inside a ticket; see Blocked.
4. **Decide what CI runs.** Reason: 22 e2e files run under no check, and a release-notes gate
   with a large test suite is invoked by no workflow. That is a CI-minutes decision, not a
   ticket, and it is the reason every defect in those files was found by an agent reading them
   rather than by a check that ran. See Blocked.

## Blocked, and on whom

- **#13 holds a live money defect, and it is on `main` today.** The #2 fix widened
  `canCalculateBalance()` to accept an ascending date sort, but `runningBalance` still seeds
  prepended upcoming rows from `balances[transactions[0].id]`
  (`packages/desktop-client/src/components/accounts/Account.tsx:155`, verified in the tree today).
  The balance window is forced newest-first by `balanceQuery.ts:10`, so `transactions[0]` is the
  *newest* row under a descending sort and the *oldest* under an ascending one — whose running
  balance is its own amount, not the account total. Every upcoming scheduled row on an
  oldest-first-sorted account displays a balance seeded from the wrong base. It is written up as
  the second finding in #13's body and is deliberately **not** re-filed here: a duplicate racing
  the original helps nobody and #13 is its canonical home. It is called out because it is the most
  severe thing in the backlog and it is sitting behind a label that does not apply to it.
- **Four issues are labelled `sdlc:blocked` and nothing is blocking three of them.** #75 says
  `Depends on #70`, which closed at 08:39:09 and #75 was filed at 08:39:13 — a four-second race.
  #82 says `Depends on #74`, which closed at 15:58:07 and #82 was filed at 15:58:11 — the same
  four-second race, the second time it has produced one. #13 says `Depends on #2`, closed two days
  earlier. #5 carries no `Depends on` at all and has been blocked since intake. This is the third
  observation of one shape: an issue filed against a just-merged parent is parked rather than
  woken. It is pipeline plumbing under `.sdlc/bin/**`, a forbidden path, so it wants a person to
  look at the wake, not a ticket.
- **No open PR carries the mandatory `[AI]` prefix, and the generator is why.**
  `.sdlc/bin/open-pr.mjs:138` builds every title as `` `fix: ${issueData.title}` ``, with no
  prefix, and `.sdlc/bin/**` is in `forbidden_paths`. So the rule is violated on every PR the
  pipeline opens, by construction — it is not an agent forgetting. `#75` found this and reached the
  same conclusion: the work order argued the title "cannot be fixed in this repo" because the
  generator cannot, which is true about `open-pr.mjs` and false about renaming an open PR.
  Not filed, for two reasons: `.sdlc/bin/**` is reserved, and the remedy that is actually
  available — twelve `gh pr edit --title` calls — is a person's, not a ticket's.
- **Three PRs are finished and unmerged past their budget.** #9, #26 and #71 are all
  `sdlc:budget-exceeded`: the budget bought the diff and there is nothing left to review or merge
  it. That is a decision about budget, not a failure to work. #9 has been open since
  2026-10-02 04:33.
- **The e2e suite and the browser build are never executed, and the release-notes gate is never
  invoked.** `verify.e2e` and `verify.build` in `.sdlc/config.yml` are both empty strings
  (lines 171–172), so CI runs typecheck, lint and unit and nothing else; the 22
  `packages/desktop-client/e2e/*.test.ts` files run under no check.
  `.github/actions/release-notes/check/action.yml` exists and nothing under `.github/` references
  it. The cost of the first is demonstrated exactly: reverting the one-line fix that shipped the
  running-balance bug leaves `yarn test` fully green. The cost of the second is a chain of
  consecutive tickets — #17, #24, #28, #31 — each finding a new defect in the same two files,
  every one of them found by an agent reading the file rather than by a check that ran.
  `.sdlc/config.yml` and `.github/**` are both forbidden paths, so this is a human's CI-minutes
  decision and not a ticket.
- **One self-fix issue is stopped on a credential.** #36 lists the pipeline's own defects from the
  last 24 hours. Both were **refused and stopped for a person**: the framework's source at
  `Shivam-Fl/automated-ai-sdlc` could not be read, because a private framework needs the
  `SDLC_FRAMEWORK_TOKEN` secret with read access to it. Until that secret exists, the pipeline
  cannot review its own fix for a defect it has already diagnosed — and #36 has now been open
  since 2026-10-03 08:56 without moving.
- **There is still no spec, and therefore still no Spec coverage issue.** A survey should expect
  to find one among the open issues; there is none, and there never has been. `spec.paths` names
  `docs/spec` and `SPEC.md`; neither exists, and `docs/` does not exist at all. No open issue
  carries a `Covers:` line and none is a coverage table — not deferred, never created, because
  there are no sections to enumerate. Until a person decides what the spec of this fork is,
  coverage cannot be measured. Worth one conversation, not a ticket: writing a spec is a decision
  about what the product should be, and that is the owner's.
- **Two Librarian memory PRs are open** — #37 (2026-10-03) and #77 (2026-10-04) — both unmerged
  and both titled without the prefix. Nobody is waiting on them.
- **#1 is parked on a person**, not on work: an upstream app crash on showing reconciled
  transactions after a sort change, re-filed from `actualbudget/actual#6073`.

## Epics

Two open epics. Neither waits on the other, and nothing waits on either, so no `epic_links` are
proposed — a dependency is "this cannot be built yet", and there is no such edge here.

- **#41** — Follow-ups from #6 (schedule occurrences). In flight, **1 of 4 children closed**.
  #42 closed 2026-10-04 06:38 (PR #69). #43 → PR #71, #44 → PR #62, #45 → PR #54, all three
  open. No child declares a dependency on another, so nothing inside #41 is waiting on anything;
  it closes when its children do.
- **#14** — Follow-ups from #3 (weekly report end-date). In flight, **2 of 3 children closed**.
  #20 and #21 closed; #22 is open with PR #26. Nothing inside #14 waits on anything either.

Grandchildren worth noting, because they are *not* declared children and so do not hold either
epic open: **#72** (`Depends on #42`) and **#78** (`Depends on #20`) are follow-up tickets on
issues that were themselves split out of #41 and #14. #78's five findings are all about the
consolidation #20 shipped, and #72's first is the sibling of the bug #42 shipped — so both
epics' work is generating new tickets after the fact rather than closing cleanly. That is a
property of the split, not a defect in it.

The epic-shaped body of work that is *not* written down: eight open follow-up mega-tickets (#82,
#78, #75, #72, #63, #38, #31, #13) each carry one to seven findings across unrelated files, and
only #14 and #41 carry the `sdlc:epic` label. A person applies that label, so this is a labelling
decision rather than a ticket — but it is the clearest single observation this survey has about
why the queue is as deep as it is.

## What this survey did not file, and why

Nothing. The previous survey filed nothing either, and the reasons still hold; two of them have
got stronger and one is new.

- **Every candidate defect found by reading the tree is already an open ticket's finding.** The
  running-balance seed at `Account.tsx:155` is #13's second finding. The forecast's
  `splits: 'inline'` read at `forecast-filters.ts:83` is #72's first finding. The un-prefixed
  title generator at `open-pr.mjs:138` is #75's only finding. The schedule stamp surviving a
  transfer onto the wrong schedule is #38's first finding and its QA finding. Re-filing any of
  them would race the ticket that already owns it, which is the fastest way to make an issue list
  untrustworthy.
- **The umbrella that would cover them is a reserved path, not a ticket.** Four of the five
  findings above want the same things — a person to look at the blocked-label wake, at
  `open-pr.mjs`, at `verify.e2e`/`verify.build`, and at the un-referenced release-notes action.
  All four live in `.sdlc/bin/**`, `.sdlc/config.yml` or `.github/**`, every one of which is in
  `forbidden_paths`. A ticket filed against them could do nothing except stop at its plan for a
  person, which is a worse artefact than the roadmap section saying it plainly.
- **New, and the reason for filing even less than last time.** The backlog is now generating more
  findings than it retires: twenty-six issues closed in the window against twelve PRs unmerged,
  and five new tickets (#72, #75, #78, #82) filed in the six hours since the last survey, every
  one of them a follow-up on a merge that landed. Every additional issue filed this week queues
  behind a merge queue that is already twelve deep and generates its own follow-up tickets when
  it drains. A maintainer who opens twelve issues a week trains everyone to ignore the label.
  This week the honest number is zero, and the reason is in **Next** and **Blocked** rather than
  in a ticket.
