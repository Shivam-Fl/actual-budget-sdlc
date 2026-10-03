# Stable selectors

Prefer a selector listed here over anything derived from text or DOM position. Copy edits change
text and layout changes positions, and both produce failures that waste an attempt.

Every row below was read out of the source on 2026-10-03. If one stops matching, delete it rather
than fixing the test around it.

| Element | Selector | Where it comes from |
|---|---|---|
| Transaction table body | `[data-testid="transaction-table"]` | `TransactionsTable.tsx` |
| Transaction table header row | `[data-testid="transaction-table-header"]` | `TransactionsTable.tsx` |
| One header cell | `getByTestId('transaction-table-header').getByTestId(<columnId>)` | `CustomCell` sets `data-testid={name}` and every cell passes the column id as `name` — header and body cells share it |
| Any modal | `[data-testid="<modalName>-modal"]` | `components/common/Modal.tsx` derives it from the modal's `name`, so it is never hand-written per modal. `'transaction-table-columns'` → `transaction-table-columns-modal` |
| Column visibility toggle | `#toggle-column-<columnId>` for `isChecked()`, `label[for="toggle-column-<columnId>"]` for `click()` and `toBeVisible()` | `TransactionTableColumnListItem.tsx` |
| Row action cell button | `button, div[data-testid=cell-button]` | `table.tsx` |

## Two traps behind those rows

**The header cell wrapper is not clickable.** `HeaderCell` puts `onClick` on a `Button` nested
inside the cell, so clicking the cell itself does nothing and the test hangs or silently fails on
the next assertion. Always `.locator('button').click()` inside the cell. `AccountPage.sortByColumn`
already does this; reuse it rather than clicking cells.

**The column toggle's `<input>` is `visibility: hidden`,** not `display: none`
(`component-library/src/Toggle.tsx`). It is still in the DOM, so `isChecked()` and `toHaveCount()`
work, but `toBeVisible()` and `.check()` do not. Assert and click the `label[for=...]` instead.

## What is *not* a stable selector here

The account search box has no test id and is found by `getByPlaceholder(/^Search/)`, which is
translated copy (`accounts/Header.tsx`, `placeholder={t('Search')}`). It works in the default locale
and is what the existing e2e uses, but it breaks on a copy edit or a locale change. If you need the
search box in a new test, add a `data-testid` to it first and record the row here.