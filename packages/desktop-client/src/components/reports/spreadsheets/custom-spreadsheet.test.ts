import type {
  CategoryEntity,
  CategoryGroupEntity,
  DataEntity,
  GroupedEntity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueryDataEntity } from '#components/reports/ReportOptions';

import type { createCustomSpreadsheetProps } from './custom-spreadsheet';
import { createCustomSpreadsheet } from './custom-spreadsheet';
import { createGroupedSpreadsheet } from './grouped-spreadsheet';

// The budgeted path goes through the real `fetchSpreadsheetQueryData`, so the
// stubs below stand in for the server only - never for the data layer.
vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: vi.fn(async (name: string, args: unknown) => {
    if (name === 'make-filters-from-conditions') {
      return { filters: [] };
    }

    if (name === 'envelope-budget-month' || name === 'tracking-budget-month') {
      const month = (args as { month: string }).month;
      return [
        { name: `budget-c-cell`, value: 500 },
        { name: `${month}-budget-total`, value: 500 },
      ];
    }

    throw new Error(`Unexpected send() in test: ${name}`);
  }),
}));

// The rows the server would return for the query, standing in for it exactly
// as the `send` stub above stands in for the budget endpoints. A test sets them
// per case and `aqlQuery` splits them into assets and debts the way the query's
// `amount` filter would, so a case can assert on money rather than on shape.
// `vi.hoisted` because `vi.mock` is hoisted above this declaration.
const { serverRows } = vi.hoisted(() => ({
  serverRows: { current: [] as QueryDataEntity[] },
}));

function serveTheseRows(rows: QueryDataEntity[]) {
  serverRows.current = rows;
}

vi.mock('#queries/aqlQuery', () => ({
  aqlQuery: async (query: {
    state: {
      filterExpressions: Array<Record<string, Record<string, unknown>>>;
    };
  }) => {
    const wantsDebts = query.state.filterExpressions.some(filter =>
      Object.hasOwn(filter.amount ?? {}, '$lt'),
    );

    return {
      data: serverRows.current.filter(row =>
        wantsDebts ? row.amount < 0 : row.amount > 0,
      ),
    };
  },
}));

// A debt as the server would return it: `makeQuery` groups by `$month`, so
// `date` comes back already transformed to the report's interval key ('2024-01',
// not a date). Debts are negative amounts, so they reach the report through the
// debts query rather than the assets one.
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

const categoryGroups: CategoryGroupEntity[] = [
  { id: 'g-usual', name: 'Usual Expenses', sort_order: 0 },
  { id: 'g-bills', name: 'Bills', sort_order: 1 },
];

const categories: CategoryEntity[] = [
  { id: 'c-food', name: 'Food', group: 'g-usual', sort_order: 0 },
  { id: 'c-rent', name: 'Rent', group: 'g-usual', sort_order: 1 },
  { id: 'c-cell', name: 'Cell', group: 'g-bills', sort_order: 0 },
];

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

async function runCustom(props: createCustomSpreadsheetProps) {
  const run = createCustomSpreadsheet(props);
  let captured: DataEntity | undefined;
  await run({} as never, data => {
    captured = data;
  });
  if (!captured) {
    throw new Error('createCustomSpreadsheet never called setData');
  }
  return { ...captured, data: captured.data ?? [] };
}

async function runGrouped(props: createCustomSpreadsheetProps) {
  const run = createGroupedSpreadsheet(props);
  let captured: GroupedEntity[] | undefined;
  await run({} as never, data => {
    captured = data;
  });
  if (!captured) {
    throw new Error('createGroupedSpreadsheet never called setData');
  }
  return captured;
}

const selectCellOnly = [
  { field: 'category', op: 'oneOf', value: ['c-cell'] },
] as RuleConditionEntity[];

// The synthetic Uncategorized / Off budget / Transfers rows share an empty id,
// so axis identity is the row's id with its name as the tiebreaker.
function axisNames(rows: Array<{ id: string; name: string }>) {
  return rows.map(row => row.id || row.name);
}

describe('category axis narrowing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serveTheseRows([]);
  });

  it('drops unselected categories from the Category axis', async () => {
    const data = await runCustom(
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
    const data = await runCustom(
      baseProps(makeFixture(), {
        conditions: selectCellOnly,
        groupBy: 'Group',
      }),
    );

    expect(axisNames(data.data)).toEqual(['g-bills', 'uncategorized']);
  });

  it('narrows the axis but not the amounts for Type=Budgeted', async () => {
    const data = await runCustom(
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
    const data = await runCustom(baseProps(fixture, { conditions: [] }));

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
      const data = await runCustom(baseProps(makeFixture(), { conditions }));

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

    const data = await runCustom(baseProps(makeFixture(), { conditions }));
    expect(axisNames(data.data)).toEqual([
      'c-cell',
      'Uncategorized',
      'Off budget',
      'Transfers',
    ]);

    const groupData = await runCustom(
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

    const data = await runCustom(
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

    const data = await runCustom(
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

    const data = await runCustom(
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

    const data = await runCustom(
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
});
