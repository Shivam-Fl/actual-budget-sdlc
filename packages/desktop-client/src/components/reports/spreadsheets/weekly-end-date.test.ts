import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import type {
  CategoryEntity,
  CategoryGroupEntity,
} from '@actual-app/core/types/models';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCustomSpreadsheet } from './custom-spreadsheet';
import { createGroupedSpreadsheet } from './grouped-spreadsheet';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

type CustomData = Parameters<
  Parameters<ReturnType<typeof createCustomSpreadsheet>>[1]
>[0];
type GroupedData = Parameters<
  Parameters<ReturnType<typeof createGroupedSpreadsheet>>[1]
>[0];

const categoryGroups = [
  { id: 'group-food', name: 'Food', is_income: false, sort_order: 0 },
] satisfies CategoryGroupEntity[];

const categories = [
  { id: 'cat-groceries', name: 'Groceries', group: 'group-food' },
] satisfies CategoryEntity[];

/** A single day of spending inside the final week, keyed by day. */
const weeklyRows = [
  { date: '2026-08-31', amount: 10 },
  { date: '2026-09-07', amount: 20 },
  { date: '2026-09-14', amount: 30 },
  { date: '2026-09-21', amount: 40 },
  { date: '2026-09-28', amount: 50 },
  { date: '2026-09-29', amount: 60 },
  { date: '2026-09-30', amount: 70 },
  { date: '2026-10-01', amount: 80 },
  { date: '2026-10-02', amount: 90 },
  { date: '2026-10-05', amount: 100 },
];

/**
 * `monthUtils.currentDay()` is hardcoded under the test setup (it short-circuits
 * on `global.IS_TESTING`), so the clamp cannot be moved with fake timers — the
 * module function itself has to be replaced.
 */
function pinToday(today: string) {
  vi.spyOn(monthUtils, 'currentDay').mockReturnValue(today);
}

/**
 * Stand up a server that honours the query's own date bounds, the way the real
 * AQL layer does, and record the end bound each query was given. A mock that
 * ignored the filter would return every row and make the bucket totals
 * independent of the bound, which is the thing under test.
 */
function getQueryEndDates(): string[] {
  const endDates: string[] = [];
  initServer({
    'make-filters-from-conditions': async () => ({ filters: [] }),
    query: async query => {
      let lower: string | undefined;
      let upper: string | undefined;
      // The conditions filter is also an `$and`, so match on the one that
      // actually carries the date range.
      for (const expression of query.filterExpressions) {
        const clauses = (expression as { $and?: unknown[] }).$and;
        if (!Array.isArray(clauses)) {
          continue;
        }
        for (const clause of clauses) {
          const date = (clause as { date?: Record<string, string> }).date;
          if (date?.$lte) {
            upper = date.$lte;
            endDates.push(date.$lte);
          }
          if (date?.$gte) {
            lower = date.$gte;
          }
        }
      }
      const data = weeklyRows.filter(
        row =>
          (lower === undefined || row.date >= lower) &&
          (upper === undefined || row.date <= upper),
      );
      return { data, dependencies: [] };
    },
  });
  return endDates;
}

async function runCustom({
  startDate = '2026-08-30',
  endDate,
  interval = 'Weekly',
  firstDayOfWeekIdx = '0',
}: {
  startDate?: string;
  endDate: string;
  interval?: string;
  firstDayOfWeekIdx?: '0' | '1';
}): Promise<{ data: CustomData; queryEndDates: string[] }> {
  const queryEndDates = getQueryEndDates();

  const spreadsheet = createCustomSpreadsheet({
    startDate,
    endDate,
    interval,
    categories: { list: categories, grouped: categoryGroups },
    conditions: [],
    conditionsOp: 'and',
    showEmpty: true,
    showOffBudget: true,
    showHiddenCategories: true,
    showUncategorized: true,
    trimIntervals: false,
    groupBy: 'Category',
    firstDayOfWeekIdx,
  });

  let data: CustomData | undefined;
  await spreadsheet(undefined as never, result => {
    data = result;
  });

  if (!data) {
    throw new Error('Spreadsheet did not produce report data');
  }
  return { data, queryEndDates };
}

async function runGrouped({
  startDate = '2026-08-30',
  endDate,
  interval = 'Weekly',
  firstDayOfWeekIdx = '0',
}: {
  startDate?: string;
  endDate: string;
  interval?: string;
  firstDayOfWeekIdx?: '0' | '1';
}): Promise<GroupedData> {
  getQueryEndDates();

  const spreadsheet = createGroupedSpreadsheet({
    startDate,
    endDate,
    interval,
    categories: { list: categories, grouped: categoryGroups },
    conditions: [],
    conditionsOp: 'and',
    showEmpty: true,
    showOffBudget: true,
    showHiddenCategories: true,
    showUncategorized: true,
    trimIntervals: false,
    firstDayOfWeekIdx,
  });

  let data: GroupedData | undefined;
  await spreadsheet(undefined as never, result => {
    data = result;
  });

  return data ?? [];
}

afterEach(async () => {
  vi.restoreAllMocks();
  await clearServer();
});

describe('weekly custom report end bound', () => {
  it('covers the whole final week once that week has elapsed', async () => {
    pinToday('2026-10-05');

    const { data, queryEndDates } = await runCustom({
      endDate: '2026-10-03',
    });

    // 2026-10-03 is a Saturday, so it is already the week's true end.
    expect(queryEndDates).toEqual(['2026-10-03', '2026-10-03']);
    expect(
      data.intervalData[data.intervalData.length - 1].intervalEndDate,
    ).toBe('2026-10-03');
  });

  it('widens a week-start end date to the week it labels', async () => {
    pinToday('2026-10-05');

    const { data, queryEndDates } = await runCustom({
      endDate: '2026-09-27',
    });

    expect(queryEndDates).toEqual(['2026-10-03', '2026-10-03']);
    expect(
      data.intervalData[data.intervalData.length - 1].intervalEndDate,
    ).toBe('2026-10-03');
  });

  it('clamps to today while the final week is still in progress', async () => {
    pinToday('2026-10-02');

    const { data, queryEndDates } = await runCustom({
      endDate: '2026-09-27',
    });

    expect(queryEndDates).toEqual(['2026-10-02', '2026-10-02']);
    expect(
      data.intervalData[data.intervalData.length - 1].intervalEndDate,
    ).toBe('2026-10-02');
  });

  it('does not report the final week beyond the days that have happened', async () => {
    pinToday('2026-10-02');

    const { data } = await runCustom({ endDate: '2026-09-27' });
    const lastBucket = data.intervalData[data.intervalData.length - 1];

    // 50 + 60 + 70 + 80 + 90 — 10/03 has not happened yet, so its 100 is absent.
    expect(lastBucket.totalAssets).toBe(350);
  });

  it('leaves the non-final buckets on their existing day-before-next rule', async () => {
    pinToday('2026-10-05');

    const { data } = await runCustom({ endDate: '2026-10-03' });

    expect(
      data.intervalData.map(bucket => [
        bucket.intervalStartDate,
        bucket.intervalEndDate,
      ]),
    ).toEqual([
      ['2026-08-30', '2026-09-05'],
      ['2026-09-06', '2026-09-12'],
      ['2026-09-13', '2026-09-19'],
      ['2026-09-20', '2026-09-26'],
      ['2026-09-27', '2026-10-03'],
    ]);
  });

  it('honours a Monday first day of week rather than assuming Sunday', async () => {
    pinToday('2026-10-05');

    const { data, queryEndDates } = await runCustom({
      startDate: '2026-09-28',
      endDate: '2026-09-28',
      firstDayOfWeekIdx: '1',
    });

    expect(queryEndDates).toEqual(['2026-10-04', '2026-10-04']);
    expect(
      data.intervalData[data.intervalData.length - 1].intervalEndDate,
    ).toBe('2026-10-04');
  });

  it('leaves Daily and Monthly on their existing end bounds', async () => {
    pinToday('2026-10-05');

    const daily = await runCustom({
      startDate: '2026-09-27',
      endDate: '2026-09-29',
      interval: 'Daily',
    });
    expect(daily.queryEndDates).toEqual(['2026-09-29', '2026-09-29']);
    expect(
      daily.data.intervalData[daily.data.intervalData.length - 1]
        .intervalEndDate,
    ).toBe('2026-09-29');

    const monthly = await runCustom({
      startDate: '2026-08-01',
      endDate: '2026-09-30',
      interval: 'Monthly',
    });
    expect(monthly.queryEndDates).toEqual(['2026-09-30', '2026-09-30']);
    expect(
      monthly.data.intervalData[monthly.data.intervalData.length - 1]
        .intervalEndDate,
    ).toBe('2026-09-30');
  });
});

describe('weekly grouped report end bound', () => {
  it('applies the same bound as the custom spreadsheet', async () => {
    pinToday('2026-10-05');

    const custom = await runCustom({ endDate: '2026-10-03' });
    const grouped = await runGrouped({ endDate: '2026-10-03' });

    const customLast =
      custom.data.intervalData[custom.data.intervalData.length - 1];
    const group = grouped.find(g => g.categories?.length);
    const groupedLast = group!.intervalData[group!.intervalData.length - 1];

    expect(groupedLast.intervalEndDate).toBe(customLast.intervalEndDate);
    expect(groupedLast.intervalEndDate).toBe('2026-10-03');
  });

  it('clamps to today the same way the custom spreadsheet does', async () => {
    pinToday('2026-10-02');

    const custom = await runCustom({ endDate: '2026-09-27' });
    const grouped = await runGrouped({ endDate: '2026-09-27' });

    const customLast =
      custom.data.intervalData[custom.data.intervalData.length - 1];
    const group = grouped.find(g => g.categories?.length);
    const groupedLast = group!.intervalData[group!.intervalData.length - 1];

    expect(groupedLast.intervalEndDate).toBe(customLast.intervalEndDate);
    expect(groupedLast.intervalEndDate).toBe('2026-10-02');
  });

  it('widens a week-start end date in the table view too', async () => {
    pinToday('2026-10-05');

    const custom = await runCustom({ endDate: '2026-09-27' });
    const grouped = await runGrouped({ endDate: '2026-09-27' });

    const customLast =
      custom.data.intervalData[custom.data.intervalData.length - 1];
    const group = grouped.find(g => g.categories?.length);
    const groupedLast = group!.intervalData[group!.intervalData.length - 1];

    expect(groupedLast.intervalEndDate).toBe(customLast.intervalEndDate);
    expect(groupedLast.intervalEndDate).toBe('2026-10-03');
  });
});
