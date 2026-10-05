import React from 'react';

import type { DataEntity, GroupedEntity } from '@actual-app/core/types/models';
import { vi } from 'vitest';

import type { renderRowProps } from './ReportTable';

// Scaffolding shared by ReportTableList.test.tsx and
// ReportTableList.missingKey.test.tsx. Those two files stay separate on
// purpose — see their header comments for why the split is load-bearing — so
// only the boilerplate lives here, never the warning patterns: which React
// sentence a file owns is exactly what the split is about.

export function groupEntity(entity: Partial<GroupedEntity>): GroupedEntity {
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

export function dataEntity(groupedData: GroupedEntity[]): DataEntity {
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

export function renderRow({ item }: renderRowProps) {
  return <div>{item.name}</div>;
}

// The raw console.error read, deliberately unfiltered: each test file applies
// its own sentence patterns over it so a filter can never subsume another.
export function consoleErrors(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map(args => args.map(String).join(' '));
}
