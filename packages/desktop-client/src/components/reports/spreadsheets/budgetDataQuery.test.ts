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

// The query side compiles `contains` to `$like '%' + value + '%'`, which the
// compiler turns into `UNICODE_LIKE(<normalised pattern>, NORMALISE(name))`.
// UNICODE_LIKE speaks a PATTERN language, not a substring language: '%' and '?'
// are wildcards and a backslash escapes them. Reading the same condition as a
// plain `toLowerCase().includes()` puts the axis in a strict subset of the
// result set, and a category with no row has nowhere to render its money — it
// is silently dropped from every total. These cases hold the axis to what the
// query actually returns.
describe('filterCategoriesByConditions reads text operators as LIKE patterns', () => {
  // The fixture above is plain ASCII with no wildcard-looking characters, so it
  // cannot tell an over-broad fix (keeps everything) from an over-escaping one
  // (keeps only literal substrings). This one carries every shape that matters.
  const wildcardCategories = [
    { id: 'c-food', name: 'Food', group: 'group-fun' },
    { id: 'c-groceries', name: 'Groceries', group: 'group-fun' },
    { id: 'c-discount', name: '100% Off', group: 'group-bills' },
    { id: 'c-cafe', name: 'Café', group: 'group-savings' },
    { id: 'c-underscore', name: 'C_Sharp', group: 'group-savings' },
  ] as CategoryEntity[];

  const wildcardGroups = [
    { id: 'group-bills', name: 'Bills' },
    { id: 'group-fun', name: 'Fun Money' },
    { id: 'group-savings', name: 'Savings' },
  ] as CategoryGroupEntity[];

  const allIds = wildcardCategories.map(category => category.id);

  function filterBy(op: string, value: unknown, field = 'category') {
    return filterCategoriesByConditions(
      wildcardCategories,
      wildcardGroups,
      [
        {
          field,
          op,
          value,
        } as RuleConditionEntity,
      ],
      'and',
    ).map(category => category.id);
  }

  // BUG-2. On the buggy head these return only the categories whose name
  // contains a literal '%' / '?', which for this fixture is one category or
  // none — the report renders 0.00 while the query fetched everything.
  it('keeps every category for a bare % , as the query does', () => {
    // The query compiles this to the pattern '%%%', which matches any name.
    expect(filterBy('contains', '%')).toEqual(allIds);
  });

  it('keeps every category for a bare ? , as the query does', () => {
    expect(filterBy('contains', '?')).toEqual(allIds);
  });

  it('reads a backslash-escaped % as a literal, so it does narrow', () => {
    // '\%' compiles to an escaped wildcard - a literal percent sign - so this
    // is an ordinary narrowing filter. A fix that escaped the user's wildcards
    // would agree here but reintroduce the loss in the other direction.
    expect(filterBy('contains', '\\%')).toEqual(['c-discount']);
  });

  it('treats an embedded wildcard as a pattern, not as a literal', () => {
    // '%o%%' matches any name containing an 'o'. It is NOT required to keep
    // every category: on the data side this narrows, and the axis must agree.
    expect(filterBy('contains', 'o%')).toEqual([
      'c-food',
      'c-groceries',
      'c-discount',
    ]);
  });

  it('treats _ as a literal, not as a wildcard', () => {
    // '_' is not a wildcard in UNICODE_LIKE. A QA report claimed it reproduced
    // the same defect as '%'; it does not, and the axis and query already agree
    // on it. Escaping it here would create a divergence that does not exist.
    expect(filterBy('contains', '_')).toEqual(['c-underscore']);
    expect(filterBy('contains', 'C_')).toEqual(['c-underscore']);
  });

  it('folds diacritics the way the query does', () => {
    // NORMALISE strips the accent on the data side; a bare toLowerCase() on the
    // axis side does not, which drops 'Café' out of a filtered report.
    expect(filterBy('contains', 'cafe')).toEqual(['c-cafe']);
    expect(filterBy('contains', 'café')).toEqual(['c-cafe']);
    expect(filterBy('contains', 'e')).toEqual(['c-groceries', 'c-cafe']);
  });

  it('negates the same pattern for doesNotContain', () => {
    // The query's $notlike carries an `OR left IS NULL` disjunct, which never
    // fires for a category name - so the negation of the positive test is exact.
    expect(filterBy('doesNotContain', '%')).toEqual([]);
    expect(filterBy('doesNotContain', '?')).toEqual([]);
    expect(filterBy('doesNotContain', 'o')).toEqual(['c-cafe', 'c-underscore']);
  });

  it('still narrows an ordinary substring', () => {
    // The negative control: a fix that made every text condition a no-op would
    // pass the wildcard cases above and fail here.
    expect(filterBy('contains', 'oo')).toEqual(['c-food']);
    expect(filterBy('contains', 'BILL')).toEqual([]);
  });

  it('narrows the category_group text path the same way', () => {
    expect(filterBy('contains', '%', 'category_group')).toEqual(allIds);
    expect(filterBy('contains', 'Fun', 'category_group')).toEqual([
      'c-food',
      'c-groceries',
    ]);
  });

  it('leaves `matches` alone: it is neither the bug nor in scope', () => {
    // `matches` compiles to $regexp, not to LIKE, and every divergence between
    // the two is axis-WIDER - the axis's regex carries /i and the query's does
    // not, so the axis keeps rows the query dropped, which costs an empty row
    // and never money. Pinned so it is checkable rather than argued.
    expect(filterBy('matches', 'RE')).toEqual([]);
    expect(
      filterCategoriesByConditions(
        categories,
        categoryGroups,
        [
          {
            field: 'category',
            op: 'matches',
            value: 'RE',
          } as RuleConditionEntity,
        ],
        'and',
      ).map(category => category.id),
    ).toEqual(['cat-rent']);

    // The 256-character guard does NOT reject the value: the failed length test
    // skips the `if` and falls through to `return true`, keeping every category.
    expect(filterBy('matches', 'x'.repeat(257))).toEqual(allIds);
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

  // BUG-3. The gate below asks which FIELD a condition addresses, which is
  // necessary but not sufficient on its own: it also has to be true that the
  // axis and the query READ the condition the same way. For `contains '%'` they
  // did not - the axis looked for a literal percent sign, the query compiled a
  // pattern matching every name - so the gate returned true, the axis narrowed
  // to the oneOf branch, and the query's '%' arm fetched everything before the
  // axis threw it away.
  const cellsPlusBareWildcard = [
    { field: 'category', op: 'oneOf', value: ['c-rent', 'c-cell'] },
    { field: 'category', op: 'contains', value: '%' },
  ] as RuleConditionEntity[];

  it('keeps the full axis when a disjunct is `contains` with a bare wildcard', () => {
    // At the helper level: the union of the two disjuncts is every category,
    // because '%' matches every name on the query side.
    expect(
      filterCategoriesByConditions(
        axisCategories,
        axisGroups,
        cellsPlusBareWildcard,
        'or',
      ).map(category => category.id),
    ).toEqual(['c-food', 'c-rent', 'c-cell', 'c-net']);
  });

  it('keeps the full axis through the gate for the same conditions', () => {
    const result = narrow(cellsPlusBareWildcard, 'or');

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
