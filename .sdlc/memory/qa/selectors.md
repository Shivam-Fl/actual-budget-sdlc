# Stable selectors

Prefer a selector listed here over anything derived from text or DOM position: copy
edits change text and layout changes positions, and both produce failures that waste an
attempt.

**Check `packages/desktop-client/e2e/page-models/` before writing a selector by hand.**
Schedules already has `schedules-page.ts` and `schedule-edit-modal.ts`; they encode the
non-obvious waits (menu render, combobox settle) that a raw selector gets wrong.

| Element | Selector |
|---|---|
| Schedules table rows | `getByTestId('table').getByTestId('row')` |
| Schedules row cell (payee, account, date, status, amount) | `row.getByTestId('<name>')` |
| Schedules row actions menu trigger | `row.getByTestId('actions').getByRole('button')` |
| Any action menu once open | `page.getByRole('menu')` |
| Schedule edit modal root | `getByTestId('schedule-edit-modal')` |
| Schedule modal combobox (payee, account) | `getByRole('combobox')` inside the modal |
| Add-new-schedule button | `getByRole('button', { name: 'Add new schedule' })` |
| Command bar input | `getByRole('combobox', { name: 'Command Bar' })` |

`data-testid` on a table cell is set from the `<Field name="...">` prop
(`components/table.tsx`), so the cell testid and the field name are the same string —
`name="payee"` renders `data-testid="payee"`. That is why the cell testids above are
lowercase field names rather than invented strings.

## Menus: read items, don't click them by guessed name

`SchedulesPage.nthScheduleMenuHasItem(row, name)` and `nthScheduleMenuItemNames(row)`
open the menu, read it, and press Escape. Use them to assert **whether an item is
offered** rather than reaching for a locator and waiting on it — an absent menu item
never becomes visible, so a click-based check times out instead of answering the
question. This is how the Skip/Complete visibility rules are checked across the four
menus that can offer them.

Both helpers accept a `Locator` as well as a row index, so a row already located by payee
does not have to be converted back to an index. The returned menu locator is lazy and
`count()` / `allTextContents()` do not retry — the wait for the menu to render lives
inside `_openNthScheduleMenu`, which is why callers must go through it.