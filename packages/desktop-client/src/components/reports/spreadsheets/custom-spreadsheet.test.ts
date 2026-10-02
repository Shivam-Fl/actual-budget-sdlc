import type {
  CategoryEntity,
  CategoryGroupEntity,
  DataEntity,
  GroupedEntity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('#queries/aqlQuery', () => ({
  aqlQuery: async () => ({ data: [] }),
}));

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
