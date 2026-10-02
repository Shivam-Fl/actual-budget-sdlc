// @ts-strict-ignore
import { v4 as uuidv4 } from 'uuid';

import * as db from '#server/db';
import { q } from '#shared/query';
import { makeChild } from '#shared/transactions';

import * as aql from './exec';
import { schema, schemaConfig } from './schema';

beforeEach(global.emptyDatabase());

function repeat(arr, times) {
  let result = [];
  for (let i = 0; i < times; i++) {
    result = result.concat(arr);
  }
  return result;
}

function compileAndRunAqlQuery(query, options?: unknown) {
  return aql.compileAndRunAqlQuery(schema, schemaConfig, query, options);
}

async function insertTransactions(repeatTimes = 1) {
  let transactions = [];
  const group = await db.insertCategoryGroup({ name: 'group' });

  for (let i = 0; i < repeatTimes; i++) {
    const cat1 = await db.insertCategory({
      id: 'cat' + i + 'a',
      name: 'cat' + i + 'a',
      cat_group: group,
    });
    const cat2 = await db.insertCategory({
      id: 'cat' + i + 'b',
      name: 'cat' + i + 'b',
      cat_group: group,
    });

    const parent = {
      id: uuidv4(),
      account: 'acct',
      date: '2020-01-04',
      amount: -100,
      is_parent: true,
    };
    const parent2 = {
      id: uuidv4(),
      account: 'acct',
      date: '2020-01-01',
      amount: -89,
      is_parent: true,
    };

    transactions = transactions.concat([
      parent,
      makeChild(parent, { amount: -20, category: cat1 }),
      makeChild(parent, { amount: -5, category: cat1 }),
      makeChild(parent, { amount: -30, category: cat1 }),
      makeChild(parent, { amount: -45, category: cat2 }),
      parent2,
      makeChild(parent2, { amount: -9, category: cat2 }),
      makeChild(parent2, { amount: -80, category: cat1 }),
      { account: 'acct', date: '2020-01-03', amount: -53, category: cat1 },
    ]);
  }

  for (const trans of transactions) {
    await db.insertTransaction(trans);
  }
}

describe('compileAndRunQuery', () => {
  it('converts output types', async () => {
    await insertTransactions();

    // date
    let { data } = await compileAndRunAqlQuery(
      q('transactions').select('date').serialize(),
    );
    expect(data[0].date).toBe('2020-01-04');

    // date-month
    data = (
      await compileAndRunAqlQuery(
        q('transactions')
          .select({ month: { $month: '$date' } })
          .serialize(),
      )
    ).data;
    expect(data[0].month).toBe('2020-01');

    // date-year
    data = (
      await compileAndRunAqlQuery(
        q('transactions')
          .select({ year: { $year: '$date' } })
          .serialize(),
      )
    ).data;
    expect(data[0].year).toBe('2020');

    // boolean
    data = (
      await compileAndRunAqlQuery(
        q('transactions').select(['is_child', 'is_parent']).raw().serialize(),
      )
    ).data;
    expect(data[0].is_child).toBe(false);
    expect(data[0].is_parent).toBe(true);
    expect(data[1].is_child).toBe(true);
    expect(data[1].is_parent).toBe(false);
  });

  it('provides named parameters and converts types', async () => {
    const transId = uuidv4();
    await db.insertTransaction({
      id: transId,
      account: 'acct',
      date: '2020-01-01',
      amount: -5001,
      cleared: true,
    });

    let { data } = await compileAndRunAqlQuery(
      q('transactions')
        .filter({ amount: { $lt: { $neg: ':amount' } } })
        .select()
        .serialize(),
      { params: { amount: 5000 } },
    );
    expect(data[0].id).toBe(transId);

    data = (
      await compileAndRunAqlQuery(
        q('transactions')
          .filter({ date: { $transform: '$month', $eq: { $month: ':month' } } })
          .select('date')
          .serialize(),
        { params: { month: '2020-01-02' } },
      )
    ).data;
    expect(data[0].id).toBe(transId);

    data = (
      await compileAndRunAqlQuery(
        q('transactions')
          .filter({ date: { $transform: '$year', $eq: { $year: ':month' } } })
          .select('date')
          .serialize(),
        { params: { month: '2020-01-02' } },
      )
    ).data;
    expect(data[0].id).toBe(transId);

    data = (
      await compileAndRunAqlQuery(
        q('transactions')
          .filter({ cleared: ':cleared' })
          .select('date')
          .serialize(),
        { params: { cleared: true } },
      )
    ).data;
    expect(data[0].id).toBe(transId);
  });

  it('allows null as a parameter', async () => {
    await db.insertCategoryGroup({ id: 'group', name: 'group' });
    await db.insertCategory({ id: 'cat', name: 'cat', cat_group: 'group' });
    await db.insertCategory({ id: 'cat2', name: 'cat2', cat_group: 'group' });
    const transNoCat = await db.insertTransaction({
      account: 'acct',
      date: '2020-01-01',
      amount: -5001,
      category: null,
    });
    const transCat = await db.insertTransaction({
      account: 'acct',
      date: '2020-01-01',
      amount: -5001,
      category: 'cat',
    });
    const transCat2 = await db.insertTransaction({
      account: 'acct',
      date: '2020-01-02',
      amount: -5001,
      category: 'cat2',
    });

    const queryState = q('transactions')
      .filter({ category: ':category' })
      .select()
      .serialize();

    let { data } = await compileAndRunAqlQuery(queryState, {
      params: { category: null },
    });
    expect(data[0].id).toBe(transNoCat);

    data = (
      await compileAndRunAqlQuery(queryState, { params: { category: 'cat' } })
    ).data;
    expect(data[0].id).toBe(transCat);

    data = (
      await compileAndRunAqlQuery(
        q('transactions')
          .filter({ category: { $ne: ':category' } })
          .select('category')
          .serialize(),

        { params: { category: 'cat2' } },
      )
    ).data;
    expect(data).toHaveLength(2);
    expect(data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: transNoCat }),
        expect.objectContaining({ id: transCat }),
        expect.not.objectContaining({ id: transCat2 }),
      ]),
    );

    data = (
      await compileAndRunAqlQuery(
        q('transactions')
          .filter({ category: { $ne: ':category' } })
          .select('category')
          .serialize(),
        { params: { category: null } },
      )
    ).data;
    expect(data).toHaveLength(2);
    expect(data).toEqual(
      expect.arrayContaining([
        expect.not.objectContaining({ id: transNoCat }),
        expect.objectContaining({ id: transCat }),
        expect.objectContaining({ id: transCat2 }),
      ]),
    );
  });

  it('parameters have the correct order', async () => {
    const transId = uuidv4();
    await db.insertTransaction({
      id: transId,
      account: 'acct',
      date: '2020-01-01',
      amount: -5001,
    });

    const { data } = await compileAndRunAqlQuery(
      q('transactions')
        .filter({
          amount: { $lt: { $neg: ':amount' } },
          date: [{ $lte: ':date' }, { $gte: ':date' }],
        })
        .select()
        .serialize(),
      { params: { amount: 5000, date: '2020-01-01' } },
    );
    expect(data[0].id).toBe(transId);
  });

  it('fetches all data required for $oneof', async () => {
    await insertTransactions();

    const rows = await db.all<Pick<db.DbTransaction, 'id'>>(
      'SELECT id FROM transactions WHERE amount < -50',
    );
    const ids = rows.slice(0, 3).map(row => row.id);
    ids.sort((a, b) => String(a).localeCompare(String(b)));

    const { data } = await compileAndRunAqlQuery(
      q('transactions')
        .filter({ id: { $oneof: repeat(ids, 1000) }, amount: { $lt: 50 } })
        .select('id')
        .raw()
        .serialize(),
    );
    expect(
      data
        .map(row => row.id)
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(ids);
  });
});

describe('$sumOver window semantics', () => {
  // `$sumOver` compiles to
  // `SUM(amount) OVER (ORDER BY <the query's own orders> ROWS BETWEEN CURRENT
  // ROW AND UNBOUNDED FOLLOWING)`, so the frame only yields a running balance
  // when it runs newest-to-oldest. These cases pin that: they pass before and
  // after the desktop fix, and are here so a future change to `$sumOver` or to
  // the query that builds the window cannot quietly alter it.

  async function insertRunningBalanceTransactions() {
    const oldest = uuidv4();
    const middle = uuidv4();
    const newest = uuidv4();

    await db.insertTransaction({
      id: oldest,
      account: 'acct',
      date: '2020-01-01',
      amount: 100,
    });
    await db.insertTransaction({
      id: middle,
      account: 'acct',
      date: '2020-01-02',
      amount: -50,
    });
    await db.insertTransaction({
      id: newest,
      account: 'acct',
      date: '2020-01-03',
      amount: 25,
    });

    return { oldest, middle, newest };
  }

  function runningBalanceQuery() {
    // The test database holds only these transactions, so no account filter is
    // needed - `acct` is not a real account row here and would be nulled by
    // ref validation.
    return q('transactions').select([{ balance: { $sumOver: '$amount' } }]);
  }

  it('is a running balance for a newest-first ordering', async () => {
    const { oldest, middle, newest } = await insertRunningBalanceTransactions();

    const { data } = await compileAndRunAqlQuery(
      runningBalanceQuery().orderBy({ date: 'desc' }).serialize(),
    );

    expect(
      data.reduce((acc, row) => ({ ...acc, [row.id]: row.balance }), {}),
    ).toEqual({ [newest]: 75, [middle]: 50, [oldest]: 100 });
  });

  it('is not a running balance for an oldest-first ordering', async () => {
    await insertRunningBalanceTransactions();

    const { data } = await compileAndRunAqlQuery(
      runningBalanceQuery().orderBy({ date: 'asc' }).serialize(),
    );

    // Each row sums forward toward the newer transactions instead. This is why
    // the desktop balance query has to order its own window rather than
    // inherit the user's display sort.
    expect(data.map(row => row.balance)).toEqual([75, -25, 25]);
  });

  it('counts a starting balance transaction like any other row', async () => {
    const { oldest, middle, newest } = await insertRunningBalanceTransactions();
    const startingBalanceId = uuidv4();
    await db.insertTransaction({
      id: startingBalanceId,
      account: 'acct',
      date: '2019-12-31',
      amount: 1004,
      payee: 'starting-balance',
    });

    const { data } = await compileAndRunAqlQuery(
      runningBalanceQuery().orderBy({ date: 'desc' }).serialize(),
    );

    // Every balance is offset by the starting balance, because it is an
    // ordinary transaction in the window. Absolute balance assertions are only
    // meaningful on an account with no starting balance row.
    expect(
      data.reduce((acc, row) => ({ ...acc, [row.id]: row.balance }), {}),
    ).toEqual({
      [newest]: 1079,
      [middle]: 1054,
      [oldest]: 1104,
      [startingBalanceId]: 1004,
    });
  });
});
