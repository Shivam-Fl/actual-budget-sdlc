import type {
  CategoryEntity,
  CategoryGroupEntity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';
import { describe, expect, it } from 'vitest';

import {
  filterCategoriesByConditions,
  narrowCategoriesByConditions,
} from './budgetDataQuery';

const categoryGroups = [
  { id: 'group-bills', name: 'Bills' },
  { id: 'group-fun', name: 'Fun Money' },
  { id: 'group-savings', name: 'Savings' },
] as CategoryGroupEntity[];

const categories = [
  { id: 'cat-rent', name: 'Rent', group: 'group-bills' },
  { id: 'cat-electric', name: 'Electric', group: 'group-bills' },
  { id: 'cat-dining', name: 'Dining Out', group: 'group-fun' },
  { id: 'cat-emergency', name: 'Emergency Fund', group: 'group-savings' },
] as CategoryEntity[];

describe('filterCategoriesByConditions', () => {
  it('filters budget categories by category group', () => {
    const result = filterCategoriesByConditions(
      categories,
      categoryGroups,
      [
        {
          field: 'category_group',
          op: 'is',
          value: 'group-bills',
        } as RuleConditionEntity,
      ],
      'and',
    );

    expect(result.map(category => category.id)).toEqual([
      'cat-rent',
      'cat-electric',
    ]);
  });

  it('supports selecting one of multiple category groups', () => {
    const result = filterCategoriesByConditions(
      categories,
      categoryGroups,
      [
        {
          field: 'category_group',
          op: 'oneOf',
          value: ['group-fun', 'group-savings'],
        } as RuleConditionEntity,
      ],
      'and',
    );

    expect(result.map(category => category.id)).toEqual([
      'cat-dining',
      'cat-emergency',
    ]);
  });

  it('combines category and category group filters with and', () => {
    const result = filterCategoriesByConditions(
      categories,
      categoryGroups,
      [
        {
          field: 'category_group',
          op: 'is',
          value: 'group-bills',
        } as RuleConditionEntity,
        {
          field: 'category',
          op: 'is',
          value: 'cat-rent',
        } as RuleConditionEntity,
      ],
      'and',
    );

    expect(result.map(category => category.id)).toEqual(['cat-rent']);
  });

  it('matches text operators against category group names', () => {
    const result = filterCategoriesByConditions(
      categories,
      categoryGroups,
      [
        {
          field: 'category_group',
          op: 'contains',
          value: 'fun',
        } as RuleConditionEntity,
      ],
      'and',
    );

    expect(result.map(category => category.id)).toEqual(['cat-dining']);
  });
});

describe('narrowCategoriesByConditions', () => {
  const axisGroups = [
    { id: 'g-usual', name: 'Usual Expenses', sort_order: 0 },
    { id: 'g-bills', name: 'Bills', sort_order: 1 },
  ] as CategoryGroupEntity[];

  const axisCategories = [
    { id: 'c-food', name: 'Food', group: 'g-usual', sort_order: 0 },
    { id: 'c-rent', name: 'Rent', group: 'g-usual', sort_order: 1 },
    { id: 'c-cell', name: 'Cell', group: 'g-bills', sort_order: 0 },
    { id: 'c-net', name: 'Internet', group: 'g-bills', sort_order: 1 },
  ] as CategoryEntity[];

  function makeAxis() {
    return {
      list: axisCategories,
      grouped: axisGroups.map(group => ({
        ...group,
        categories: axisCategories.filter(c => c.group === group.id),
      })),
    };
  }

  function narrow(
    conditions: RuleConditionEntity[] | undefined,
    op: 'and' | 'or',
  ) {
    return narrowCategoriesByConditions(makeAxis(), conditions, op);
  }

  // Under 'or' a returned transaction only has to satisfy ONE condition, so a
  // category condition is one disjunct among several. The query side unions
  // every disjunct, so narrowing the axis to that one disjunct's categories
  // deletes rows the query still fetched - and with them, their money.
  it('leaves the axis untouched under "or" with a non-category disjunct', () => {
    const axis = makeAxis();
    const conditions = [
      { field: 'notes', op: 'contains', value: 'e' },
      { field: 'category', op: 'oneOf', value: ['c-cell'] },
    ] as RuleConditionEntity[];

    const result = narrowCategoriesByConditions(axis, conditions, 'or');

    expect(result.list.map(category => category.id)).toEqual([
      'c-food',
      'c-rent',
      'c-cell',
      'c-net',
    ]);
    expect(
      result.grouped.map(group => [
        group.id,
        (group.categories ?? []).map(category => category.id),
      ]),
    ).toEqual([
      ['g-usual', ['c-food', 'c-rent']],
      ['g-bills', ['c-cell', 'c-net']],
    ]);
  });

  it('leaves the axis untouched under "or" with a date disjunct', () => {
    // Same defect from a different field: the gate keys on `field`, so a date
    // disjunct escapes the category axis exactly as a notes disjunct does.
    const result = narrow(
      [
        { field: 'date', op: 'gte', value: '2024-01-01' },
        { field: 'category', op: 'oneOf', value: ['c-cell'] },
      ] as RuleConditionEntity[],
      'or',
    );

    expect(result.list.map(category => category.id)).toEqual([
      'c-food',
      'c-rent',
      'c-cell',
      'c-net',
    ]);
  });

  it('still narrows under "or" when every disjunct is category-bound', () => {
    // The fix is a gate on soundness, not a revert: when the whole disjunction
    // is a statement about the category axis, its union is one too.
    const result = narrow(
      [
        { field: 'category', op: 'oneOf', value: ['c-food'] },
        { field: 'category', op: 'oneOf', value: ['c-cell'] },
      ] as RuleConditionEntity[],
      'or',
    );

    expect(result.list.map(category => category.id)).toEqual([
      'c-food',
      'c-cell',
    ]);
    expect(
      result.grouped.map(group => [
        group.id,
        (group.categories ?? []).map(category => category.id),
      ]),
    ).toEqual([
      ['g-usual', ['c-food']],
      ['g-bills', ['c-cell']],
    ]);
  });

  it('still narrows under "or" mixing a category and a category_group disjunct', () => {
    const result = narrow(
      [
        { field: 'category', op: 'oneOf', value: ['c-food'] },
        { field: 'category_group', op: 'is', value: 'g-bills' },
      ] as RuleConditionEntity[],
      'or',
    );

    expect(result.list.map(category => category.id)).toEqual([
      'c-food',
      'c-cell',
      'c-net',
    ]);
    expect(
      result.grouped
        .find(group => group.id === 'g-usual')!
        .categories!.map(category => category.id),
    ).toEqual(['c-food']);
  });

  it('still narrows under "or" when the only other disjunct is a customName', () => {
    // Guards the gate being written one notch too wide: a `customName`
    // condition is stripped before the query is built, so it is not a disjunct
    // of the result set and must not veto narrowing.
    const result = narrow(
      [
        {
          field: 'notes',
          op: 'contains',
          value: 'e',
          customName: 'my notes filter',
        },
        { field: 'category', op: 'oneOf', value: ['c-cell'] },
      ] as RuleConditionEntity[],
      'or',
    );

    expect(result.list.map(category => category.id)).toEqual(['c-cell']);
  });

  it('still narrows under "and" with a non-category condition', () => {
    // The scenario issue #4 was filed about, which QA validated: a conjunctive
    // result satisfies every condition, so the category condition does describe
    // the axis on its own.
    const result = narrow(
      [
        { field: 'notes', op: 'contains', value: 'e' },
        { field: 'category', op: 'oneOf', value: ['c-cell'] },
      ] as RuleConditionEntity[],
      'and',
    );

    expect(result.list.map(category => category.id)).toEqual(['c-cell']);
    expect(result.grouped.map(group => group.id)).toEqual(['g-bills']);
  });

  it('returns the input by identity when there is nothing to narrow', () => {
    const axis = makeAxis();

    // By identity, not merely equal: the guard is what keeps a legitimately
    // empty group in an unfiltered report from being rebuilt away.
    expect(narrowCategoriesByConditions(axis, [], 'or')).toBe(axis);
    expect(narrowCategoriesByConditions(axis, undefined, 'and')).toBe(axis);
  });

  it('falls back to the input for an uninterpretable category condition', () => {
    // The gate lets this through - a `category` field IS axis-bound - and the
    // conservative fallback inside `filterCategoriesByConditions` is what stops
    // the narrowing, unchanged by this fix.
    const axis = makeAxis();

    const result = narrowCategoriesByConditions(
      axis,
      [
        { field: 'category', op: 'hasTags', value: 'x' },
        { field: 'category', op: 'oneOf', value: ['c-cell'] },
      ] as unknown as RuleConditionEntity[],
      'or',
    );

    expect(result).toBe(axis);
  });
});
