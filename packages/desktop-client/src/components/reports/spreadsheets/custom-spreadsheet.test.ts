import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import type {
  CategoryEntity,
  CategoryGroupEntity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueryDataEntity } from '#components/reports/ReportOptions';

import type { createCustomSpreadsheetProps } from './custom-spreadsheet';
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

// ---------------------------------------------------------------------------
// Server double
//
// Both halves of this file stand up the same thing: a server that answers the
// query the way the real AQL layer does, so a report under test sees rows rather
// than a shape. It honours the date bounds the query carries (transforming the
// row's date the way `$transform` says before comparing), splits assets from
// debts on the query's own `amount` filter, and records the bounds and the
// budget months it was asked for.
// ---------------------------------------------------------------------------

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
 * The rows the server returns for the query. A test sets them per case; the
 * date-bound tests leave them at `weeklyRows`. Because the query groups by the
 * interval before returning, an interval-keyed row ('2024-01') and a raw day
 * ('2026-08-31') are both legitimate server answers, and both are compared
 * against the bound at the precision the query asked for.
 */
const servedRows = { current: weeklyRows as Array<Record<string, unknown>> };

function serveTheseRows(rows: QueryDataEntity[]) {
  servedRows.current = rows as unknown as Array<Record<string, unknown>>;
}

/**
 * `monthUtils.currentDay()` is hardcoded under the test setup (it short-circuits
 * on `global.IS_TESTING`), so the clamp cannot be moved with fake timers — the
 * module function itself has to be replaced.
 */
function pinToday(today: string) {
  vi.spyOn(monthUtils, 'currentDay').mockReturnValue(today);
}

/**
 * Budget rows are fetched one month at a time through `envelope-budget-month`
 * rather than through `query`, so the query recorder cannot observe them. Reset
 * by `getQueryEndDates`, which stands the server up.
 */
const budgetMonths: string[] = [];

/**
 * The width of a date at the precision `$transform` compares it at: the query
 * filters `{$transform: '$month', $gte: startDate}`, and the server applies the
 * transform before the comparison, so a row already keyed '2024-01' matches a
 * bound of '2024-01-01'. Truncating both sides keeps that faithful rather than
 * letting a lexical comparison decide it.
 */
function atPrecision(date: string, transform: string | undefined): string {
  if (transform === '$year') {
    return date.slice(0, 4);
  }
  if (transform === '$month') {
    return date.slice(0, 7);
  }
  return date.slice(0, 10);
}

/**
 * Stand up a server that honours the query's own date bounds and amount split,
 * the way the real AQL layer does, and record the end bound each query was
 * given. A mock that ignored either would return every row and make the bucket
 * totals independent of the bound and of the balance type, which is the thing
 * under test.
 */
function getQueryEndDates(): string[] {
  const endDates: string[] = [];
  budgetMonths.length = 0;
  initServer({
    'make-filters-from-conditions': async () => ({ filters: [] }),
    // A real budget month is non-empty. Returning real figures here is what
    // makes the budgeted assertions load-bearing: if a budget row ever *could*
    // match a weekly bucket, these figures would stop being zero. Both fixtures'
    // categories are served, since each test's category list picks out its own.
    'envelope-budget-month': async ({ month }: { month: string }) => {
      budgetMonths.push(month);
      return [
        { name: `budget-cat-groceries`, value: 100 },
        { name: 'budget-c-cell', value: 500 },
        { name: 'total-budgeted', value: 100 },
      ];
    },
    'tracking-budget-month': async ({ month }: { month: string }) => {
      budgetMonths.push(month);
      return [
        { name: `budget-cat-groceries`, value: 100 },
        { name: 'budget-c-cell', value: 500 },
        { name: `${month}-budget-total`, value: 500 },
      ];
    },
    query: async query => {
      let lower: string | undefined;
      let upper: string | undefined;
      let transform: string | undefined;
      let wantsDebts = false;
      // The conditions filter is also an `$and`, so match on the one that
      // actually carries the date range; the balance-type filter is its own
      // top-level expression.
      for (const expression of query.filterExpressions) {
        const amount = (expression as { amount?: { $lt?: number } }).amount;
        if (amount?.$lt !== undefined) {
          wantsDebts = true;
        }

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
          if (date?.$transform) {
            transform = date.$transform;
          }
        }
      }

      const data = servedRows.current.filter(row => {
        const date = atPrecision(String(row.date), transform);
        if (lower !== undefined && date < atPrecision(lower, transform)) {
          return false;
        }
        if (upper !== undefined && date > atPrecision(upper, transform)) {
          return false;
        }
        const amount = Number(row.amount);
        return wantsDebts ? amount < 0 : amount > 0;
      });

      return { data, dependencies: [] };
    },
  });
  return endDates;
}

async function runCustom(props: createCustomSpreadsheetProps): Promise<{
  data: CustomData;
  queryEndDates: string[];
  budgetMonths: string[];
}> {
  const queryEndDates = getQueryEndDates();

  const spreadsheet = createCustomSpreadsheet(props);

  let data: CustomData | undefined;
  await spreadsheet(undefined as never, result => {
    data = result;
  });

  if (!data) {
    throw new Error('Spreadsheet did not produce report data');
  }
  return { data, queryEndDates, budgetMonths: [...budgetMonths] };
}

async function runGrouped(
  props: createCustomSpreadsheetProps,
): Promise<GroupedData> {
  getQueryEndDates();

  const spreadsheet = createGroupedSpreadsheet(props);

  let data: GroupedData | undefined;
  await spreadsheet(undefined as never, result => {
    data = result;
  });

  return data ?? [];
}

/** The budget months the most recent run asked the server for. */
function getBudgetMonths(): string[] {
  return [...budgetMonths].sort();
}

// ---------------------------------------------------------------------------
// Category-axis fixtures
// ---------------------------------------------------------------------------

const categoryGroups: CategoryGroupEntity[] = [
  { id: 'g-usual', name: 'Usual Expenses', sort_order: 0 },
  { id: 'g-bills', name: 'Bills', sort_order: 1 },
];

const categories: CategoryEntity[] = [
  { id: 'c-food', name: 'Food', group: 'g-usual', sort_order: 0 },
  { id: 'c-rent', name: 'Rent', group: 'g-usual', sort_order: 1 },
  { id: 'c-cell', name: 'Cell', group: 'g-bills', sort_order: 0 },
];

/**
 * The category-axis cases assert on the report entity itself, so they read the
 * entity `runCustom` returns rather than destructuring the run record.
 */
async function runAxis(props: createCustomSpreadsheetProps) {
  const { data } = await runCustom(props);
  return { ...data, data: data.data ?? [] };
}

/**
 * A debt as the server would return it: `makeQuery` groups by the interval, so
 * `date` comes back already keyed to the report's interval ('2024-01', not a
 * date). Debts are negative amounts, so they reach the report through the debts
 * query rather than the assets one.
 */
function debtRow(
  category: string,
  amount: number,
  date = '2024-01',
): QueryDataEntity {
  return {
    date,
    category,
    categoryHidden: false,
    categoryGroup: category === 'c-cell' ? 'g-bills' : 'g-usual',
    categoryGroupHidden: false,
    account: 'a-checking',
    accountOffBudget: false,
    payee: 'p-store',
    transferAccount: '',
    amount,
  };
}

function makeFixture({ includeEmptyGroup = false } = {}) {
  const groups = includeEmptyGroup
    ? [...categoryGroups, { id: 'g-empty', name: 'Empty Group' }]
    : categoryGroups;

  return {
    list: categories,
    grouped: groups.map(group =>
      group.id === 'g-empty'
        ? { ...group, categories: [] }
        : {
            ...group,
            categories: categories.filter(c => c.group === group.id),
          },
    ),
  };
}

function baseProps(
  categoriesFixture: {
    list: CategoryEntity[];
    grouped: CategoryGroupEntity[];
  },
  overrides: Partial<createCustomSpreadsheetProps> = {},
): createCustomSpreadsheetProps {
  return {
    startDate: '2024-01-01',
    endDate: '2024-03-31',
    interval: 'Monthly',
    categories: categoriesFixture,
    conditions: [],
    conditionsOp: 'and',
    groupBy: 'Category',
    showEmpty: true,
    showOffBudget: true,
    showHiddenCategories: false,
    showUncategorized: true,
    trimIntervals: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Date-bound fixtures
// ---------------------------------------------------------------------------

const weeklyCategoryGroups = [
  { id: 'group-food', name: 'Food', is_income: false, sort_order: 0 },
] satisfies CategoryGroupEntity[];

const weeklyCategories = [
  { id: 'cat-groceries', name: 'Groceries', group: 'group-food' },
] satisfies CategoryEntity[];

/** The date-bound cases' props: weekly, their own categories, no narrowing. */
function weeklyProps({
  startDate = '2026-08-30',
  endDate,
  interval = 'Weekly',
  firstDayOfWeekIdx = '0',
  balanceTypeOp,
}: {
  startDate?: string;
  endDate: string;
  interval?: string;
  firstDayOfWeekIdx?: '0' | '1';
  balanceTypeOp?: 'totalBudgeted';
}): createCustomSpreadsheetProps {
  const shared = {
    startDate,
    endDate,
    interval,
    categories: {
      list: weeklyCategories,
      grouped: weeklyCategoryGroups,
    },
    conditions: [],
    conditionsOp: 'and',
    showEmpty: true,
    showOffBudget: true,
    showHiddenCategories: true,
    showUncategorized: true,
    trimIntervals: false,
    firstDayOfWeekIdx,
    balanceTypeOp,
  };

  return { ...shared, groupBy: 'Category' };
}

const selectCellOnly = [
  { field: 'category', op: 'oneOf', value: ['c-cell'] },
] as RuleConditionEntity[];

// The synthetic Uncategorized / Off budget / Transfers rows share an empty id,
// so axis identity is the row's id with its name as the tiebreaker.
function axisNames(rows: Array<{ id: string; name: string }>) {
  return rows.map(row => row.id || row.name);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await clearServer();
  servedRows.current = weeklyRows;
});

describe('weekly custom report end bound', () => {
  it('covers the whole final week once that week has elapsed', async () => {
    pinToday('2026-10-05');

    const { data, queryEndDates } = await runCustom(
      weeklyProps({
        endDate: '2026-10-03',
      }),
    );

    // 2026-10-03 is a Saturday, so it is already the week's true end.
    expect(queryEndDates).toEqual(['2026-10-03', '2026-10-03']);
    expect(
      data.intervalData[data.intervalData.length - 1].intervalEndDate,
    ).toBe('2026-10-03');
  });

  it('widens a week-start end date to the week it labels', async () => {
    pinToday('2026-10-05');

    const { data, queryEndDates } = await runCustom(
      weeklyProps({
        endDate: '2026-09-27',
      }),
    );

    expect(queryEndDates).toEqual(['2026-10-03', '2026-10-03']);
    expect(
      data.intervalData[data.intervalData.length - 1].intervalEndDate,
    ).toBe('2026-10-03');
  });

  it('clamps to today while the final week is still in progress', async () => {
    pinToday('2026-10-02');

    const { data, queryEndDates } = await runCustom(
      weeklyProps({
        endDate: '2026-09-27',
      }),
    );

    expect(queryEndDates).toEqual(['2026-10-02', '2026-10-02']);
    expect(
      data.intervalData[data.intervalData.length - 1].intervalEndDate,
    ).toBe('2026-10-02');
  });

  it('does not report the final week beyond the days that have happened', async () => {
    pinToday('2026-10-02');

    const { data } = await runCustom(weeklyProps({ endDate: '2026-09-27' }));
    const lastBucket = data.intervalData[data.intervalData.length - 1];

    // 50 + 60 + 70 + 80 + 90 — 10/03 has not happened yet, so its 100 is absent.
    expect(lastBucket.totalAssets).toBe(350);
  });

  it('leaves the non-final buckets on their existing day-before-next rule', async () => {
    pinToday('2026-10-05');

    const { data } = await runCustom(weeklyProps({ endDate: '2026-10-03' }));

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

    const { data, queryEndDates } = await runCustom(
      weeklyProps({
        startDate: '2026-09-28',
        endDate: '2026-09-28',
        firstDayOfWeekIdx: '1',
      }),
    );

    expect(queryEndDates).toEqual(['2026-10-04', '2026-10-04']);
    expect(
      data.intervalData[data.intervalData.length - 1].intervalEndDate,
    ).toBe('2026-10-04');
  });

  it('leaves Daily and Monthly on their existing end bounds', async () => {
    pinToday('2026-10-05');

    const daily = await runCustom(
      weeklyProps({
        startDate: '2026-09-27',
        endDate: '2026-09-29',
        interval: 'Daily',
      }),
    );
    expect(daily.queryEndDates).toEqual(['2026-09-29', '2026-09-29']);
    expect(
      daily.data.intervalData[daily.data.intervalData.length - 1]
        .intervalEndDate,
    ).toBe('2026-09-29');

    const monthly = await runCustom(
      weeklyProps({
        startDate: '2026-08-01',
        endDate: '2026-09-30',
        interval: 'Monthly',
      }),
    );
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

    const custom = await runCustom(weeklyProps({ endDate: '2026-10-03' }));
    const grouped = await runGrouped(weeklyProps({ endDate: '2026-10-03' }));

    const customLast =
      custom.data.intervalData[custom.data.intervalData.length - 1];
    const group = grouped.find(g => g.categories?.length);
    const groupedLast = group!.intervalData[group!.intervalData.length - 1];

    expect(groupedLast.intervalEndDate).toBe(customLast.intervalEndDate);
    expect(groupedLast.intervalEndDate).toBe('2026-10-03');
  });

  it('clamps to today the same way the custom spreadsheet does', async () => {
    pinToday('2026-10-02');

    const custom = await runCustom(weeklyProps({ endDate: '2026-09-27' }));
    const grouped = await runGrouped(weeklyProps({ endDate: '2026-09-27' }));

    const customLast =
      custom.data.intervalData[custom.data.intervalData.length - 1];
    const group = grouped.find(g => g.categories?.length);
    const groupedLast = group!.intervalData[group!.intervalData.length - 1];

    expect(groupedLast.intervalEndDate).toBe(customLast.intervalEndDate);
    expect(groupedLast.intervalEndDate).toBe('2026-10-02');
  });

  it('widens a week-start end date in the table view too', async () => {
    pinToday('2026-10-05');

    const custom = await runCustom(weeklyProps({ endDate: '2026-09-27' }));
    const grouped = await runGrouped(weeklyProps({ endDate: '2026-09-27' }));

    const customLast =
      custom.data.intervalData[custom.data.intervalData.length - 1];
    const group = grouped.find(g => g.categories?.length);
    const groupedLast = group!.intervalData[group!.intervalData.length - 1];

    expect(groupedLast.intervalEndDate).toBe(customLast.intervalEndDate);
    expect(groupedLast.intervalEndDate).toBe('2026-10-03');
  });
});

describe('weekly budgeted report end bound', () => {
  it('widens the budgeted query across the month boundary', async () => {
    pinToday('2026-10-02');

    // To 2026-09-27 widens to 2026-10-02, so the budget fetch must reach into
    // October. Recorded rather than assumed: the budgeted path does not go
    // through `query`, so this is the only place the bound is observable.
    await runCustom(
      weeklyProps({ endDate: '2026-09-27', balanceTypeOp: 'totalBudgeted' }),
    );

    expect(getBudgetMonths()).toEqual(['2026-08', '2026-09', '2026-10']);
  });

  it('widens the grouped budgeted query the same way', async () => {
    pinToday('2026-10-02');

    await runGrouped(
      weeklyProps({ endDate: '2026-09-27', balanceTypeOp: 'totalBudgeted' }),
    );

    expect(getBudgetMonths()).toEqual(['2026-08', '2026-09', '2026-10']);
  });

  it('moves no figure, because a month-keyed budget row cannot match a weekly bucket', async () => {
    // One report, run twice, differing only in whether the clamp widens. To
    // 2026-09-27 labels the week 09/27..10/03, so the clamp is a no-op while
    // today is 09/27 and widens once today has moved past it.
    pinToday('2026-09-27');
    const unwidened = await runCustom(
      weeklyProps({
        endDate: '2026-09-27',
        balanceTypeOp: 'totalBudgeted',
      }),
    );
    const unwidenedMonths = getBudgetMonths();

    pinToday('2026-10-02');
    const widened = await runCustom(
      weeklyProps({
        endDate: '2026-09-27',
        balanceTypeOp: 'totalBudgeted',
      }),
    );
    const widenedMonths = getBudgetMonths();

    // The widening really did add a month of budget rows to the fetch...
    expect(unwidenedMonths).toEqual(['2026-08', '2026-09']);
    expect(widenedMonths).toEqual(['2026-08', '2026-09', '2026-10']);

    // ...and moved no figure, because those rows are keyed by month ('2026-10')
    // while the buckets are labelled with week starts ('2026-09-27'). If that
    // ever stopped holding, the widened figures would differ and this assertion
    // would fail rather than quietly passing. Only the money fields are
    // compared: the final bucket's `intervalEndDate` is *meant* to move, since
    // labelling it is what the widening is for.
    const amounts = ({ intervalData }: CustomData) =>
      intervalData.map(bucket => ({
        date: bucket.date,
        totalAssets: bucket.totalAssets,
        totalDebts: bucket.totalDebts,
        netAssets: bucket.netAssets,
        netDebts: bucket.netDebts,
        totalTotals: bucket.totalTotals,
        totalBudgeted: bucket.totalBudgeted,
      }));

    expect(amounts(widened.data)).toEqual(amounts(unwidened.data));
    expect(widened.data.totalBudgeted).toBe(unwidened.data.totalBudgeted);

    // Non-vacuous: the mock returns a real 100 for `budget-cat-groceries` in
    // every month it is asked for, October included.
    expect(widenedMonths).toContain('2026-10');
    expect(widened.data.totalBudgeted).toBe(0);
  });

  it('gives the final bucket its full week on the budgeted path too', async () => {
    pinToday('2026-10-05');

    const { data } = await runCustom(
      weeklyProps({
        endDate: '2026-09-27',
        balanceTypeOp: 'totalBudgeted',
      }),
    );

    // 2026-09-27 is a Sunday whose week runs to 10/03, which has now passed.
    expect(
      data.intervalData[data.intervalData.length - 1].intervalEndDate,
    ).toBe('2026-10-03');
  });
});

describe('category axis narrowing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serveTheseRows([]);
  });

  it('drops unselected categories from the Category axis', async () => {
    const data = await runAxis(
      baseProps(makeFixture(), { conditions: selectCellOnly }),
    );

    // The synthetic Uncategorized / Off budget / Transfers block is appended
    // by `categoryLists` after the narrowing and must survive it.
    expect(axisNames(data.data)).toEqual([
      'c-cell',
      'Uncategorized',
      'Off budget',
      'Transfers',
    ]);
    expect(axisNames(data.data)).not.toContain('c-food');
    expect(axisNames(data.data)).not.toContain('c-rent');
  });

  it('drops unselected groups from the grouped data used by the table view', async () => {
    const groups = await runGrouped(
      baseProps(makeFixture(), { conditions: selectCellOnly }),
    );

    expect(groups.map(group => group.id)).toEqual(['g-bills', 'uncategorized']);
    expect(
      groups
        .find(group => group.id === 'g-bills')!
        .categories!.map(category => category.id),
    ).toEqual(['c-cell']);
  });

  it('drops unselected groups from the Group split', async () => {
    const data = await runAxis(
      baseProps(makeFixture(), {
        conditions: selectCellOnly,
        groupBy: 'Group',
      }),
    );

    expect(axisNames(data.data)).toEqual(['g-bills', 'uncategorized']);
  });

  it('narrows the axis but not the amounts for Type=Budgeted', async () => {
    const data = await runAxis(
      baseProps(makeFixture(), {
        conditions: selectCellOnly,
        balanceTypeOp: 'totalBudgeted',
      }),
    );

    expect(axisNames(data.data)).toEqual([
      'c-cell',
      'Uncategorized',
      'Off budget',
      'Transfers',
    ]);

    const cell = data.data.find(row => row.id === 'c-cell')!;
    expect(cell.intervalData!.map(interval => interval.totalBudgeted)).toEqual([
      500, 500, 500,
    ]);

    // No unselected category picks up an amount by being on the axis.
    const others = data.data.filter(row => row.id !== 'c-cell');
    expect(
      others.every(row => row.totalBudgeted === 0 && row.totalDebts === 0),
    ).toBe(true);
  });

  it('leaves the axis untouched with no conditions', async () => {
    const fixture = makeFixture({ includeEmptyGroup: true });
    const data = await runAxis(baseProps(fixture, { conditions: [] }));

    expect(axisNames(data.data)).toEqual([
      'c-food',
      'c-rent',
      'c-cell',
      'Uncategorized',
      'Off budget',
      'Transfers',
    ]);

    const groups = await runGrouped(baseProps(fixture, { conditions: [] }));

    // A group that is legitimately empty must not be dropped by the helper.
    expect(groups.map(group => group.id)).toEqual([
      'g-usual',
      'g-bills',
      'g-empty',
      'uncategorized',
    ]);
  });

  it('falls back to no narrowing for a condition it cannot interpret', async () => {
    // Neither of these narrows the category axis, and both must leave the axis
    // alone rather than dropping rows: a report filtered by something the
    // category filter does not understand keeps every category on screen.
    const uninterpretableConditions: RuleConditionEntity[][] = [
      // No category condition at all.
      [{ field: 'notes', op: 'hasTags', value: 'x' }],
      // A category condition whose operator the filter cannot evaluate. Not
      // expressible in RuleConditionEntity, hence the cast.
      [
        {
          field: 'category',
          op: 'hasTags',
          value: 'x',
        } as unknown as RuleConditionEntity,
      ],
    ];

    for (const conditions of uninterpretableConditions) {
      const data = await runAxis(baseProps(makeFixture(), { conditions }));

      expect(axisNames(data.data)).toEqual([
        'c-food',
        'c-rent',
        'c-cell',
        'Uncategorized',
        'Off budget',
        'Transfers',
      ]);

      const groups = await runGrouped(baseProps(makeFixture(), { conditions }));

      expect(groups.map(group => group.id)).toEqual([
        'g-usual',
        'g-bills',
        'uncategorized',
      ]);
    }
  });

  it('narrows the axis by group for a category_group condition', async () => {
    const conditions = [
      { field: 'category_group', op: 'is', value: 'g-bills' },
    ] as RuleConditionEntity[];

    const data = await runAxis(baseProps(makeFixture(), { conditions }));
    expect(axisNames(data.data)).toEqual([
      'c-cell',
      'Uncategorized',
      'Off budget',
      'Transfers',
    ]);

    const groupData = await runAxis(
      baseProps(makeFixture(), { conditions, groupBy: 'Group' }),
    );
    expect(axisNames(groupData.data)).toEqual(['g-bills', 'uncategorized']);
  });
});

describe("'any of' must not narrow the axis past what the query fetches", () => {
  // The query side unions every disjunct under 'any of' - `makeQuery` wraps the
  // whole filter list in `$or`. An axis narrowed by one disjunct therefore
  // renders fewer rows than the report fetched, and `recalculate` finds no row
  // to attach the rest to, so their amounts vanish from every total with no
  // error on screen. These cases pin the money, not just the shape.
  const notesPlusCell = [
    { field: 'notes', op: 'contains', value: 'e' },
    { field: 'category', op: 'oneOf', value: ['c-cell'] },
  ] as RuleConditionEntity[];

  beforeEach(() => {
    vi.clearAllMocks();
    serveTheseRows([]);
  });

  it("keeps the rows 'any of' fetched money for", async () => {
    serveTheseRows([debtRow('c-food', -1000), debtRow('c-cell', -500)]);

    const data = await runAxis(
      baseProps(makeFixture(), {
        conditions: notesPlusCell,
        conditionsOp: 'or',
      }),
    );

    // Both categories the query fetched are on the axis... (rows are sorted by
    // amount, so compare the set rather than the order)
    expect([...axisNames(data.data)].sort()).toEqual([
      'Off budget',
      'Transfers',
      'Uncategorized',
      'c-cell',
      'c-food',
      'c-rent',
    ]);

    // ...so all of it reaches the totals: -1000 (Food) + -500 (Cell).
    expect(data.totalDebts).toBe(-1500);
    expect(data.totalTotals).toBe(-1500);
    expect(data.data.find(row => row.id === 'c-food')!.totalDebts).toBe(-1000);
  });

  it("keeps both groups on the axis under 'any of'", async () => {
    serveTheseRows([debtRow('c-food', -1000), debtRow('c-cell', -500)]);

    const groups = await runGrouped(
      baseProps(makeFixture(), {
        conditions: notesPlusCell,
        conditionsOp: 'or',
      }),
    );

    // 'g-usual' is here because the notes disjunct populates it, and its
    // categories are here because the table view renders them.
    expect(groups.map(group => group.id)).toEqual([
      'g-usual',
      'g-bills',
      'uncategorized',
    ]);
    expect(
      groups
        .find(group => group.id === 'g-usual')!
        .categories!.map(category => category.id)
        .sort(),
    ).toEqual(['c-food', 'c-rent']);
  });

  it("keeps the notes-populated group on the Group split under 'any of'", async () => {
    serveTheseRows([debtRow('c-food', -1000), debtRow('c-cell', -500)]);

    const data = await runAxis(
      baseProps(makeFixture(), {
        conditions: notesPlusCell,
        conditionsOp: 'or',
        groupBy: 'Group',
      }),
    );

    expect(axisNames(data.data)).toEqual([
      'g-usual',
      'g-bills',
      'uncategorized',
    ]);
    expect(data.data.find(row => row.id === 'g-usual')!.totalDebts).toBe(-1000);
  });

  it("still narrows 'all of', so the fix cannot be narrowing switched off", async () => {
    serveTheseRows([debtRow('c-food', -1000), debtRow('c-cell', -500)]);

    const data = await runAxis(
      baseProps(makeFixture(), { conditions: selectCellOnly }),
    );

    expect(axisNames(data.data)).toEqual([
      'c-cell',
      'Uncategorized',
      'Off budget',
      'Transfers',
    ]);
    // 'all of' with only the Bills category selected keeps only Cell's money.
    expect(data.totalDebts).toBe(-500);
  });

  it("still narrows a single category condition under 'any of'", async () => {
    // One disjunct is trivially a union of one, so the gate must not degenerate
    // into 'op === or means never narrow'.
    serveTheseRows([debtRow('c-food', -1000), debtRow('c-cell', -500)]);

    const data = await runAxis(
      baseProps(makeFixture(), {
        conditions: selectCellOnly,
        conditionsOp: 'or',
      }),
    );

    expect(axisNames(data.data)).toEqual([
      'c-cell',
      'Uncategorized',
      'Off budget',
      'Transfers',
    ]);
    expect(data.totalDebts).toBe(-500);
  });

  it("still narrows 'or' over two category conditions to their union", async () => {
    // The negative control for the wildcard case below: two ordinary category
    // disjuncts still narrow, so the fix cannot be "never narrow text
    // conditions" - which would pass the money cases and drop the rows these
    // assert on.
    serveTheseRows([debtRow('c-food', -1000), debtRow('c-cell', -500)]);

    const data = await runAxis(
      baseProps(makeFixture(), {
        conditions: [
          { field: 'category', op: 'oneOf', value: ['c-food'] },
          { field: 'category', op: 'oneOf', value: ['c-cell'] },
        ] as RuleConditionEntity[],
        conditionsOp: 'or',
      }),
    );

    expect(axisNames(data.data)).toEqual([
      'c-food',
      'c-cell',
      'Uncategorized',
      'Off budget',
      'Transfers',
    ]);
    expect(data.totalDebts).toBe(-1500);
  });
});
describe('text operators are read the way the query reads them', () => {
  // `contains` reaches the query as `$like '%' + value + '%'`, and UNICODE_LIKE
  // speaks a pattern language: '%' and '?' are wildcards. Read as a literal
  // substring instead, the axis ends up narrower than the result set, and a
  // category with no row has nowhere to render the money the query fetched —
  // `recalculate` finds no row to attach it to and the amount leaves every
  // total with nothing on screen saying so. These cases assert the MONEY, not
  // the axis, because an axis assertion can be satisfied by a report that
  // renders the rows and then zeroes them.
  beforeEach(() => {
    vi.clearAllMocks();
    serveTheseRows([]);
  });

  const spending = [
    debtRow('c-food', -700),
    debtRow('c-rent', -300),
    debtRow('c-cell', -500),
  ];

  it('does not lose spending to a `contains` filter whose value is a bare %', async () => {
    // BUG-2. The query matches every category for this condition, so the axis
    // must too. On the buggy head the axis keeps only categories whose name
    // contains a literal percent sign - here, none - and the report reads 0.00.
    serveTheseRows(spending);

    const data = await runAxis(
      baseProps(makeFixture(), {
        conditions: [
          { field: 'category', op: 'contains', value: '%' },
        ] as RuleConditionEntity[],
      }),
    );

    expect(axisNames(data.data)).toEqual(
      expect.arrayContaining(['c-food', 'c-rent', 'c-cell']),
    );
    expect(data.totalDebts).toBe(-1500);
    expect(data.totalTotals).toBe(-1500);
  });

  it('does not lose spending to `contains %` beside a oneOf under "any of"', async () => {
    // BUG-3. Same divergence, reached through the gate: both disjuncts address
    // the category field, so the axis narrows to the oneOf branch, while the
    // query unions in a '%' arm that matches every transaction.
    serveTheseRows(spending);

    const data = await runAxis(
      baseProps(makeFixture(), {
        conditions: [
          { field: 'category', op: 'oneOf', value: ['c-cell'] },
          { field: 'category', op: 'contains', value: '%' },
        ] as RuleConditionEntity[],
        conditionsOp: 'or',
      }),
    );

    expect(axisNames(data.data)).toEqual(
      expect.arrayContaining(['c-food', 'c-rent', 'c-cell']),
    );
    expect(data.totalDebts).toBe(-1500);
    expect(data.totalTotals).toBe(-1500);
  });

  // The class-level invariant: every category the report FETCHED spending for
  // has a row to render into. BUG-2 and BUG-3 are both instances of it, and it
  // is the assertion to keep if a fifth operator is ever added - it needs no
  // reasoning about LIKE semantics to catch the next one.
  //
  // The served set per row below is the query's answer, derived from the
  // pattern language rather than from the axis, so this is a differential and
  // not a restatement of the implementation. It is deliberately ONE-DIRECTIONAL:
  // "Show empty rows" legitimately renders categories the query returned
  // nothing for, so a category with no row is only a failure when the report
  // fetched spending for it.
  const invariantCategories = [
    ...categories,
    { id: 'c-cafe', name: 'Café', group: 'g-usual', sort_order: 2 },
    { id: 'c-discount', name: '100% Off', group: 'g-bills', sort_order: 2 },
  ] as CategoryEntity[];

  function makeInvariantFixture() {
    return {
      list: invariantCategories,
      grouped: categoryGroups.map(group => ({
        ...group,
        categories: invariantCategories.filter(c => c.group === group.id),
      })),
    };
  }

  const invariantCases: Array<{
    op: string;
    value: string;
    // What the query matches, and therefore what it fetches money for.
    fetched: string[];
  }> = [
    {
      op: 'contains',
      value: '%',
      fetched: ['c-food', 'c-rent', 'c-cell', 'c-cafe', 'c-discount'],
    },
    {
      op: 'contains',
      value: '?',
      fetched: ['c-food', 'c-rent', 'c-cell', 'c-cafe', 'c-discount'],
    },
    { op: 'contains', value: 'o', fetched: ['c-food', 'c-discount'] },
    {
      op: 'contains',
      value: 'o%',
      fetched: ['c-food', 'c-discount'],
    },
    { op: 'contains', value: '100\\%', fetched: ['c-discount'] },
    { op: 'contains', value: 'cafe', fetched: ['c-cafe'] },
    { op: 'contains', value: 'CAFÉ', fetched: ['c-cafe'] },
    { op: 'contains', value: '_', fetched: [] },
    { op: 'contains', value: 'ood', fetched: ['c-food'] },
    { op: 'doesNotContain', value: '%', fetched: [] },
    {
      op: 'doesNotContain',
      value: 'o',
      fetched: ['c-rent', 'c-cell', 'c-cafe'],
    },
  ];

  it.each(invariantCases)(
    'renders a row for every category $op $value fetched',
    async ({ op, value, fetched }) => {
      const amounts = fetched.map((_id, index) => -(index + 1) * 100);
      serveTheseRows(fetched.map((id, index) => debtRow(id, amounts[index])));

      const data = await runAxis(
        baseProps(makeInvariantFixture(), {
          conditions: [
            { field: 'category', op, value },
          ] as RuleConditionEntity[],
        }),
      );

      for (const id of fetched) {
        expect(axisNames(data.data)).toContain(id);
      }
      expect(data.totalDebts).toBe(amounts.reduce((sum, n) => sum + n, 0));
    },
  );
});
