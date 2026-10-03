# Roadmap

Survey of 2026-10-03, rebuilt from `maintainer/issues.json`, `maintainer/pulls.json` and
`maintainer/closed.json`. Twelve open issues, four open PRs, eight issues closed since the last
survey on 2026-10-02. Everything below is what those files say today, not what the previous
roadmap said.

## Shipped

Six capabilities landed since the last survey, all of them user-visible:

- The running balance column, and the toggle that shows it, stays available when an account's
  transactions are sorted oldest-first rather than newest-first.
- A weekly custom report covers its whole final week instead of only its first day.
- Posting a scheduled transaction early no longer removes the schedule. Occurrences are now
  recorded rather than inferred from dates.
- A rule or filter whose "matches" value is typed as an incomplete regular expression no longer
  crashes the app. The bad pattern is reported once in the diagnostic rather than once per row,
  and the guard's dedupe is scoped to the database handle rather than the module.
- The release-notes gate rejects `authors:` entries that are not people — the bare agent name
  that shipped in two of this pipeline's own notes is caught now, and both notes are fixed.
- The release-notes gate reports a deleted `README.md` as a gate error instead of dying with an
  uncaught `ENOENT`, and it reads diff paths verbatim rather than through a tab-separated parse.

## In flight

- **#31 → PR #32** (`sdlc/issue-31`, open, `sdlc:qa`). Follow-ups from #28 — five review findings
  and four QA findings, all on the release-notes gate. Four of them are the same unguarded-I/O
  defect class on four different call sites, and one is a re-report of a defect another reviewer
  had already filed on the same PR. This is the ticket that will produce the next round if it is
  not given the harness (see Next 1).
- **#22 → PR #26** (`sdlc/issue-22`, open). Reports dashboard loads without React's nested-button
  warning. Labelled `sdlc:budget-exceeded` with a PR open — budget gone, work not merged.
- **#4 → PR #9** (`sdlc/issue-4`, open). Custom report "show empty rows" ignores unchecked
  categories. Also `sdlc:budget-exceeded` with a PR open, and open for 25 hours — the longest
  stalled item in the backlog.
- **#6 → PR #15** (`sdlc/issue-6`, open). Posting any upcoming transaction for a schedule posts
  the *first* one instead of the one picked.
- **#25** (`sdlc:implementing`, no PR yet). Follow-ups from #7 — four review findings.
- **#29** (`sdlc:planning`). Follow-ups from #24 — six review findings, being planned as **one**
  work order. See Next 2 for why that is the wrong shape.
- **#20 and #21** — children of epic #14, split 2026-10-02 20:22, **no label and no PR ten hours
  later**. #20 (weekly report header vs. the range its buckets cover) is the only piece in the
  whole backlog that touches money, and it is the one that has not been picked up.
- **#1** parked for a human (`sdlc:needs-human`) since 2026-10-02.

Two of the four stalled items share one shape: `sdlc:budget-exceeded` with an open PR. The budget
was spent producing the diff; nothing is left to review or merge it. That is a decision about
budget, not a failure to work.

## Next

1. **Give the release-notes gate an end-to-end test** (filed this survey). Reason: four
   consecutive tickets — #17, #24, #28, #31 — have each found a new instance of one defect shape
   in a single 143-line file that has no test at all, and #31 found four instances at once. This
   is the recurrence rule firing: the same bug shape four times is one missing test, not four
   bugs. It is also the cheapest thing on this list — the file is already covered by a package
   that has vitest, a glob, and a neighbouring test file; what is missing is that the gate runs
   as a process and none of its findings are reachable from a unit test of its helpers.
2. **Unblock #13** — see Blocked. Reason: it holds a live money defect that is reachable today,
   and it is the only such thing in the backlog.
3. **Split #13, #25 and #29 before any of them is planned**, the same call the previous survey
   made about #13 and #14 and that #14 has since honoured. Reason: each is one ticket carrying
   four to nine findings that share no files and no fix, and each says so in its own body. #29
   is in planning now and is the one that will be planned badly. This is not filed as an issue:
   it is the pipeline's own batching behaviour, and the fix is a human deciding whether these
   should be split at filing time rather than after review.

## Blocked, and on whom

- **#13 and #5 are labelled `sdlc:blocked` and nothing is blocking either.** #13 says
  `Depends on #2`; #2 closed four seconds before #13 was filed. #5 carries no `Depends on` at
  all — it was filed at intake and has been blocked since. The previous survey saw the same on
  #13 and #16; #16 recovered and was worked, #13 did not. This is pipeline plumbing rather than
  repository work, so it is not a ticket here. It wants a human to look at why the wake reaches
  some of these and not others.
- **#13 holds a live money defect and is one of the two blocked tickets.** The #2 fix widened
  `canCalculateBalance()` to accept an ascending date sort, but `runningBalance` still seeds
  prepended scheduled rows from `balances[transactions[0].id]` (`Account.tsx:154`), and under an
  ascending sort `transactions[0]` is the *oldest* row, whose balance is its own amount rather
  than the account total. Every upcoming scheduled row on an account sorted oldest-first displays
  a balance seeded from the wrong base. The code is in that state today — read it, do not take
  this paragraph's word for it. It is written up as the second finding in #13's body; it is not
  re-filed here, because a duplicate ticket racing the original helps nobody. It is called out
  because it is the most severe thing in the backlog and it is sitting behind a label nothing
  justifies.
- **The e2e suite is never executed.** `packages/desktop-client/vite.config.mts` collects
  `src/**/*.{test,spec}.*` only, and `verify.e2e` in `.sdlc/config.yml` is empty, so the 22
  `packages/desktop-client/e2e/*.test.ts` files run under no check in this repository. The review
  of #2 demonstrated the cost exactly: reverting the one-line fix leaves `yarn test` green.
  `.sdlc/config.yml` is a reserved path, so enabling it is a human's call, and it is a real
  CI-minutes decision rather than a one-line change.
- **There is still no spec, and therefore still no Spec coverage issue.** `spec.paths` names
  `docs/spec` and `SPEC.md`; neither exists on this branch. No issue in `maintainer/issues.json`
  carries a `Covers:` line and no issue is a coverage table — not deferred, never created,
  because there are no sections to enumerate. Until a person decides what the spec of this fork
  is, coverage cannot be measured. Worth one conversation, not a ticket: writing a spec is a
  decision about what the product should be, and that is the owner's.
- **Every open PR violates the `[AI]` title rule.** PRs #9, #15, #26 and #32 are all titled
  `fix: …`. `.github/agents/pr-and-commit-rules.md` requires the prefix on every PR title and is
  loaded into every agent's context through `CLAUDE.md`. It has now been flagged as a review
  finding twice — on PR #12 in #14's body and on PR #30 in #31's — and it has been violated on
  every PR since. Not filed: the only places to fix it (`.github/**`, `.sdlc/bin/**`) are
  reserved paths, so a ticket could do nothing but stop at its plan. It is a human's rename.
- **#1** is parked on a person, not on work (`sdlc:needs-human`).

## Epics

One open epic. No epic waits on another, and nothing waits on an epic.

```
- #14  Follow-ups from #3  — split into #20, #21, #22; 0 of 3 closed
                             #22 has a PR open (budget-exceeded);
                             #20 and #21 have never been picked up
```

#14 is the only issue in `maintainer/issues.json` labelled `sdlc:epic`. Its three children are
independent and none is `Depends on` another, so nothing here is waiting. #14 will close when its
children do — which today means when #20 and #21 are worked at all. No `epic_links` are proposed:
with one open epic there is no edge to draw.

The epic-shaped body of work that is *not* written down: the follow-up mega-tickets (#13, #25,
#29, #31) each carry four to nine findings across unrelated files, and only #14 was ever split.
That is a pipeline-behaviour gap rather than an epic, and it is Next 3's subject, not something to
open an epic for.