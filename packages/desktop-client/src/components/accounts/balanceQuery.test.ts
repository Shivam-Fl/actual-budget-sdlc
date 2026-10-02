import { q } from '@actual-app/core/shared/query';

import { getBalanceQuery } from './balanceQuery';

// Mirrors the query Account.tsx builds for the running balance, before the
// user's display sort is layered on top of it.
function makeQuery() {
  return q('transactions')
    .filter({ account: 'acct' })
    .select([{ balance: { $sumOver: '$amount' } }])
    .options({ splits: 'none' });
}

const expectedOrder = [{ date: 'desc' }, { sort_order: 'desc' }];

describe('getBalanceQuery', () => {
  it('replaces an ascending display sort with a newest-first window', () => {
    // The user sorted the list oldest-first. Left alone, the $sumOver window
    // would inherit that ordering and every balance would be wrong.
    const query = getBalanceQuery(makeQuery().orderBy({ date: 'asc' }));

    expect(query.serialize().orderExpressions).toEqual(expectedOrder);
  });

  it('replaces the whole ordering rather than appending to it', () => {
    // orderBy() appends, so appending the new ordering behind the user's
    // ascending sort leaves that sort in front of the window - still wrong.
    const appended = makeQuery()
      .orderBy({ date: 'asc' })
      .orderBy({ date: 'desc' })
      .orderBy({ sort_order: 'desc' })
      .serialize().orderExpressions;
    const result = getBalanceQuery(makeQuery().orderBy({ date: 'asc' }));

    expect(appended).toEqual([
      { date: 'asc' },
      { date: 'desc' },
      { sort_order: 'desc' },
    ]);
    expect(result.serialize().orderExpressions).not.toEqual(appended);
  });

  it('keeps the balance selection', () => {
    const query = getBalanceQuery(makeQuery().orderBy({ date: 'asc' }));

    expect(query.serialize().selectExpressions).toEqual([
      { balance: { $sumOver: '$amount' } },
    ]);
  });

  it('keeps every filter, so balances cover the rows the table shows', () => {
    const source = makeQuery()
      .filter({ reconciled: { $eq: false } })
      .orderBy({ date: 'asc' });

    const query = getBalanceQuery(source);

    expect(query.serialize().filterExpressions).toEqual(
      source.serialize().filterExpressions,
    );
  });

  it('orders an otherwise unordered query newest-first', () => {
    const query = getBalanceQuery(makeQuery());

    expect(query.serialize().orderExpressions).toEqual(expectedOrder);
  });

  it('leaves an already newest-first query alone', () => {
    // `applySort` always appends the `sort_order` tiebreaker, so this is the
    // shape the helper already receives for the direction that works today.
    const source = makeQuery()
      .orderBy({ date: 'desc' })
      .orderBy({ sort_order: 'desc' });

    const query = getBalanceQuery(source);

    expect(query.serialize().orderExpressions).toEqual(
      source.serialize().orderExpressions,
    );
  });

  it('carries the table options over unchanged', () => {
    const query = getBalanceQuery(makeQuery().orderBy({ date: 'asc' }));

    expect(query.serialize().tableOptions).toEqual({ splits: 'none' });
  });
});
