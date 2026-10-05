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

// React phrases one half of the key expression's failure mode as 'Each child in
// a list should have a unique "key" prop.' That sentence is emitted at most ONCE
// per test FILE, not per render: rendering one keyless fixture from three
// separate tests in a single file measured missing=1, missing=0, missing=0.
// Whichever test renders first consumes the file's warning budget, so every
// later test asserting on it passes vacuously however the keys are built.
//
// The budget is a property of the SENTENCE, not of the file. The duplicate-key
// sentence is not deduplicated this way (three renders under
// `key={category.id}` each reported dup=1), and it is a different string, so
// the two have independent budgets. That is why this file, which owns a render
// nothing else contests, asserts BOTH: dropping the duplicate-key half when
// this file was split off left that half asserted nowhere.
const MISSING_KEY_WARNING = /unique .?key.? prop/i;

// The matching tail of 'Encountered two children with the same key, `%s`'.
// Matching only the stable tail catches any wording of that sentence, so a
// reworded prefix cannot quietly turn the assertions below into a vacuous
// pass.
const DUPLICATE_KEY_WARNING = /same key/i;

function missingKeyWarnings(): string[] {
  return consoleErrors().filter(message => MISSING_KEY_WARNING.test(message));
}

function duplicateKeyWarnings(): string[] {
  return consoleErrors().filter(message => DUPLICATE_KEY_WARNING.test(message));
}

describe('ReportTableList missing keys', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Guards the `?? category.id` half of the key expression at
  // ReportTableList.tsx:84. Deleting that fallback leaves every real category
  // row — which has no uncategorizedId — keyed by `undefined`, which React
  // reports with the missing-key sentence. Stringifying the fallback instead
  // leaves the three id-less rows all keyed to `'undefined'`, which React
  // reports with the duplicate-key sentence — so this render asserts both.
  // This test lives in a file alone so the missing-key budget is never
  // contested.
  it('keys real category rows that have no uncategorizedId', () => {
    vi.spyOn(console, 'error');

    render(
      <ReportTableList
        data={dataEntity([
          groupEntity({
            id: 'group-bills',
            name: 'Bills',
            categories: [
              groupEntity({ id: 'uuid-1', name: 'Rent' }),
              groupEntity({ id: 'uuid-2', name: 'Power' }),
            ],
          }),
        ])}
        mode="total"
        groupBy="Category"
        renderRow={renderRow}
      />,
    );

    // Asserting the names matters as much as the warning: on an empty render
    // the warning assertions below pass vacuously.
    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByText('Power')).toBeInTheDocument();
    expect(missingKeyWarnings()).toEqual([]);
    expect(duplicateKeyWarnings()).toEqual([]);
  });
});
