import React from 'react';

import type { DataEntity, GroupedEntity } from '@actual-app/core/types/models';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { renderRowProps } from './ReportTable';
import { ReportTableList } from './ReportTableList';

// React phrases the other half of the key expression's failure mode as
// 'Each child in a list should have a unique "key" prop.' That sentence is
// emitted at most ONCE per test FILE, not per render: rendering one keyless
// fixture from three separate tests in a single file measured missing=1,
// missing=0, missing=0. Whichever test renders first consumes the file's
// warning budget, so every later test asserting on it passes vacuously however
// the keys are built. The duplicate-key sentence is not deduplicated this way
// (three renders under `key={category.id}` each reported dup=1), which is why
// the two collision tests can share ReportTableList.test.tsx while this guard
// owns a file of its own.
const MISSING_KEY_WARNING = /unique .?key.? prop/i;

function groupEntity(entity: Partial<GroupedEntity>): GroupedEntity {
  return {
    id: '',
    name: '',
    intervalData: [],
    totalAssets: 0,
    totalDebts: 0,
    totalTotals: 0,
    netAssets: 0,
    netDebts: 0,
    totalBudgeted: 0,
    ...entity,
  };
}

function dataEntity(groupedData: GroupedEntity[]): DataEntity {
  return {
    intervalData: [],
    groupedData,
    totalAssets: 0,
    totalDebts: 0,
    totalTotals: 0,
    netAssets: 0,
    netDebts: 0,
    totalBudgeted: 0,
  };
}

function renderRow({ item }: renderRowProps) {
  return <div>{item.name}</div>;
}

function missingKeyWarnings(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map(args => args.map(String).join(' '))
    .filter(message => MISSING_KEY_WARNING.test(message));
}

describe('ReportTableList missing keys', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Guards the `?? category.id` half of the key expression at
  // ReportTableList.tsx:84. Deleting that fallback leaves every real category
  // row — which has no uncategorizedId — keyed by `undefined`, which React
  // reports with the missing-key sentence rather than the duplicate-key one.
  // This test lives in a file alone so that sentence's once-per-file budget is
  // never contested.
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
    // the warning assertion below passes vacuously.
    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByText('Power')).toBeInTheDocument();
    expect(missingKeyWarnings()).toEqual([]);
  });
});
