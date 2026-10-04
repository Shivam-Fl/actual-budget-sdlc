// @ts-strict-ignore
import { v4 as uuidv4 } from 'uuid';

import type { TransactionEntity } from '#types/models';

import {
  addSplitTransaction,
  deleteTransaction,
  isPreviewId,
  makeAsNonChildTransactions,
  makeChild,
  makeEmptySplitSubtransactions,
  parsePreviewId,
  splitTransaction,
  updateTransaction,
} from './transactions';

function makeTransaction(data: Partial<TransactionEntity>): TransactionEntity {
  return {
    id: uuidv4(),
    amount: 2422,
    date: '2020-01-05',
    account: 'acc-id-1',
    ...data,
  };
}

function makeSplitTransaction(data, children) {
  const parent = makeTransaction({ ...data, is_parent: true });
  return [parent, ...children.map(t => makeChild(parent, t))];
}

function splitError(amount: number) {
  return { difference: amount, type: 'SplitTransactionError', version: 1 };
}

describe('Transactions', () => {
  describe('parsePreviewId', () => {
    test('returns the schedule id and occurrence date of a preview id', () => {
      expect(parsePreviewId('preview/schedule-abc/2026-10-09')).toEqual({
        scheduleId: 'schedule-abc',
        date: '2026-10-09',
      });
    });

    test('returns no date for a bare id, so callers keep their next_date fallback', () => {
      expect(parsePreviewId('schedule-abc')).toEqual({
        scheduleId: 'schedule-abc',
      });
      expect(parsePreviewId('schedule-abc').date).toBeUndefined();
    });

    test('agrees with isPreviewId on which ids carry a date', () => {
      const ids = [
        'preview/schedule-abc/2026-10-09',
        'schedule-abc',
        'a-real-transaction-id',
      ];

      for (const id of ids) {
        expect(parsePreviewId(id).date != null).toBe(isPreviewId(id));
      }
    });

    test('falls back to no date for a preview id with no date segment', () => {
      expect(parsePreviewId('preview/schedule-abc')).toEqual({
        scheduleId: 'schedule-abc',
      });
    });
  });

  test('updating a transaction works', () => {
    const transactions = [
      makeTransaction({ amount: 5000 }),
      makeTransaction({ id: 't1', amount: 4000 }),
      makeTransaction({ amount: 3000 }),
    ];
    const { data, diff } = updateTransaction(
      transactions,
      makeTransaction({
        id: 't1',
        amount: 5000,
      }),
    );
    expect(data.find(d => d.subtransactions)).toBeFalsy();
    expect(diff).toEqual({
      added: [],
      deleted: [],
      updated: [expect.objectContaining({ id: 't1', amount: 5000 })],
    });
    expect(
      data
        .map(t => ({ id: t.id, amount: t.amount }))
        .sort(
          (a, b) =>
            b.amount - a.amount || String(a.id).localeCompare(String(b.id)),
        ),
    ).toEqual([
      { id: expect.any(String), amount: 5000 },
      { id: 't1', amount: 5000 },
      { id: expect.any(String), amount: 3000 },
    ]);
  });

  test('updating does nothing if value not changed', () => {
    const updatedTransaction = makeTransaction({ id: 't1', amount: 5000 });
    const transactions = [
      updatedTransaction,
      makeTransaction({ amount: 3000 }),
    ];
    const { data, diff } = updateTransaction(transactions, updatedTransaction);
    expect(diff).toEqual({ added: [], deleted: [], updated: [] });
    expect(
      data
        .map(t => ({ id: t.id, amount: t.amount }))
        .sort(
          (a, b) =>
            b.amount - a.amount || String(a.id).localeCompare(String(b.id)),
        ),
    ).toEqual([
      { id: expect.any(String), amount: 5000 },
      { id: expect.any(String), amount: 3000 },
    ]);
  });

  test('deleting a transaction works', () => {
    const transactions = [
      makeTransaction({ amount: 5000 }),
      makeTransaction({ id: 't1', amount: 4000 }),
      makeTransaction({ amount: 3000 }),
    ];
    const { data, diff } = deleteTransaction(transactions, 't1');

    expect(diff).toEqual({
      added: [],
      deleted: [{ id: 't1' }],
      updated: [],
    });
    expect(
      data
        .map(t => ({ id: t.id, amount: t.amount }))
        .sort(
          (a, b) =>
            b.amount - a.amount || String(a.id).localeCompare(String(b.id)),
        ),
    ).toEqual([
      { id: expect.any(String), amount: 5000 },
      { id: expect.any(String), amount: 3000 },
    ]);
  });

  test('splitting a transaction works', () => {
    const transactions = [
      makeTransaction({ id: 't1', amount: 5000, payee: 'payee-id' }),
      makeTransaction({ amount: 3000 }),
    ];
    const { data, diff } = splitTransaction(transactions, 't1');
    expect(data.find(d => d.subtransactions)).toBeFalsy();

    expect(diff).toEqual({
      added: [expect.objectContaining({ amount: 0, parent_id: 't1' })],
      deleted: [],
      updated: [
        {
          id: 't1',
          is_parent: true,
          payee: null,
          error: splitError(5000),
        },
      ],
    });
    expect(data).toEqual([
      expect.objectContaining({
        id: 't1',
        amount: 5000,
        error: splitError(5000),
        payee: null,
      }),
      expect.objectContaining({
        parent_id: 't1',
        amount: 0,
        payee: 'payee-id',
      }),
      expect.objectContaining({ amount: 3000 }),
    ]);
  });

  test('makeEmptySplitSubtransactions assigns distinct descending sort orders', () => {
    const parent = makeTransaction({
      id: 't1',
      amount: 5000,
      sort_order: 1234,
    });
    const children = makeEmptySplitSubtransactions(parent);

    expect(children).toHaveLength(2);
    expect(children.every(c => c.parent_id === 't1')).toBe(true);
    expect(children.map(c => c.sort_order)).toEqual([-1, -2]);
  });

  test('splitting respects explicit child sort orders', () => {
    const transactions = [makeTransaction({ id: 't1', amount: 5000 })];
    const { data } = splitTransaction(transactions, 't1', parent => [
      makeChild(parent, { sort_order: -10 }),
      makeChild(parent, { sort_order: -20 }),
    ]);

    const children = data.filter(t => t.parent_id === 't1');
    expect(children.map(t => t.sort_order)).toEqual([-10, -20]);
  });

  test('adding a split transaction works', () => {
    const transactions = [
      makeTransaction({ amount: 2001 }),
      ...makeSplitTransaction({ id: 't1', amount: 2500 }, [
        { id: 't2', amount: 2000 },
        { id: 't3', amount: 500 },
      ]),
      makeTransaction({ amount: 3002 }),
    ];

    expect(transactions.filter(t => t.parent_id === 't1').length).toBe(2);

    // Should be able to pass in any id from the split trans
    const { data, diff } = addSplitTransaction(transactions, 't1');
    expect(data.find(d => d.subtransactions)).toBeFalsy();

    expect(data.filter(t => t.parent_id === 't1').length).toBe(3);
    expect(diff).toEqual({
      added: [
        expect.objectContaining({
          id: expect.any(String),
          amount: 0,
          parent_id: 't1',
        }),
      ],
      deleted: [],
      updated: [],
    });
    expect(data.length).toBe(6);
  });

  test('adding a split transaction reuses the previous child payee', () => {
    const transactions = [
      ...makeSplitTransaction({ id: 't1', amount: 2500, payee: null }, [
        { id: 't2', amount: 2000, payee: 'payee-id' },
      ]),
    ];

    const { diff } = addSplitTransaction(transactions, 't1');

    expect(diff.added).toEqual([
      expect.objectContaining({
        amount: 0,
        parent_id: 't1',
        payee: 'payee-id',
      }),
    ]);
  });

  test('updating a split transaction works', () => {
    const transactions = [
      makeTransaction({ amount: 2001 }),
      ...makeSplitTransaction({ id: 't1', amount: 2500 }, [
        { id: 't2', amount: 2000 },
        { id: 't3', amount: 500 },
      ]),
      makeTransaction({ amount: 3002 }),
    ];
    const { data, diff } = updateTransaction(
      transactions,
      makeTransaction({
        id: 't2',
        amount: 2200,
      }),
    );
    expect(data.find(d => d.subtransactions)).toBeFalsy();
    expect(diff).toEqual({
      added: [],
      deleted: [],
      updated: [
        { id: 't1', error: splitError(-200) },
        { id: 't2', amount: 2200 },
      ],
    });
    expect(data.length).toBe(5);
  });

  test('partially updating a split parent preserves amount and does not set error', () => {
    const transactions = [
      makeTransaction({ amount: 2001 }),
      ...makeSplitTransaction({ id: 't1', amount: 2500 }, [
        { id: 't2', amount: 2000 },
        { id: 't3', amount: 500 },
      ]),
      makeTransaction({ amount: 3002 }),
    ];

    // Simulate a partial update (only `notes`) on the parent — this is
    // how `api.updateTransaction(id, { notes: '...' })` calls it in
    // `api.ts`: `updateTransaction(transactions, { id, ...fields })`.
    const { data, diff } = updateTransaction(transactions, {
      id: 't1',
      notes: 'updated note',
    } as TransactionEntity);

    // The parent should get the updated notes without an error
    const parent = data.find(d => d.id === 't1');
    expect(parent?.notes).toBe('updated note');
    expect(parent?.amount).toBe(2500);
    expect(parent?.error).toBeNull();

    // Children should be unchanged
    expect(data.filter(t => t.parent_id === 't1').length).toBe(2);

    expect(diff).toEqual({
      added: [],
      deleted: [],
      updated: [expect.objectContaining({ id: 't1', notes: 'updated note' })],
    });
  });

  test('deleting a split transaction works', () => {
    const transactions = [
      makeTransaction({ amount: 2001 }),
      ...makeSplitTransaction({ id: 't1', amount: 2500 }, [
        { id: 't2', amount: 2000 },
        { id: 't3', amount: 500 },
      ]),
      makeTransaction({ amount: 3002 }),
    ];
    const { data, diff } = deleteTransaction(transactions, 't2');

    expect(diff).toEqual({
      added: [],
      deleted: [expect.objectContaining({ id: 't2' })],
      updated: [{ id: 't1', error: splitError(2000) }],
    });
    expect(data).toEqual([
      expect.objectContaining({ amount: 2001 }),
      expect.objectContaining({
        amount: 2500,
        is_parent: true,
        error: splitError(2000),
      }),
      expect.objectContaining({ amount: 500, parent_id: 't1' }),
      expect.objectContaining({ amount: 3002 }),
    ]);
  });

  test('deleting all child split transactions works', () => {
    const transactions = [
      makeTransaction({ amount: 2001 }),
      ...makeSplitTransaction(
        { id: 't1', amount: 2500, error: splitError(500) },
        [{ id: 't2', amount: 2000 }],
      ),
      makeTransaction({ amount: 3002 }),
    ];
    const { data } = deleteTransaction(transactions, 't2');

    expect(data).toEqual([
      expect.objectContaining({ amount: 2001 }),
      // Must delete error if no children
      expect.objectContaining({ amount: 2500, error: null }),
      expect.objectContaining({ amount: 3002 }),
    ]);
  });

  test('unlocking a reconciled split transaction propagates to children', () => {
    const transactions = [
      makeTransaction({ amount: 2001 }),
      ...makeSplitTransaction({ id: 't1', amount: 2500, reconciled: true }, [
        { id: 't2', amount: 2000, reconciled: true },
        { id: 't3', amount: 500, reconciled: true },
      ]),
      makeTransaction({ amount: 3002 }),
    ];

    const { data, diff } = updateTransaction(transactions, {
      ...transactions.find(t => t.id === 't1')!,
      reconciled: false,
    });

    const children = data.filter(t => t.parent_id === 't1');
    expect(children).toHaveLength(2);
    expect(children.every(t => t.reconciled === false)).toBe(true);

    expect(diff.updated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 't1', reconciled: false }),
        expect.objectContaining({ id: 't2', reconciled: false }),
        expect.objectContaining({ id: 't3', reconciled: false }),
      ]),
    );
  });

  test('unsplitting last remaining child converts parent to regular transaction', () => {
    const [parent, child] = makeSplitTransaction(
      { id: 't1', amount: 2000, category: 'cat1' },
      [{ id: 't2', amount: 0, category: 'cat2' }],
    );

    const transactions = [parent, child];

    const result = makeAsNonChildTransactions([child], transactions);

    expect(result.updated).toHaveLength(1);
    expect(result.deleted).toHaveLength(1);

    expect(result.updated[0]).toMatchObject({
      id: 't1',
      amount: 2000,
      is_parent: false,
      category: 'cat2',
    });

    expect(result.deleted[0]).toMatchObject({
      id: 't2',
    });
  });

  // A parent may only be deleted when the rows replacing it account for it.
  // A split opened from the register starts as two 0.00 children, so the child
  // COUNT says the parent is safe to delete while the amounts say it is the only
  // row carrying any value — and, when it came from a schedule, the occurrence
  // stamp with it.
  describe('unsplitting a split', () => {
    // The pair the register's Category-cell Split actually produces: two
    // children the user never typed into, and a parent still holding the whole
    // amount and, if it came from a schedule, its occurrence stamp.
    function makeUnfilledSplit() {
      return makeSplitTransaction(
        {
          id: 'p',
          amount: 12345,
          category: 'cat1',
          schedule: 'sched-1',
          schedule_occurrence: '2024-03-10',
          error: splitError(12345),
        },
        [
          { id: 'c1', amount: 0, category: null },
          { id: 'c2', amount: 0, category: null },
        ],
      );
    }

    // `result.updated` and `result.deleted` reduced to [id, amount] pairs, which
    // is what these cases are actually about: which rows survive, at what
    // amount. Anything else on the row is covered elsewhere.
    function asRows(transactions) {
      return transactions.map(({ id, amount }) => [id, amount]);
    }

    test('keeps the parent and its amount when the children were never filled in', () => {
      const transactions = makeUnfilledSplit();

      const result = makeAsNonChildTransactions(
        [transactions[1], transactions[2]],
        transactions,
      );

      expect(asRows(result.updated)).toEqual([['p', 12345]]);
      expect(asRows(result.deleted)).toEqual([
        ['c1', 0],
        ['c2', 0],
      ]);
      // Narrowing only `deleteParentTransaction` would stop the amount loss but
      // leave the row a split parent with no children, which the register still
      // renders as part of a split.
      expect(result.updated[0]).toMatchObject({
        id: 'p',
        is_parent: false,
      });
    });

    test('leaves the occurrence stamp on the surviving row', () => {
      // Asserted directly rather than inferred from the amount: the stamp is
      // what keeps /schedules reading this occurrence Paid instead of Due.
      const transactions = makeUnfilledSplit();

      const result = makeAsNonChildTransactions(
        [transactions[1], transactions[2]],
        transactions,
      );

      expect(result.updated[0]).toMatchObject({
        schedule: 'sched-1',
        schedule_occurrence: '2024-03-10',
      });
    });

    test('carries no stale split error on the surviving row', () => {
      const transactions = makeUnfilledSplit();

      const result = makeAsNonChildTransactions(
        [transactions[1], transactions[2]],
        transactions,
      );

      // The row is no longer part of a split and its amount is correct, so the
      // split error the parent was carrying must not survive onto it.
      expect(result.updated[0].error).toBeNull();
    });

    test('still splits out a filled split when both children are unsplit', () => {
      const transactions = makeSplitTransaction({ id: 'p', amount: 12345 }, [
        { id: 'c1', amount: 5000 },
        { id: 'c2', amount: 7345 },
      ]);

      const result = makeAsNonChildTransactions(
        [transactions[1], transactions[2]],
        transactions,
      );

      expect(asRows(result.updated)).toEqual([
        ['c1', 5000],
        ['c2', 7345],
      ]);
      expect(asRows(result.deleted)).toEqual([['p', 12345]]);
    });

    test('still splits out a filled split when ONE of two children is unsplit', () => {
      // The regression case for the guard's set. The rows that will exist after
      // the unsplit are the selected child PLUS the one remaining child (the
      // function appends it when exactly one is left), so the guard must sum
      // those, not the selection. Summing the selection alone reads 5000 as
      // short of 12345 and collapses a correctly filled split into one 12345
      // parent carrying the selected child's category — with BOTH children
      // deleted, including the one the user never selected.
      const transactions = makeSplitTransaction({ id: 'p', amount: 12345 }, [
        { id: 'c1', amount: 5000 },
        { id: 'c2', amount: 7345 },
      ]);

      const result = makeAsNonChildTransactions(
        [transactions[1]],
        transactions,
      );

      expect(asRows(result.updated)).toEqual([
        ['c1', 5000],
        ['c2', 7345],
      ]);
      expect(asRows(result.deleted)).toEqual([['p', 12345]]);
    });

    test('still splits out a filled split when one child of 4000/4345 is unsplit', () => {
      // Same shape, different numbers, so a guard comparing only the selected
      // total against the parent cannot pass by coincidence.
      const transactions = makeSplitTransaction({ id: 'p', amount: 8345 }, [
        { id: 'c1', amount: 4000 },
        { id: 'c2', amount: 4345 },
      ]);

      const result = makeAsNonChildTransactions(
        [transactions[1]],
        transactions,
      );

      expect(asRows(result.updated)).toEqual([
        ['c1', 4000],
        ['c2', 4345],
      ]);
      expect(asRows(result.deleted)).toEqual([['p', 8345]]);
    });

    test('leaves the parent in place when one child of a filled three-child split is unsplit', () => {
      // Two children remain, so the parent is not deleted at all and the
      // promoted set is never summed — this is the second arm of that
      // property, not the one that catches the regression above.
      const transactions = makeSplitTransaction({ id: 'p', amount: 12345 }, [
        { id: 'c1', amount: 4000 },
        { id: 'c2', amount: 4000 },
        { id: 'c3', amount: 4345 },
      ]);

      const result = makeAsNonChildTransactions(
        [transactions[1]],
        transactions,
      );

      // The parent is reduced to what the children still account for.
      expect(asRows(result.updated)).toEqual([
        ['p', 8345],
        ['c1', 4000],
      ]);
      expect(result.deleted).toEqual([]);
    });

    test('keeps the parent at its full amount when two of three partly-typed children are unsplit', () => {
      // A product judgement, pinned so it is visible rather than incidental:
      // 5000 + 4000 + 0 does not account for 12345, so the parent survives
      // intact and the typed 9000 is discarded. Today's behaviour loses 2345
      // instead by keeping the 9000 and deleting the parent. Both lose money.
      const transactions = makeSplitTransaction({ id: 'p', amount: 12345 }, [
        { id: 'c1', amount: 5000 },
        { id: 'c2', amount: 4000 },
        { id: 'c3', amount: 0 },
      ]);

      const result = makeAsNonChildTransactions(
        [transactions[1], transactions[2]],
        transactions,
      );

      expect(asRows(result.updated)).toEqual([['p', 12345]]);
      expect(asRows(result.deleted)).toEqual([
        ['c1', 5000],
        ['c2', 4000],
        ['c3', 0],
      ]);
    });
  });

  test('converting a simple transaction into a split stamps children with the parent account (#8207)', () => {
    const transactions = [
      makeTransaction({ amount: 2001 }),
      makeTransaction({ id: 't1', amount: 5000, account: 'acc-id-1' }),
      makeTransaction({ amount: 3002 }),
    ];

    // Mirrors `api.updateTransaction(id, { subtransactions: [...] })`, which
    // reaches this reducer as `updateTransaction(transactions, { id, ...fields })`
    // (see `api/transaction-update` in server/api.ts).
    const { data, diff } = updateTransaction(transactions, {
      id: 't1',
      subtransactions: [{ amount: 4000 }, { amount: 1000 }],
    } as TransactionEntity);

    const parent = data.find(d => d.id === 't1');
    expect(parent?.is_parent).toBe(true);

    const children = data.filter(t => t.parent_id === 't1');
    expect(children).toHaveLength(2);
    // Regression (#8207): children used to be emitted without an account/date,
    // so the DB rejected the insert with
    // `"account" is required for table "transactions"`.
    for (const child of children) {
      expect(child.account).toBe('acc-id-1');
      expect(child.date).toBe('2020-01-05');
      expect(child.is_child).toBe(true);
      expect(child.parent_id).toBe('t1');
    }
    expect(children.map(c => c.amount).sort((a, b) => b - a)).toEqual([
      4000, 1000,
    ]);

    // The new child rows are inserted, and every one must carry the account.
    expect(diff.added).toHaveLength(2);
    expect(diff.added.every(t => t.account === 'acc-id-1')).toBe(true);
  });
});
