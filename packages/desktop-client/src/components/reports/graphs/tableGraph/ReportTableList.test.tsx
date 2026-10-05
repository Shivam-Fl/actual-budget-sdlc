import React from 'react';

import type { DataEntity, GroupedEntity } from '@actual-app/core/types/models';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { renderRowProps } from './ReportTable';
import { ReportTableList } from './ReportTableList';

// React phrases the collision 'Encountered two children with the same key,
// `%s`'. Matching only the stable tail catches any wording of that sentence, so
// a reworded prefix cannot quietly turn the assertions below into a vacuous
// pass. The former second entry, the exact sentence
// /Encountered two children with the same key/i, was deleted because every
// string it matches also contains 'same key': it was strictly subsumed and
// could never match something this pattern rejects.
//
// This file guards the COLLISION half of
// `key={category.uncategorizedId ?? category.id}` only. React emits the
// missing-key sentence at most once per test FILE, so it cannot be asserted
// from two tests here without one of them going silently vacuous whichever
// way the tests are ordered. ReportTableList.missingKey.test.tsx owns that half
// in a file of its own.
const DUPLICATE_KEY_WARNING = /same key/i;

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
  categories: [uncategorizedRow, transferRow, offBudgetRow],
});

function renderRow({ item }: renderRowProps) {
  return <div>{item.name}</div>;
}

function duplicateKeyWarnings(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map(args => args.map(String).join(' '))
    .filter(message => DUPLICATE_KEY_WARNING.test(message));
}

describe('ReportTableList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Guards the `category.uncategorizedId` half of the key expression: the
  // three synthetic rows all share `id: ''`, so `key={category.id}` keys all
  // three to the same value and React reports the collision.
  it('renders the three synthetic rows without logging a duplicate-key error', () => {
    vi.spyOn(console, 'error');

    render(
      <ReportTableList
        data={dataEntity([uncategorizedGroup])}
        mode="total"
        groupBy="Category"
        renderRow={renderRow}
      />,
    );

    // Asserting the names matters as much as the warning: on an empty render
    // the warning assertion below passes vacuously.
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
    expect(screen.getByText('Transfers')).toBeInTheDocument();
    expect(screen.getByText('Off budget')).toBeInTheDocument();
    expect(duplicateKeyWarnings()).toEqual([]);
  });

  // Guards the shape where a real category shares one parent with synthetic
  // rows. The second synthetic sibling is what gives this test discriminating
  // power: with only one, no key expression makes it fail, because a lone
  // `id: ''` row cannot collide with anything. It is killed by
  // `key={category.id}`, where the two synthetic rows collide on the empty id.
  // It is deliberately NOT credited with detecting a deleted `?? category.id`
  // fallback — that produces React's missing-key sentence, which is a
  // once-per-file event owned by ReportTableList.missingKey.test.tsx.
  it('logs no duplicate-key error when real categories and synthetic rows are siblings', () => {
    vi.spyOn(console, 'error');

    render(
      <ReportTableList
        data={dataEntity([
          groupEntity({
            id: 'group-bills',
            name: 'Bills',
            categories: [
              groupEntity({ id: 'uuid-1', name: 'Rent' }),
              uncategorizedRow,
              transferRow,
            ],
          }),
        ])}
        mode="total"
        groupBy="Category"
        renderRow={renderRow}
      />,
    );

    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
    expect(screen.getByText('Transfers')).toBeInTheDocument();
    expect(duplicateKeyWarnings()).toEqual([]);
  });
});
