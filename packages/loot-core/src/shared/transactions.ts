import { v4 as uuidv4 } from 'uuid';

import { logger } from '#platform/server/log';
import type { TransactionEntity } from '#types/models';

import { applyChanges, diffItems, last } from './util';

export function isTemporaryId(id: string) {
  return id.indexOf('temp') !== -1;
}

export function isPreviewId(id: string) {
  return id.indexOf('preview/') !== -1;
}

/**
 * Splits a scheduled-transaction row id into the schedule it belongs to and
 * the occurrence date it represents.
 *
 * Preview rows are id'd `preview/<scheduleId>/<YYYY-MM-DD>` (see
 * computeSchedulePreviewTransactions), so the occurrence the user clicked is
 * only recoverable from the id — callers that truncate it to the schedule id
 * lose which occurrence was chosen. A bare id is already a schedule id and has
 * no occurrence date.
 */
export function parsePreviewId(id: string): {
  scheduleId: string;
  date?: string;
} {
  if (!isPreviewId(id)) {
    return { scheduleId: id };
  }

  const parts = id.split('/');
  return parts[2] == null
    ? { scheduleId: parts[1] }
    : { scheduleId: parts[1], date: parts[2] };
}

// The amount might be null when adding a new transaction
function num(n: number | null | undefined) {
  return typeof n === 'number' ? n : 0;
}

function SplitTransactionError(total: number, parent: TransactionEntity) {
  const difference = num(parent.amount) - total;

  return {
    type: 'SplitTransactionError' as const,
    version: 1 as const,
    difference,
  };
}

type GenericTransactionEntity = TransactionEntity;

export function makeChild<T extends GenericTransactionEntity>(
  parent: T,
  data: object = {},
) {
  const prefix = parent.id === 'temp' ? 'temp' : '';

  return {
    amount: 0,
    ...data,
    category: 'category' in data ? data.category : parent.category,
    payee: 'payee' in data ? data.payee : parent.payee,
    id: 'id' in data ? data.id : prefix + uuidv4(),
    account: parent.account,
    date: parent.date,
    cleared: parent.cleared != null ? parent.cleared : null,
    reconciled: parent.reconciled != null ? parent.reconciled : null,
    starting_balance_flag:
      parent.starting_balance_flag != null
        ? parent.starting_balance_flag
        : null,
    sort_order:
      'sort_order' in data ? data.sort_order : (parent.sort_order ?? null),
    is_child: true,
    parent_id: parent.id,
    error: null,
  } as unknown as T;
}

export function makeEmptySplitSubtransactions(
  parent: TransactionEntity,
): TransactionEntity[] {
  return [
    makeChild(parent, { sort_order: -1 }),
    makeChild(parent, { sort_order: -2 }),
  ];
}

function makeNonChild<T extends GenericTransactionEntity>(
  parent: T,
  data: object,
) {
  return {
    amount: 0,
    ...data,
    cleared: parent.cleared != null ? parent.cleared : null,
    reconciled: parent.reconciled != null ? parent.reconciled : null,
    sort_order: parent.sort_order ?? null,
    starting_balance_flag: null,
    is_child: false,
    parent_id: null,
  } as unknown as T;
}

function makeTransactionWithChildCategory<T extends GenericTransactionEntity>(
  parent: T,
  data: Partial<TransactionEntity>,
  promotedRows: readonly Partial<TransactionEntity>[] = [data],
) {
  return {
    ...parent,
    is_parent: false,
    category: data.category || null,
    // A survivor rebuilt from a split parent carries that parent's `payee:
    // null`, which `splitTransaction` sets on every parent when the split opens
    // because it moves the payee down onto the children. The row is not lost and
    // its amount is right, but it renders blank and drops out of any view
    // filtered by payee. So the payee comes from the rows this survivor actually
    // absorbs — the first of them that carries one.
    //
    // Not from `data`. `data` is the row the CATEGORY comes from, and the two
    // provenances genuinely differ: a leg whose payee was deliberately cleared
    // can be the first promoted row while the leg folded in beside it is the
    // only one carrying a payee. Reading `data` alone returns null on that
    // shape. The parent fallback is not dead code either — a parent can keep a
    // non-null payee beneath children that were explicitly cleared, and on that
    // shape the scan finds nothing and this is what returns the parent's payee.
    payee: promotedRows.find(t => t.payee)?.payee ?? parent.payee,
  } as unknown as T;
}

export function recalculateSplit(trans: TransactionEntity) {
  // Calculate the new total of split transactions and make sure
  // that it equals the parent amount
  const total = (trans.subtransactions || []).reduce(
    (acc, t) => acc + num(t.amount),
    0,
  );

  const { error: _error, ...rest } = trans;
  return {
    ...rest,
    error:
      total === num(trans.amount) ? null : SplitTransactionError(total, trans),
  } satisfies TransactionEntity;
}

function findParentIndex(
  transactions: readonly TransactionEntity[],
  idx: number,
) {
  // This relies on transactions being sorted in a way where parents
  // are always before children, which is enforced in the db layer.
  // Walk backwards and find the last parent;
  while (idx >= 0) {
    const trans = transactions[idx];
    if (trans.is_parent) {
      return idx;
    }
    idx--;
  }
  return null;
}

function getSplit(
  transactions: readonly TransactionEntity[],
  parentIndex: number,
) {
  const split = [transactions[parentIndex]];
  let curr = parentIndex + 1;
  while (curr < transactions.length && transactions[curr].is_child) {
    split.push(transactions[curr]);
    curr++;
  }
  return split;
}

export function ungroupTransactions(transactions: TransactionEntity[]) {
  return transactions.reduce<TransactionEntity[]>((list, parent) => {
    const { subtransactions, ...trans } = parent;
    const _subtransactions = subtransactions || [];

    list.push(trans);

    for (let i = 0; i < _subtransactions.length; i++) {
      list.push(_subtransactions[i]);
    }
    return list;
  }, []);
}

export function groupTransaction(
  split: TransactionEntity[],
): TransactionEntity {
  return {
    ...split[0],
    subtransactions: split.slice(1),
  } satisfies TransactionEntity;
}

export function ungroupTransaction(split: TransactionEntity | null) {
  if (split == null) {
    return [];
  }
  return ungroupTransactions([split]);
}

export function applyTransactionDiff(
  groupedTrans: Parameters<typeof ungroupTransaction>[0],
  diff: Parameters<typeof applyChanges>[0],
) {
  return groupTransaction(
    applyChanges(
      diff,
      ungroupTransaction(groupedTrans) || [],
    ) as TransactionEntity[],
  );
}

function replaceTransactions(
  transactions: readonly TransactionEntity[],
  id: string,
  func: (transaction: TransactionEntity) => TransactionEntity | null,
): {
  data: TransactionEntity[];
  newTransaction: TransactionEntity | null;
  diff: ReturnType<typeof diffItems<TransactionEntity>>;
} {
  const idx = transactions.findIndex(t => t.id === id);
  const trans = transactions[idx];
  const transactionsCopy = [...transactions];

  if (idx === -1) {
    throw new Error('Tried to edit unknown transaction id: ' + id);
  }

  if (trans.is_parent || trans.is_child) {
    const parentIndex = findParentIndex(transactions, idx);
    if (parentIndex == null) {
      logger.log('Cannot find parent index');
      return {
        data: [],
        diff: { added: [], deleted: [], updated: [] },
        newTransaction: null,
      };
    }

    const split = getSplit(transactions, parentIndex);
    let grouped = func(groupTransaction(split));
    const newSplit = ungroupTransaction(grouped);

    let diff: ReturnType<typeof diffItems<TransactionEntity>>;
    if (newSplit == null) {
      // If everything was deleted, just delete the parent which will
      // delete everything
      diff = { added: [], deleted: [{ id: split[0].id }], updated: [] };
      grouped = { ...split[0], _deleted: true };
      transactionsCopy.splice(parentIndex, split.length);
    } else {
      diff = diffItems<TransactionEntity>(split, newSplit);
      transactionsCopy.splice(parentIndex, split.length, ...newSplit);
    }

    return { data: transactionsCopy, newTransaction: grouped, diff };
  } else {
    const grouped = func(trans);
    const newTrans = ungroupTransaction(grouped) || [];
    if (grouped) {
      grouped.subtransactions = grouped.subtransactions || [];
    }
    transactionsCopy.splice(idx, 1, ...newTrans);

    return {
      data: transactionsCopy,
      newTransaction: grouped || {
        ...trans,
        _deleted: true,
      },
      diff: diffItems<TransactionEntity>([trans], newTrans),
    };
  }
}

export function addSplitTransaction(
  transactions: readonly TransactionEntity[],
  id: string,
) {
  return replaceTransactions(transactions, id, trans => {
    if (!trans.is_parent) {
      return trans;
    }
    const prevSub = last(trans.subtransactions || []);
    trans.subtransactions?.push(
      makeChild(trans, {
        amount: 0,
        payee: prevSub?.payee ?? trans.payee,
        sort_order: num(prevSub && prevSub.sort_order) - 1,
      }),
    );
    return trans;
  });
}

export function updateTransaction(
  transactions: readonly TransactionEntity[],
  transaction: TransactionEntity,
) {
  return replaceTransactions(transactions, transaction.id, trans => {
    if (trans.is_parent) {
      const parent =
        trans.id === transaction.id ? { ...trans, ...transaction } : trans;
      const originalSubtransactions =
        parent.subtransactions ?? trans.subtransactions;
      const sub = originalSubtransactions?.map(t => {
        // Make sure to update the children to reflect the updated
        // properties (if the parent updated)

        let child = t;
        if (trans.id === transaction.id) {
          const { payee: childPayee, ...rest } = t;
          const newPayee =
            childPayee === trans.payee ? transaction.payee : childPayee;
          child = {
            ...rest,
            ...(newPayee != null ? { payee: newPayee } : {}),
          };
        } else if (t.id === transaction.id) {
          child = transaction;
        }

        return makeChild(parent, child);
      });

      return recalculateSplit({
        ...parent,
        ...(sub && { subtransactions: sub }),
      });
    } else if (
      transaction.subtransactions &&
      transaction.subtransactions.length > 0
    ) {
      // Converting a simple (non-split) transaction into a split — e.g.
      // `api.updateTransaction(id, { subtransactions: [...] })`. Mark it as a
      // parent and materialise each subtransaction as a proper child so it
      // inherits the parent's account/date; otherwise the children are inserted
      // without an `account` and the DB rejects them (#8207).
      const parent = {
        ...trans,
        ...transaction,
        is_parent: true,
        is_child: false,
        parent_id: undefined,
      };
      return recalculateSplit({
        ...parent,
        subtransactions: transaction.subtransactions.map((sub, index) =>
          makeChild(parent, {
            ...sub,
            sort_order: sub.sort_order ?? -(index + 1),
          }),
        ),
      });
    } else {
      return transaction;
    }
  });
}

export function deleteTransaction(
  transactions: TransactionEntity[],
  id: string,
) {
  return replaceTransactions(transactions, id, trans => {
    if (trans.is_parent) {
      if (trans.id === id) {
        return null;
      } else if (trans.subtransactions?.length === 1) {
        const { subtransactions: _subtransactions, ...rest } = trans;
        return {
          ...rest,
          is_parent: false,
          error: null,
          // The row that survives is the one leg this collapse leaves behind,
          // so it takes that leg's payee. The parent spread above cannot supply
          // it: `splitTransaction` moved the payee down onto the children when
          // the split opened and set the parent's own to null, so without this
          // the survivor comes back payee-less at the right amount — rendering
          // blank and dropping out of any view filtered by the payee. There is
          // exactly one leg here, so `??` rather than a scan.
          payee: _subtransactions[0].payee ?? rest.payee,
        } satisfies TransactionEntity;
      } else {
        const sub = trans.subtransactions?.filter(t => t.id !== id);
        return recalculateSplit({
          ...trans,
          ...(sub && { subtransactions: sub }),
        });
      }
    } else {
      return null;
    }
  });
}

export function splitTransaction(
  transactions: readonly TransactionEntity[],
  id: string,
  createSubtransactions?: (
    parentTransaction: TransactionEntity,
  ) => TransactionEntity[],
) {
  return replaceTransactions(transactions, id, trans => {
    if (trans.is_parent || trans.is_child) {
      return trans;
    }

    const subtransactions = createSubtransactions?.(trans) || [
      makeChild(trans),
    ];

    const { error: _error, ...rest } = trans;

    return {
      ...rest,
      is_parent: true,
      payee: null,
      error: num(trans.amount) === 0 ? null : SplitTransactionError(0, trans),
      subtransactions: subtransactions.map(t => ({
        ...t,
        sort_order: t.sort_order || -1,
      })),
    } satisfies TransactionEntity;
  });
}

export function realizeTempTransactions(
  transactions: TransactionEntity[],
): TransactionEntity[] {
  const parent = {
    ...transactions.find(t => !t.is_child),
    id: uuidv4(),
    sort_order: Date.now(),
  } as TransactionEntity;
  const children = transactions.filter(t => t.is_child);
  return [
    parent,
    ...children.map(
      child =>
        ({
          ...child,
          id: uuidv4(),
          parent_id: parent.id,
        }) satisfies TransactionEntity,
    ),
  ];
}

export function makeAsNonChildTransactions(
  childTransactionsToUpdate: TransactionEntity[],
  transactions: TransactionEntity[],
) {
  const [parentTransaction, ...childTransactions] = transactions;
  const newNonChildTransactions = childTransactionsToUpdate.map(t =>
    makeNonChild(parentTransaction, t),
  );

  const remainingChildTransactions = childTransactions.filter(
    t =>
      !newNonChildTransactions.some(updatedTrans => updatedTrans.id === t.id),
  );
  if (
    childTransactions.length === 1 &&
    childTransactionsToUpdate.length === 1 &&
    childTransactionsToUpdate[0].id === childTransactions[0].id
  ) {
    return {
      updated: [
        {
          ...makeTransactionWithChildCategory(
            parentTransaction,
            childTransactionsToUpdate[0],
            childTransactionsToUpdate,
          ),
          // The row is no longer part of a split, so it must not keep the
          // split error its child earned — the same clearing the branch below
          // does for the same end state.
          error: null,
        },
      ],
      deleted: [childTransactionsToUpdate[0]],
    };
  }

  const nonChildTransactionsToUpdate =
    remainingChildTransactions.length === 1
      ? [
          ...newNonChildTransactions,
          makeNonChild(parentTransaction, remainingChildTransactions[0]),
        ]
      : newNonChildTransactions;

  const deleteParentTransaction = remainingChildTransactions.length <= 1;

  // The parent may only be deleted when the rows that would replace it account
  // for it. The child count alone is not enough: a split opened from the
  // register starts as two 0.00 children, so the count says 'safe' while the
  // amounts say the parent is the only row carrying any value — and, if it came
  // from a schedule, the occurrence stamp with it. A shortfall says the same
  // thing: 5000 promoted against a 12345 parent leaves 7345 of the parent's own
  // value with nowhere to go, so it stays.
  //
  // `nonChildTransactionsToUpdate` — the selected children plus the one
  // remaining child when exactly one is left — is the set that will exist
  // afterwards, which is why the test is over it and not the selection.
  //
  // Two-sided, and deliberately not an equality test: children summing to MORE
  // than the parent account for it and more, and the user typed those amounts.
  // Collapsing them onto the parent destroys the surplus, so an overshoot
  // splits out exactly as it did before this guard existed.
  //
  // The comparison is on magnitudes. A signed `promotedTotal >= parentAmount`
  // reads -5000 >= -12345 as true for an under-filled expense, which is the
  // same destruction the guard exists to prevent.
  const promotedTotal = nonChildTransactionsToUpdate.reduce(
    (total, t) => total + num(t.amount),
    0,
  );
  const promotedRowsAreAllZero = nonChildTransactionsToUpdate.every(
    t => num(t.amount) === 0,
  );
  const promotedRowsAccountForParent =
    !promotedRowsAreAllZero &&
    Math.abs(promotedTotal) >= Math.abs(num(parentTransaction.amount));

  if (deleteParentTransaction && !promotedRowsAccountForParent) {
    return {
      updated: [
        {
          ...makeTransactionWithChildCategory(
            parentTransaction,
            newNonChildTransactions[0] ?? parentTransaction,
            nonChildTransactionsToUpdate,
          ),
          // The row is no longer part of a split and now carries the full
          // amount, so it must not keep the split error its children earned.
          error: null,
        },
      ],
      deleted: childTransactions,
    };
  }

  // When the parent survives it is the parent's OWN amount less what was
  // promoted out of it — not the sum of the children that stayed. The two are
  // identical on a correctly filled split (12345 - 4000 = 8345 = 4000 + 4345),
  // and differ exactly where summing destroys value: on an under-filled split
  // the sum drops the parent's shortfall, and on an overshooting one it invents
  // the surplus. Subtracting conserves the parent's money either way.
  const updatedParentTransaction = {
    ...parentTransaction,
    ...(!deleteParentTransaction
      ? { amount: num(parentTransaction.amount) - promotedTotal }
      : {}),
  };

  return {
    updated: [
      ...(!deleteParentTransaction ? [updatedParentTransaction] : []),
      ...nonChildTransactionsToUpdate,
    ],
    deleted: [...(deleteParentTransaction ? [updatedParentTransaction] : [])],
  };
}
