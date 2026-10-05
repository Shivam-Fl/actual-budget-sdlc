# Roadmap

Survey of 2026-10-05, rebuilt from `maintainer/issues.json`, `maintainer/pulls.json` and
`maintainer/closed.json`: **twenty-four open issues, fourteen open PRs, thirty issues closed**
in the window `closed.json` covers. Two open epics — #41 from last survey, #83 new since.
No open issue is marked `untrusted`, so all twenty-four are the pipeline's own and all
twenty-four were read in full.

**The shape changed since yesterday, and it is the headline.** Last survey recorded a frozen
project: nothing merging, twelve PRs waiting, no work started. That is no longer true. Six
merges landed in the last twenty-four hours, the oldest finished PR in the queue is gone, and a
new epic was filed and split the same day. The bottleneck has not moved to a different problem;
it has loosened by roughly a third. Everything else in this roadmap is downstream of that.

## Shipped

What a person can do now that they could not before. Capabilities, not PR numbers.

Six merges since the last survey:

- **A custom report's category filter means the same thing as the query behind it.** The axis
  that decides which categories get a row or a column was matching text literally while the
  query compiled the same condition to a LIKE pattern, so a filter of `%` returned every
  category from the query and no node in the chart to render it into — the money left every
  total. One shared pattern module now compiles it, and both directions are pinned by tests
  that run the report against the query that fed it.
- **A posted schedule occurrence is not projected a second time once its transaction has been
  split.** The forecast read the occurrence stamp off the default split row set, which excludes
  the split parent — the only row carrying the stamp. It now reads it through the same query
  the other three consumers use.
- **Unsplitting one leg of a partially-filled split no longer zeroes the parent's amount.** The
  guard shipped for the empty case; the under-filled case a few rows below it did not have one.
- **A custom report's three synthetic rows get distinct React keys and the console stays clean**,
  and a real category row is now keyed by its own uuid rather than the empty string it shared
  with them.
- **The reports dashboard loads without React's nested-button warning**, and the card's click
  path is guarded so a control inside a widget body owns its own click.
- **The shipped custom-report fix got the release note the repository requires** — the epic's
  own finding that PR #9 merged with none.

Carried forward, still true: a weekly report's header names the week its final bucket actually
covers, through one shared end-date rule; a schedule occurrence cannot be paid twice after its
transaction is split; posting a scheduled transaction early does not delete the schedule;
skipping is hidden when a recurrence is exhausted; a double-clicked Schedules row no longer
stacks two edit forms; console spies are attributed to the test that installs them; a rule or
filter whose *matches* value is an incomplete regex reports the bad pattern once instead of
crashing; the release-notes gate rejects `authors:` entries that are not people and survives a
deleted `README.md`.

## In flight

**Fourteen PRs are open, and not one carries the `[AI]` prefix.** Twelve attach to an issue, two
are Librarian memory PRs. All twelve issue PRs are finished work with a QA or review verdict
behind it, waiting on a person.

Freshest, all from merges in the last twenty-four hours:

- **#97 → PR #103** (`sdlc:qa`). Three review findings from #88. The three key-collision tests
  assert nothing about keys: every mutant of the key expression leaves them green, and the
  second of the two warning patterns is strictly subsumed by the first, so it can never match a
  string the first rejects.
- **#86 → PR #102** (`sdlc:review`). The custom report's filter button gets an accessible name
  instead of an x-coordinate threshold, and two duplicated e2e helpers collapse to one. Child of
  #83.
- **#98 → PR #101** (`sdlc:qa`). Five review findings from #92, on the report card's click guard.
  The guard is an allowlist of eleven element *types* while the keydown guard four lines below
  blocks on every descendant unconditionally — the two halves of one handler now answer the same
  question two different ways.
- **#93 → PR #100** (`sdlc:qa`). Nine review findings from #72, including its first: the unsplit
  guard shipped for the all-zero case, and the neighbouring branch — two or more children
  remaining — still overwrites the parent's amount with the sum of the remainder. The same money
  defect the ticket was filed against, one branch below the fix.
- **#87 → PR #96** (`sdlc:needs-human`). 338 lines of test that run twice because a merge
  conflict copied them rather than moved them. Child of #83.

**#99 has no PR and no label.** Ten findings from the release-note gate's first shipped run,
filed at 03:09 this morning and not yet picked up.

Carried forward, unchanged:

- **#78 → PR #80** (`sdlc:needs-human`). Five review findings from #20, on the end-date helper's
  own consolidation.
- **#43 → PR #71** (`sdlc:budget-exceeded`), **#44 → PR #62** (`sdlc:needs-human`), **#45 → PR
  #54** (`sdlc:needs-human`). All children of #41, all finished.
- **#63 → PR #64** (`sdlc:needs-human`). Six review findings from #57, on the e2e console
  collector.
- **#38 → PR #56** (`sdlc:needs-human`). Six review and one QA finding from #25.
- **#31 → PR #32** (`sdlc:needs-human`). Five review and four QA findings on the release-notes
  gate. Open since 2026-10-03 04:10 — the longest-running code ticket in the backlog.
- **#84, #85, #90** (children of #83) have no PR. #84 and #85 have not started; #90 is correctly
  `sdlc:deferred`.
- **#82** (`sdlc:blocked`), **#75** (`sdlc:blocked`), **#13** (`sdlc:blocked`), **#5**
  (`sdlc:blocked`), **#36** (`sdlc:self-fix`), **#1** (`sdlc:needs-human`). No PR. See Blocked.

Across the twenty-four open issues: fifteen carry a label that means stopped — eight
`sdlc:needs-human`, four `sdlc:blocked`, one `sdlc:budget-exceeded`, one `sdlc:self-fix`, one
`sdlc:deferred`. Four are mid-stage. Three have no label because they were filed in the last
hours and have not started. That is a smaller stopped fraction than yesterday's fourteen of
eighteen, and it has the same cause: not enough merging, still.

## Next

1. **Keep draining the merge queue.** Reason: it is twelve finished tickets and two memory
   merges, and it is still the whole of the constraint. The change since yesterday is that it
   moved — six merges in twenty-four hours — so the thing to protect is the rate, not the size of
   the backlog. Every one of the twelve is a person's decision; no agent decision improves it.
2. **Unblock #13.** Reason: it holds the most severe defect in the backlog — a live money defect
   reachable today, on `main` — and it is parked behind a label that does not apply to it. It has
   now been blocked across three consecutive surveys while remaining the top item on this list.
   Details below.
3. **Decide what CI runs.** Reason: 22 e2e files run under no check, and a release-notes gate
   with a large test suite is invoked by no workflow. Both are one-line changes in files this
   repository reserves, so they are a CI-minutes decision rather than a ticket — and they are the
   reason nearly every defect in this backlog was found by an agent reading the file rather than
   by a check that ran.

## Blocked, and on whom

- **#13 holds a live money defect, on `main`, blocked for three days.** The fix that widened
  `canCalculateBalance()` to accept an ascending date sort seeds the prepended upcoming rows from
  `balances[transactions[0].id]` (`packages/desktop-client/src/components/accounts/Account.tsx:155`,
  verified in the tree today). The balance window is forced newest-first by `balanceQuery.ts:10`,
  so `transactions[0]` is the *newest* row under a descending sort and the *oldest* under an
  ascending one — whose running balance is its own amount, not the account total. Every upcoming
  scheduled row on an oldest-first-sorted account displays a balance seeded from the wrong base.
  It is the second finding in #13's body and is deliberately **not** re-filed here. #13 says
  `Depends on #2`, which closed two days before #13 was filed, and it has sat behind
  `sdlc:blocked` ever since.
- **Four issues are labelled `sdlc:blocked` and nothing is blocking three of them.** #82 says
  `Depends on #74`, closed at 15:58:07 and #82 filed at 15:58:11. #75 says `Depends on #70`,
  closed at 08:39:09 and #75 filed at 08:39:13. Two four-second races, and the second time the
  same shape has produced one. #13 says `Depends on #2`. #5 carries no `Depends on` at all and
  has been blocked since intake. This is pipeline plumbing under `.sdlc/bin/**`, a forbidden
  path, so it wants a person to look at the wake rather than a ticket.
- **The `[AI]` prefix is now inconsistently applied, which is worse than uniformly missing.**
  `.sdlc/bin/open-pr.mjs:138` still builds every title as `` `fix: ${issueData.title}` `` with no
  prefix, and `.sdlc/bin/**` is reserved. But of the six merges in the last day, two carry the
  prefix and four do not — so the remedy is being applied by hand, sometimes. Nine bare `fix:`
  subjects are on `main`. #75 is the canonical home for the finding and is itself parked behind
  `sdlc:blocked`. Not re-filed here.
- **The e2e suite and the browser build are never executed, and the release-notes gate is never
  invoked.** `verify.build` and `verify.e2e` in `.sdlc/config.yml` are both empty strings
  (lines 171–172), so CI runs typecheck, lint and unit and nothing else; the 22
  `packages/desktop-client/e2e/*.test.ts` files run under no check.
  `.github/actions/release-notes/check/action.yml` exists and nothing under `.github/` references
  it — grepped today, no hits. The cost of the first is demonstrated exactly: reverting the
  one-line fix that shipped the running-balance bug leaves `yarn test` fully green. The cost of
  the second is a chain of five consecutive tickets — #17, #24, #28, #31, #99 — each finding
  new defects in the same two files.
- **One self-fix issue is stopped on a credential.** #36 lists the pipeline's own defects from
  the last 24 hours. Both were **refused and stopped for a person**: the framework's source at
  `Shivam-Fl/automated-ai-sdlc` needs the `SDLC_FRAMEWORK_TOKEN` secret with read access. Until
  that secret exists the pipeline cannot review its own fix for a defect it has already
  diagnosed.
- **Still no spec, and still no Spec coverage issue.** This survey was told to expect one among
  the open issues. There is none, and there never has been — verified against the tree, not
  against the previous roadmap. `spec.paths` names `docs/spec` and `SPEC.md`; neither exists and
  `docs/` does not exist at all. No open issue carries a `Covers:` line. Until a person decides
  what the spec of this fork is, coverage cannot be measured. That is a decision about what the
  product should be, and it is the owner's — worth one conversation, not a ticket.
- **#1 and #5 are re-filed upstream reports**, parked on a person: an app crash on showing
  reconciled transactions after a sort change (#1, upstream #6073) and uncategorized transactions
  missing from split-category reports (#5, upstream #3204).
- **Two Librarian memory PRs are open** — #37 (2026-10-03) and #77 (2026-10-04) — unmerged, and
  neither titled with the prefix.

## Epics

Two open epics. Neither waits on the other, and nothing waits on either, so no `epic_links` are
proposed — a dependency is "this cannot be built yet", and there is no such edge here. #83's work
is report filters and test files; #41's is schedule occurrences and the register. They share no
file an agent would touch.

- **#41** — Follow-ups from #6 (schedule occurrences). In flight, **1 of 4 children closed**.
  #42 closed 2026-10-04 06:38. #43 → PR #71, #44 → PR #62, #45 → PR #54, all three open and all
  three finished. No child declares a dependency on another.
- **#83** — Follow-ups from #4 (custom reports), filed and split 2026-10-04 19:00. In flight,
  **0 of 5 children closed**. #84 and #85 have not started; #86 → PR #102, #87 → PR #96;
  #90 is `sdlc:deferred`. Its first two children are the two genuinely behavioural fixes — the
  Sankey and Budget Analysis filters (#84) and the wildcard bound that stops a report hanging
  (#85) — and neither has a PR. **That is the one place new work is actually wanted this week**,
  and it is the natural continuation of what merged yesterday.

Grandchildren worth noting, because they are *not* declared children and so do not hold either
epic open: **#93**, **#99**, **#98**, **#97**, **#78**, **#82**, **#75**, **#63**, **#38**, **#31**
and **#13** are all follow-up tickets on tickets that were themselves split out of an epic. Eleven
of the twenty-four open issues exist only because a merge happened. That is a property of the
split rather than a defect in it, but it is why the queue is 24 deep while the epic graph holds
nine.

## What this survey did not file, and why

Nothing — the same answer as the two previous surveys. One of the three reasons has changed shape
since yesterday.

- **Every candidate defect found by reading the tree is already an open ticket's finding.** The
  running-balance seed at `Account.tsx:155` is #13's second finding. The un-prefixed title
  generator at `open-pr.mjs:138` is #75's only finding. The report hang from a wildcard-heavy
  filter is #85's, written this week and not yet started. The vacuous e2e console guard under a
  production build is #82's first finding and its seventh. Re-filing any of them would race the
  ticket that already owns it.
- **The umbrella that would cover the rest is reserved paths, not tickets.** Four findings want
  the same things — a person to look at the blocked-label wake, at `open-pr.mjs`, at
  `verify.e2e`/`verify.build`, and at the un-referenced release-notes action. All four live in
  `.sdlc/bin/**`, `.sdlc/config.yml` or `.github/**`. A ticket filed against them could do
  nothing except stop at its plan for a person, which is a worse artefact than this section
  saying it plainly.
- **Better than yesterday, and still zero.** Last survey's reason was that the backlog was
  generating more findings than it retired. It still is — eleven of twenty-four open issues exist
  because of a merge — but the queue is finally draining, which means a filed issue would queue
  behind twelve finished ones rather than behind a frozen pipeline. Two good issues beat ten
  plausible ones; today the honest number is zero, and the two things actually wanted are the
  merge queue and #13, both of which are in **Next** and **Blocked** rather than in a ticket.
