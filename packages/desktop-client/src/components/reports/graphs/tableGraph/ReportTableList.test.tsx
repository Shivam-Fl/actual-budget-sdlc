import React from 'react';

import type { DataEntity, GroupedEntity } from '@actual-app/core/types/models';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { renderRowProps } from './ReportTable';
import { ReportTableList } from './ReportTableList';

// React 19.2.7 phrases the collision 'Encountered two children with the same
// key, `%s`'. Match the stable part of it too, so a reworded prefix does not
// quietly turn this into a vacuous pass.
const DUPLICATE_KEY_WARNINGS = [
  /same key/i,
  /Encountered two children with the same key/i,
];

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
    .filter(message =>
      DUPLICATE_KEY_WARNINGS.some(pattern => pattern.test(message)),
    );
}

describe('ReportTableList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('gives the three synthetic rows three distinct keys', () => {
    vi.spyOn(console, 'error');
    const renderRowSpy = vi.fn(renderRow);

    render(
      <ReportTableList
        data={dataEntity([uncategorizedGroup])}
        mode="total"
        groupBy="Category"
        renderRow={renderRowSpy}
      />,
    );

    // React keeps a key internal to its reconciler, so the keys themselves are
    // not reachable from the rendered output. What is observable is the input
    // the key is derived from — three distinct uncategorizedIds, one per row —
    // together with the absence of the warning in the case above, which is
    // React's own report that those keys collided. Reverting the key back to
    // `category.id` fails that case.
    const syntheticRows = renderRowSpy.mock.calls
      .map(([props]) => props.item)
      .filter(item => item.uncategorizedId !== 'all');

    expect(syntheticRows.map(item => item.uncategorizedId)).toEqual([
      'other',
      'transfer',
      'off_budget',
    ]);
    expect(new Set(syntheticRows.map(item => item.uncategorizedId)).size).toBe(
      3,
    );
    expect(duplicateKeyWarnings()).toEqual([]);
  });

  it('keys real category rows by their uuid', () => {
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

    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByText('Power')).toBeInTheDocument();
    expect(duplicateKeyWarnings()).toEqual([]);
  });

  it('does not collide when a real category and a synthetic row are siblings', () => {
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
    expect(duplicateKeyWarnings()).toEqual([]);
  });
});
