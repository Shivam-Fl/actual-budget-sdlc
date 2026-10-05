# A split's parent keeps the row's stamps; its children get none

## Symptom

A scheduled transaction's occurrence could be posted **twice**, but only after the user
split its posted transaction in the account register. The Schedules page showed the
occurrence as paid while posting it again created a second, un-split transaction with
the same payee, date and amount. Nothing about splitting a transaction should change
whether a schedule occurrence counts as paid.

## Cause

Two facts that each look harmless on their own:

1. `splitTransaction` turns the original row into the split **parent** and leaves
   `schedule` and `schedule_occurrence` on it. `makeChild`
   (`shared/transactions.ts`) copies `amount`, `category`, `payee`, `account`, `date`,
   `cleared`, `reconciled`, `sort_order` — and **neither** `schedule` nor
   `schedule_occurrence`. So the parent is the *only* row carrying the stamp.
2. An AQL query on `transactions` defaults to `options.splits: 'inline'`, and
   `execTransactionsBasic` appends `is_parent = 0` for any `splits` value that is not
   `'all'` (`server/aql/schema/executors.ts`). **The default row set excludes split
   parents.**

So the "has this occurrence already been posted?" guard read the default row set, found
nothing once the transaction had been split, and concluded the occurrence was unpaid.

## How it was found

A test helper reused across the suite, `getTransactionDates`, queries with the default
`'inline'` splits and reports **zero rows for a split parent**. Reusing it in a new test
against the fixed code made a correct implementation look broken. The assertions had to
be rewritten against `q('transactions').options({ splits: 'all' })`, or against
`db.all(...)` on `v_transactions_internal` — which is also the only place the stamp's
fate across a split is directly observable, since the AQL row set hides the parent.

## How to check for it quickly

Any new query that asks "is this schedule occurrence paid?" must pass
`.options({ splits: 'all' })`. The two queries that answer the same question for
*display* — `getHasTransactionsQuery` and `getPostedScheduleTransactionsQuery` in
`shared/schedules.ts` — already do. **If a new guard disagrees with what the Schedules
page shows, this mismatch is the first thing to check**: the guard and the status
queries must agree on whether an occurrence is posted.

This cannot over-block: children never carry the stamp, so widening the filter to
`'all'` matches no row the narrower one did not. The fix was `+14/-0` in
`server/schedules/app.ts` — one option, no logic change.

## The general shape

Any code that stamps a row with identifying metadata (a schedule link, an import id, a
recurring-transaction marker) and then queries for it by that metadata has the same
exposure: **the stamp survives on whichever row the operation turns into a parent, and
the default AQL row set cannot see parents.** Ask what the operation does to the stamped
row before trusting a query that filters on the stamp.