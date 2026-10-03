# AQL: an object inside `$or` is joined with OR, not AND

**Symptom.** An AQL filter matches far more rows than intended — typically *every* row sharing one
field, where you meant "rows matching all of these". In `getHasTransactionsQuery` the bug made
every schedule occurrence look permanently paid.

**Cause.** `compileConditions` (`packages/loot-core/src/server/aql/compiler.ts`) flattens an object
form `{a: 1, b: 2}` into `[{a: 1}, {b: 2}]`, and `compileOr` joins the compiled results with `OR`.
So a branch written as an object contributes its fields as *sibling* alternatives:

```js
{ $or: [ { schedule_occurrence: d }, { schedule_occurrence: null, date: {...} } ] }
//  -> schedule_occurrence = d OR schedule_occurrence IS NULL OR date >= ...
```

The second branch's two fields are no longer conjunctive.

**The fix.** Use the `$and` **array** form to nest a conjunction inside a disjunction — one array
element per branch, each branch holding exactly one key:

```js
{ $or: [ { schedule_occurrence: d }, { $and: [ { schedule_occurrence: null }, { date: {...} } ] } ] }
//  -> (schedule_occurrence = d) OR (schedule_occurrence IS NULL AND date >= ...)
```

**How to check quickly.** Read the branch, not the whole query: if any single element of an `$or`
array is an object literal with more than one key, it is already wrong. The same trap applies to
every `$or`, `$and` and top-level `filter()` — `compileWhere` joins with `AND`, so a bare object
`filter({a: 1, b: 2})` *is* an `AND`, and only the operator arrays re-join with `OR`.

**Second, quieter trap in the same file.** An empty `$or` does not compile to "match nothing". At
top level an empty filter omits the `WHERE` clause entirely — `compileWhere` returns `null` — so
`getHasTransactionsQuery([])` becomes `SELECT … FROM transactions` with no constraint and scans the
whole budget to answer a question about zero schedules. That one is guarded explicitly with
`.filter({ id: null })`; keep the guard if you touch the function.