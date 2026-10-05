import { rangeInclusive } from '@actual-app/core/shared/months';
import type {
  CategoryEntity,
  CategoryGroupEntity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';

import {
  filterCategoriesForConditions,
  getLastSelectableMonth,
  getNextRunningBalance,
  isBaseCategory,
  summarizeMonthCategories,
} from './budget-analysis-spreadsheet';
import { filterCategoriesByConditions } from './budgetDataQuery';
import type { BudgetMonthCell } from './budgetMonthCell';

const makeCategory = (
  overrides: Partial<CategoryEntity> & Pick<CategoryEntity, 'id' | 'name'>,
): CategoryEntity => ({
  is_income: false,
  hidden: false,
  group: 'group1',
  ...overrides,
});

const visibleExpense = makeCategory({ id: 'c1', name: 'Groceries' });
const hiddenExpense = makeCategory({
  id: 'c2',
  name: 'Car Fund',
  hidden: true,
});
const incomeCategory = makeCategory({
  id: 'c3',
  name: 'Salary',
  is_income: true,
});
const hiddenIncome = makeCategory({
  id: 'c4',
  name: 'Hidden Income',
  is_income: true,
  hidden: true,
});

const all = [visibleExpense, hiddenExpense, incomeCategory, hiddenIncome];

function filterBaseCategories(
  categories: CategoryEntity[],
  showHiddenCategories: boolean,
): CategoryEntity[] {
  return categories.filter(cat => isBaseCategory(cat, showHiddenCategories));
}

const cells = (values: Record<string, number | boolean>): BudgetMonthCell[] =>
  Object.entries(values).map(([name, value]) => ({
    name: `budget202601!${name}`,
    value,
  })) as BudgetMonthCell[];

describe('createBudgetAnalysisSpreadsheet', () => {
  describe('hidden category filtering', () => {
    it('excludes hidden categories when showHiddenCategories is false', () => {
      const result = filterBaseCategories(all, false);
      expect(result).toContain(visibleExpense);
      expect(result).not.toContain(hiddenExpense);
    });

    it('includes hidden expense categories when showHiddenCategories is true', () => {
      const result = filterBaseCategories(all, true);
      expect(result).toContain(visibleExpense);
      expect(result).toContain(hiddenExpense);
    });

    it('always excludes income categories regardless of showHiddenCategories', () => {
      const resultFalse = filterBaseCategories(all, false);
      const resultTrue = filterBaseCategories(all, true);
      expect(resultFalse).not.toContain(incomeCategory);
      expect(resultFalse).not.toContain(hiddenIncome);
      expect(resultTrue).not.toContain(incomeCategory);
      expect(resultTrue).not.toContain(hiddenIncome);
    });

    it('returns only visible expense categories by default', () => {
      const result = filterBaseCategories(all, false);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(visibleExpense);
    });

    it('returns all expense categories when flag is true', () => {
      const result = filterBaseCategories(all, true);
      expect(result).toHaveLength(2);
      expect(result).toContain(visibleExpense);
      expect(result).toContain(hiddenExpense);
    });
  });

  describe('getLastSelectableMonth', () => {
    it('extends the range to December of next year', () => {
      expect(getLastSelectableMonth('2026-06', '2026-06')).toBe('2027-12');
    });

    it('ends in December regardless of the current month', () => {
      for (const month of ['2024-01', '2024-06', '2024-12']) {
        expect(getLastSelectableMonth(month, month)).toBe('2025-12');
      }
    });

    it('keeps a later transaction month selectable', () => {
      // A transaction dated past December of next year must not be cut off.
      expect(getLastSelectableMonth('2026-08', '2028-03')).toBe('2028-03');
    });

    it('prefers December of next year when the latest transaction is earlier', () => {
      expect(getLastSelectableMonth('2026-08', '2026-11')).toBe('2027-12');
    });

    it('keeps the boundary month itself', () => {
      expect(getLastSelectableMonth('2026-08', '2027-12')).toBe('2027-12');
    });

    it('produces a range that spans from the earliest month to the endpoint', () => {
      const range = rangeInclusive(
        '2026-06',
        getLastSelectableMonth('2026-06', '2026-06'),
      );

      expect(range[0]).toBe('2026-06');
      expect(range[range.length - 1]).toBe('2027-12');
    });

    it('lists future months before the current month once reversed', () => {
      const last = getLastSelectableMonth('2026-06', '2026-06');
      const allMonths = rangeInclusive('2026-06', last).reverse();

      expect(allMonths[0]).toBe(last);
      expect(allMonths[allMonths.length - 1]).toBe('2026-06');
    });
  });

  describe('summarizeMonthCategories', () => {
    it('reports no budget data when every cell is empty', () => {
      const result = summarizeMonthCategories([], [visibleExpense]);

      expect(result).toEqual({
        budgeted: 0,
        spent: 0,
        carryoverToNextMonth: 0,
        overspendingThisMonth: 0,
        hasBudgetData: false,
      });
    });

    it('reports no budget data for a never-budgeted month', () => {
      // `envelope-budget-month` emits a cell for every category in every
      // month, so an untouched future month arrives as present-but-zero
      // cells rather than as missing ones. Presence alone cannot distinguish
      // it from a real month.
      const result = summarizeMonthCategories(
        cells({
          'budget-c1': 0,
          'sum-amount-c1': 0,
          'leftover-c1': 0,
          'carryover-c1': false,
        }),
        [visibleExpense],
      );

      expect(result.hasBudgetData).toBe(false);
    });

    it('carries a positive balance to the next month', () => {
      const result = summarizeMonthCategories(
        cells({
          'budget-c1': 10000,
          'sum-amount-c1': -4000,
          'leftover-c1': 6000,
          'carryover-c1': false,
        }),
        [visibleExpense],
      );

      expect(result.carryoverToNextMonth).toBe(6000);
      expect(result.overspendingThisMonth).toBe(0);
      expect(result.hasBudgetData).toBe(true);
    });

    it('treats an overspend without carryover as an overspending adjustment', () => {
      const result = summarizeMonthCategories(
        cells({
          'budget-c1': 0,
          'sum-amount-c1': -10000,
          'leftover-c1': -10000,
          'carryover-c1': false,
        }),
        [visibleExpense],
      );

      expect(result.carryoverToNextMonth).toBe(0);
      expect(result.overspendingThisMonth).toBe(-10000);
      expect(result.hasBudgetData).toBe(true);
    });

    it('carries a negative balance forward when carryover is enabled', () => {
      const result = summarizeMonthCategories(
        cells({
          'budget-c1': 0,
          'sum-amount-c1': -10000,
          'leftover-c1': -10000,
          'carryover-c1': true,
        }),
        [visibleExpense],
      );

      expect(result.carryoverToNextMonth).toBe(-10000);
      expect(result.overspendingThisMonth).toBe(0);
    });

    it('only counts the categories it is given', () => {
      const result = summarizeMonthCategories(
        cells({
          'budget-c1': 10000,
          'leftover-c1': 10000,
          'budget-c2': 5000,
          'leftover-c2': 5000,
        }),
        [visibleExpense],
      );

      expect(result.budgeted).toBe(10000);
      expect(result.carryoverToNextMonth).toBe(10000);
    });
  });

  describe('getNextRunningBalance', () => {
    it('hands off only what carries over when the month has data', () => {
      expect(
        getNextRunningBalance({
          hasBudgetData: true,
          carryoverToNextMonth: 6000,
          runningBalance: 20000,
        }),
      ).toBe(6000);
    });

    it('resets a non-carryover overspend instead of dragging it forward', () => {
      // The overspend surfaces as next month's overspending adjustment, so it
      // must not also reduce the running balance.
      expect(
        getNextRunningBalance({
          hasBudgetData: true,
          carryoverToNextMonth: 0,
          runningBalance: 20000,
        }),
      ).toBe(0);
    });

    it('passes the running balance through months with no budget data', () => {
      expect(
        getNextRunningBalance({
          hasBudgetData: false,
          carryoverToNextMonth: 0,
          runningBalance: 20000,
        }),
      ).toBe(20000);
    });

    it('preserves a balance across a run of empty future months', () => {
      let runningBalance = 15000;
      for (let i = 0; i < 6; i++) {
        runningBalance = getNextRunningBalance({
          hasBudgetData: false,
          carryoverToNextMonth: 0,
          runningBalance,
        });
      }

      expect(runningBalance).toBe(15000);
    });

    it('does not carry a non-carryover overspend into later empty months', () => {
      // Overspend of -10000 in a category without carryover enabled.
      let runningBalance = getNextRunningBalance({
        hasBudgetData: true,
        carryoverToNextMonth: 0,
        runningBalance: 0,
      });

      for (let i = 0; i < 3; i++) {
        runningBalance = getNextRunningBalance({
          hasBudgetData: false,
          carryoverToNextMonth: 0,
          runningBalance,
        });
      }

      expect(runningBalance).toBe(0);
    });
  });

  // The list `filterCategoriesForConditions` returns is exactly the list
  // `summarizeMonthCategories` sums every month's totals over, so a filter that
  // is stricter than the month data deletes a category's budgeted and spent
  // amounts from the report with no error and no empty state. The differential
  // cases hold it against `filterCategoriesByConditions`, the implementation
  // the Custom and Grouped reports ship. The names are deliberately
  // wildcard-shaped so an over-broad fix and an over-escaping one both fail.
  describe('filterCategoriesForConditions', () => {
    const wildcardBase = filterBaseCategories(
      [
        makeCategory({ id: 'c_food', name: 'Food', group: 'g_fun' }),
        makeCategory({ id: 'c_groceries', name: 'Groceries', group: 'g_fun' }),
        makeCategory({ id: 'c_100off', name: '100% Off', group: 'g_bills' }),
        makeCategory({ id: 'c_cafe', name: 'Café', group: 'g_bills' }),
        makeCategory({ id: 'c_csharp', name: 'C_Sharp', group: 'g_savings' }),
      ],
      false,
    );

    const wildcardGroups = [
      { id: 'g_fun', name: 'Fun Money' },
      { id: 'g_bills', name: 'Bills' },
      { id: 'g_savings', name: 'Savings' },
    ] as CategoryGroupEntity[];

    const everyId = wildcardBase.map(cat => cat.id);

    const monthCells = cells({
      'budget-c_food': 100,
      'sum-amount-c_food': -10,
      'leftover-c_food': 0,
      'budget-c_groceries': 200,
      'sum-amount-c_groceries': -20,
      'leftover-c_groceries': 0,
      'budget-c_100off': 300,
      'sum-amount-c_100off': -30,
      'leftover-c_100off': 0,
      'budget-c_cafe': 400,
      'sum-amount-c_cafe': -40,
      'leftover-c_cafe': -40,
      'budget-c_csharp': 500,
      'sum-amount-c_csharp': -50,
      'leftover-c_csharp': -80,
    });

    const textCondition = (
      field: 'category' | 'category_group',
      op: 'contains' | 'doesNotContain',
      value: string,
    ) => ({ field, op, value, customName: '' }) as RuleConditionEntity;

    const ids = (
      op: 'contains' | 'doesNotContain',
      value: string,
      field: 'category' | 'category_group' = 'category',
    ) =>
      filterCategoriesForConditions(
        wildcardBase,
        wildcardGroups,
        [textCondition(field, op, value)],
        'and',
      ).map(cat => cat.id);

    const referenceIds = (
      op: 'contains' | 'doesNotContain',
      value: string,
      field: 'category' | 'category_group' = 'category',
    ) =>
      filterCategoriesByConditions(
        wildcardBase,
        wildcardGroups,
        [textCondition(field, op, value)],
        'and',
      ).map(cat => cat.id);

    const differentialCases = (['category', 'category_group'] as const).flatMap(
      field =>
        ['%', '?', 'o%', '\\%', '_', 'C_', 'oo', 'cafe', 'café', 'Fun'].map(
          value => [field, value] as const,
        ),
    );

    it.each(differentialCases)(
      'agrees with the query-side filter on %s / "%s"',
      (field, value) => {
        expect(ids('contains', value, field)).toEqual(
          referenceIds('contains', value, field),
        );
        expect(ids('doesNotContain', value, field)).toEqual(
          referenceIds('doesNotContain', value, field),
        );
      },
    );

    it('keeps the whole axis for a bare "%" and a bare "?"', () => {
      expect(ids('contains', '%')).toEqual(everyId);
      expect(ids('contains', '?')).toEqual(everyId);
    });

    it('reads "o%" as an "o" followed by anything', () => {
      expect(ids('contains', 'o%')).toEqual([
        'c_food',
        'c_groceries',
        'c_100off',
      ]);
    });

    it('reads a backslash-escaped "%" as a literal percent sign', () => {
      expect(ids('contains', '\\%')).toEqual(['c_100off']);
    });

    it.each(['%', '?', 'o%'])(
      'makes doesNotContain "%s" the exact complement of contains',
      value => {
        const includes = ids('contains', value);
        const excludes = ids('doesNotContain', value);

        expect(excludes).toEqual(everyId.filter(id => !includes.includes(id)));
        expect(excludes.filter(id => includes.includes(id))).toEqual([]);
        expect([...includes, ...excludes].sort()).toEqual([...everyId].sort());
      },
    );

    it('sums the totals over exactly the list the filter returns', () => {
      // Food 100 + Groceries 200 + 100% Off 300.
      const totals = summarizeMonthCategories(
        monthCells,
        filterCategoriesForConditions(
          wildcardBase,
          wildcardGroups,
          [textCondition('category', 'contains', 'o%')],
          'and',
        ),
      );

      expect(totals.budgeted).toBe(600);
      expect(totals.spent).toBe(-60);

      // A bare "%" keeps every category, so the totals are the unfiltered ones.
      const unfiltered = summarizeMonthCategories(
        monthCells,
        filterCategoriesForConditions(
          wildcardBase,
          wildcardGroups,
          [textCondition('category', 'contains', '%')],
          'and',
        ),
      );

      expect(unfiltered.budgeted).toBe(1500);
      expect(unfiltered.spent).toBe(-150);
    });

    it('counts an excluded category nowhere at all', () => {
      const totals = summarizeMonthCategories(
        monthCells,
        filterCategoriesForConditions(
          wildcardBase,
          wildcardGroups,
          [textCondition('category', 'contains', 'cafe')],
          'and',
        ),
      );

      // Only "Café" survives, so only its own -40 balance becomes an
      // overspending adjustment; C_Sharp's -80 is not counted either.
      expect(totals).toEqual({
        budgeted: 400,
        spent: -40,
        carryoverToNextMonth: 0,
        overspendingThisMonth: -40,
        hasBudgetData: true,
      });
    });

    it('leaves the id and regex operators alone', () => {
      const byOp = (condition: RuleConditionEntity) =>
        filterCategoriesForConditions(
          wildcardBase,
          wildcardGroups,
          [condition],
          'and',
        ).map(cat => cat.id);

      expect(
        byOp({ field: 'category', op: 'is', value: 'c_food', customName: '' }),
      ).toEqual(['c_food']);
      expect(
        byOp({
          field: 'category',
          op: 'isNot',
          value: 'c_food',
          customName: '',
        }),
      ).toEqual(everyId.filter(id => id !== 'c_food'));
      expect(
        byOp({
          field: 'category',
          op: 'oneOf',
          value: ['c_food', 'c_cafe'],
          customName: '',
        }),
      ).toEqual(['c_food', 'c_cafe']);
      expect(
        byOp({
          field: 'category',
          op: 'notOneOf',
          value: ['c_food', 'c_cafe'],
          customName: '',
        }),
      ).toEqual(everyId.filter(id => !['c_food', 'c_cafe'].includes(id)));
      expect(
        byOp({
          field: 'category',
          op: 'matches',
          value: 'grocer',
          customName: '',
        }),
      ).toEqual(['c_groceries']);
    });

    it('returns the base categories untouched when nothing filters them', () => {
      expect(
        filterCategoriesForConditions(wildcardBase, wildcardGroups, [], 'and'),
      ).toBe(wildcardBase);

      // A condition on a non-category field is not a category filter either.
      expect(
        filterCategoriesForConditions(
          wildcardBase,
          wildcardGroups,
          [
            {
              field: 'notes',
              op: 'contains',
              value: '%',
              customName: '',
            } as RuleConditionEntity,
          ],
          'and',
        ),
      ).toBe(wildcardBase);
    });

    it('unions under "or" and intersects under "and"', () => {
      const foodCondition = textCondition('category', 'contains', 'oo');
      const cafeCondition = textCondition('category', 'contains', 'cafe');

      expect(
        filterCategoriesForConditions(
          wildcardBase,
          wildcardGroups,
          [foodCondition, cafeCondition],
          'or',
        ).map(cat => cat.id),
      ).toEqual(['c_food', 'c_cafe']);
      expect(
        filterCategoriesForConditions(
          wildcardBase,
          wildcardGroups,
          [foodCondition, cafeCondition],
          'and',
        ),
      ).toEqual([]);

      const reference = (conditionsOp: 'and' | 'or') =>
        filterCategoriesByConditions(
          wildcardBase,
          wildcardGroups,
          [foodCondition, cafeCondition],
          conditionsOp,
        ).map(cat => cat.id);

      expect(reference('or')).toEqual(['c_food', 'c_cafe']);
      expect(reference('and')).toEqual([]);
    });

    it('excludes hidden and income categories before the filter runs', () => {
      const withHidden = [
        ...wildcardBase,
        makeCategory({
          id: 'c_hidden',
          name: 'Food',
          group: 'g_fun',
          hidden: true,
        }),
        makeCategory({
          id: 'c_income',
          name: 'Groceries',
          group: 'g_savings',
          is_income: true,
        }),
      ];

      expect(
        filterCategoriesForConditions(
          filterBaseCategories(withHidden, false),
          wildcardGroups,
          [textCondition('category', 'contains', '%')],
          'and',
        ).map(cat => cat.id),
      ).toEqual(everyId);
      expect(
        filterCategoriesForConditions(
          filterBaseCategories(withHidden, true),
          wildcardGroups,
          [textCondition('category', 'contains', '%')],
          'and',
        ).map(cat => cat.id),
      ).toEqual([...everyId, 'c_hidden']);
    });
  });
});
