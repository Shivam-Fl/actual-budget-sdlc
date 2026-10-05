import React from 'react';

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReportTableList } from './ReportTableList';
import {
  consoleErrors,
  dataEntity,
  groupEntity,
  renderRow,
} from './ReportTableList.fixtures';

// React phrases the collision 'Encountered two children with the same key,
// `%s`'. Matching only the stable tail catches any wording of that sentence, so
// a reworded prefix cannot quietly turn the assertions below into a vacuous
// pass. The former second entry, the exact sentence
// /Encountered two children with the same key/i, was deleted because every
// string it matches also contains 'same key': it was strictly subsumed and
// could never match something this pattern rejects.
//
// The missing-key sentence is the other half of the key expression's failure
// mode, and this fixture can produce it too — see the note on the test below.
// It gets its own tail-anchored filter, kept deliberately separate from the one
// above so a failure stays attributable to the half that broke.
const DUPLICATE_KEY_WARNING = /same key/i;
const MISSING_KEY_WARNING = /unique .?key.? prop/i;

// The three rows categoryLists() appends to the 'Uncategorized & Off budget'
// group. They deliberately share `id: ''` — the query layer and the filters
// match on that empty id — and are told apart only by uncategorizedId.
const uncategorizedRow = groupEntity({
  id: '',
  name: 'Uncategorized',
  uncategorizedId: 'other',
});
const transferRow = groupEntity({
  id: '',
  name: 'Transfers',
  uncategorizedId: 'transfer',
});
const offBudgetRow = groupEntity({
  id: '',
  name: 'Off budget',
  uncategorizedId: 'off_budget',
});

const uncategorizedGroup = groupEntity({
  id: 'uncategorized',
  name: 'Uncategorized & Off budget',
  uncategorizedId: 'all',
  categories: [
    groupEntity({ id: 'uuid-1', name: 'Rent' }),
    uncategorizedRow,
    transferRow,
    offBudgetRow,
  ],
});

function duplicateKeyWarnings(): string[] {
  return consoleErrors().filter(message => DUPLICATE_KEY_WARNING.test(message));
}

function missingKeyWarnings(): string[] {
  return consoleErrors().filter(message => MISSING_KEY_WARNING.test(message));
}

describe('ReportTableList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Two shapes share this one render.
  //
  // The three id:'' rows are what categoryLists() actually builds: they are
  // their own top-level group, with no real category beside them (see
  // ReportOptions.ts, where uncategorizedGroup.categories is hardcoded to
  // exactly those three). They collide on `id` under key={category.id}, which
  // is the `category.uncategorizedId` half of the key expression this guards.
  //
  // The uuid-1 row is deliberately adversarial, and is NOT a production shape.
  // It is here to prove the expression stays collision-free when a real uuid
  // sits alongside distinct uncategorizedIds, and — because it has no
  // uncategorizedId — it makes this fixture capable of the missing-key
  // sentence too. A fixture that can produce a sentence must assert it, which
  // is why the missing-key filter is checked here as well as in
  // ReportTableList.missingKey.test.tsx. That file's render spends the
  // once-per-file missing-key budget on its own fixture; this one never
  // contests it.
  it('renders synthetic and real sibling rows without logging a key error', () => {
    vi.spyOn(console, 'error');

    render(
      <ReportTableList
        data={dataEntity([uncategorizedGroup])}
        mode="total"
        groupBy="Category"
        renderRow={renderRow}
      />,
    );

    // Asserting the names matters as much as the warnings: on an empty render
    // the assertions below pass vacuously.
    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
    expect(screen.getByText('Transfers')).toBeInTheDocument();
    expect(screen.getByText('Off budget')).toBeInTheDocument();
    expect(duplicateKeyWarnings()).toEqual([]);
    expect(missingKeyWarnings()).toEqual([]);
  });
});
