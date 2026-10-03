// @ts-strict-ignore
import { expectSnapshotWithDiffer } from '#mocks/util';
import * as db from '#server/db';

import * as transfer from './transfer';

beforeEach(global.emptyDatabase());

function getAllTransactions() {
  return db.all<db.DbViewTransaction & { payee_name: db.DbPayee['name'] }>(
    `SELECT t.*, p.name as payee_name
       FROM v_transactions t
       LEFT JOIN payees p ON p.id = t.payee
       ORDER BY date DESC, amount DESC, id
     `,
  );
}

async function prepareDatabase() {
  await db.insertCategoryGroup({ id: 'group1', name: 'group1', is_income: 0 });
  await db.insertCategory({
    id: '1',
    name: 'cat1',
    cat_group: 'group1',
    is_income: 0,
  });
  await db.insertAccount({ id: 'one', name: 'one' });
  await db.insertAccount({ id: 'two', name: 'two' });
  await db.insertAccount({ id: 'three', name: 'three', offbudget: 1 });
  await db.insertPayee({ name: '', transfer_acct: 'one' });
  await db.insertPayee({ name: '', transfer_acct: 'two' });
  await db.insertPayee({
    name: '',
    transfer_acct: 'three',
  });
}

type Transaction = {
  account: string;
  amount: number;
  category?: string;
  date: string;
  id?: string;
  notes?: string;
  payee: string;
  schedule?: string | null;
  schedule_occurrence?: string | null;
  transfer_id?: string;
  is_parent?: boolean;
  is_child?: boolean;
  parent_id?: string;
};

describe('Transfer', () => {
  test('transfers are properly inserted/updated/deleted', async () => {
    await prepareDatabase();

    let transaction: Transaction = {
      account: 'one',
      amount: 5000,
      payee: await db.insertPayee({ name: 'Non-transfer' }),
      date: '2017-01-01',
    };
    await db.insertTransaction(transaction);
    await transfer.onInsert(transaction);

    const differ = expectSnapshotWithDiffer(await getAllTransactions());

    const transferTwo = await db.first<db.DbPayee>(
      "SELECT * FROM payees WHERE transfer_acct = 'two'",
    );
    const transferThree = await db.first<db.DbPayee>(
      "SELECT * FROM payees WHERE transfer_acct = 'three'",
    );

    transaction = {
      account: 'one',
      amount: 5000,
      payee: transferTwo.id,
      date: '2017-01-01',
    };
    transaction.id = await db.insertTransaction(transaction);
    await transfer.onInsert(transaction);
    differ.expectToMatchDiff(await getAllTransactions());

    // Fill the transaction out
    transaction = await db.getTransaction(transaction.id);
    expect(transaction.transfer_id).toBeDefined();

    transaction = {
      ...transaction,
      date: '2017-01-05',
      notes: 'This is a note',
    };
    await db.updateTransaction(transaction);
    await transfer.onUpdate(transaction);
    differ.expectToMatchDiff(await getAllTransactions());

    transaction = {
      ...transaction,
      payee: transferThree.id,
    };
    await db.updateTransaction(transaction);
    await transfer.onUpdate(transaction);
    differ.expectToMatchDiff(await getAllTransactions());

    transaction = {
      ...transaction,
      payee: await db.insertPayee({ name: 'Not transferred anymore' }),
    };
    await db.updateTransaction(transaction);
    await transfer.onUpdate(transaction);
    differ.expectToMatchDiff(await getAllTransactions());

    // Make sure it's not a linked transaction anymore
    transaction = await db.getTransaction(transaction.id);
    expect(transaction.transfer_id).toBeNull();

    // Re-transfer it
    transaction = {
      ...transaction,
      payee: transferTwo.id,
    };
    await db.updateTransaction(transaction);
    await transfer.onUpdate(transaction);
    differ.expectToMatchDiff(await getAllTransactions());

    transaction = await db.getTransaction(transaction.id);
    expect(transaction.transfer_id).toBeDefined();

    await db.deleteTransaction(transaction);
    await transfer.onDelete(transaction);
    differ.expectToMatchDiff(await getAllTransactions());
  });

  test('transfers are properly de-categorized', async () => {
    await prepareDatabase();

    const transferTwo = await db.first<db.DbPayee>(
      "SELECT * FROM payees WHERE transfer_acct = 'two'",
    );
    const transferThree = await db.first<db.DbPayee>(
      "SELECT * FROM payees WHERE transfer_acct = 'three'",
    );

    let transaction: Transaction = {
      account: 'one',
      amount: 5000,
      payee: await db.insertPayee({ name: 'Non-transfer' }),
      date: '2017-01-01',
      category: '1',
    };
    transaction.id = await db.insertTransaction(transaction);
    await transfer.onInsert(transaction);

    const differ = expectSnapshotWithDiffer(await getAllTransactions());

    transaction = {
      ...(await db.getTransaction(transaction.id)),
      payee: transferThree.id,
      notes: 'hi',
    };
    await db.updateTransaction(transaction);
    await transfer.onUpdate(transaction);
    differ.expectToMatchDiff(await getAllTransactions());

    transaction = {
      ...(await db.getTransaction(transaction.id)),
      payee: transferTwo.id,
    };
    await db.updateTransaction(transaction);
    await transfer.onUpdate(transaction);
    differ.expectToMatchDiff(await getAllTransactions());
  });

  test('split transfers are retained on child transactions', async () => {
    // test: first add a txn having a transfer acct payee
    // then mark it as `is_parent` and add a child txn
    // the child txn should have a different transfer acct payee
    // and `is_child` set to true
    await prepareDatabase();

    const [transferOne, transferTwo] = await Promise.all([
      db.first<db.DbPayee>("SELECT * FROM payees WHERE transfer_acct = 'one'"),
      db.first<db.DbPayee>("SELECT * FROM payees WHERE transfer_acct = 'two'"),
    ]);

    let parent: Transaction = {
      account: 'one',
      amount: 5000,
      payee: transferTwo.id,
      date: '2017-01-01',
    };
    parent.id = await db.insertTransaction(parent);
    await transfer.onInsert(parent);
    parent = await db.getTransaction(parent.id);

    const differ = expectSnapshotWithDiffer(await getAllTransactions());

    // mark the txn as parent
    await db.updateTransaction({ id: parent.id, is_parent: true });
    await transfer.onUpdate(parent);
    differ.expectToMatchDiff(await getAllTransactions());

    // add a child txn
    let child: Transaction = {
      account: 'one',
      amount: 2000,
      payee: transferOne.id,
      date: '2017-01-01',
      is_child: true,
      parent_id: parent.id,
    };
    child.id = await db.insertTransaction(child);
    await transfer.onInsert(child);
    differ.expectToMatchDiff(await getAllTransactions());

    // ensure that the child txn has the correct transfer acct payee
    child = await db.getTransaction(child.id);
    expect(child.transfer_id).not.toBe(parent.transfer_id);
    expect(child.payee).toBe(transferOne.id);
  });
});

// A schedule link and its occurrence stamp only mean anything together, so
// the mirror leg has to carry BOTH from its main leg. These assert on plain
// db.all rows rather than a snapshot: a .snap file IS the expected value, so
// a green run could not show it had not been churned.
//
// `schedule_occurrence` off a db.all row is the RAW INTEGER; db.getTransaction
// goes through the AQL schema and returns a 'YYYY-MM-DD' string. Insert it as a
// plain 'YYYY-MM-DD' string either way.
describe('Transfer schedule occurrence', () => {
  beforeEach(global.emptyDatabase());

  // The main leg must sit in an account that HAS a transfer_acct payee:
  // addTransfer looks one up by the main leg's account and destructures the
  // result with no null check. This helper sets up its own accounts and
  // payees rather than reusing the shared one the snapshot tests rely on.
  async function prepareScheduleDatabase() {
    await db.insertAccount({ id: 'one', name: 'one' });
    await db.insertAccount({ id: 'two', name: 'two' });
    await db.insertPayee({ name: '', transfer_acct: 'one' });
    await db.insertPayee({ name: '', transfer_acct: 'two' });
  }

  // The main leg pays INTO account 'two', so addTransfer looks up the payee
  // whose transfer_acct is 'one' for the mirror.
  async function getTransferTwo() {
    const payee = await db.first<db.DbPayee>(
      "SELECT * FROM payees WHERE transfer_acct = 'two'",
    );
    return payee.id;
  }

  // `schedule_occurrence` is a real column on v_transactions but is absent
  // from the DbViewTransaction type, so it is intersected in locally rather
  // than widening the shared type from a test file.
  type ScheduledTransaction = Transaction & {
    schedule: string;
    schedule_occurrence: string;
  };

  function getMirrorRows(mainLegId: string) {
    return db.all<
      db.DbViewTransaction & { schedule_occurrence: number | null }
    >('SELECT * FROM v_transactions WHERE transfer_id = ?', [mainLegId]);
  }

  it('gives the mirror leg the schedule and stamp of its main leg', async () => {
    await prepareScheduleDatabase();

    const transaction: ScheduledTransaction = {
      account: 'one',
      amount: 5000,
      payee: await getTransferTwo(),
      date: '2017-01-01',
      schedule: 'schedule-1',
      schedule_occurrence: '2017-01-01',
    };
    transaction.id = await db.insertTransaction(transaction);
    // The SAME object that was inserted, plus its id — a hand-built object
    // missing `payee` resolves no transferred account and addTransfer never runs.
    await transfer.onInsert(transaction);

    const mirrors = await getMirrorRows(transaction.id);
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]).toMatchObject({
      schedule: 'schedule-1',
      schedule_occurrence: 20170101,
    });
  });

  it('keeps the mirror stamp when the main leg is updated', async () => {
    // `date` is deliberately not asserted: updateTransfer has never copied it
    // to the mirror, so tracking the date is not this change's contract.
    await prepareScheduleDatabase();

    const transaction: ScheduledTransaction = {
      account: 'one',
      amount: 5000,
      payee: await getTransferTwo(),
      date: '2017-01-01',
      schedule: 'schedule-1',
      schedule_occurrence: '2017-01-01',
    };
    transaction.id = await db.insertTransaction(transaction);
    await transfer.onInsert(transaction);

    // Re-read so the payload carries its real transfer_id; without it onUpdate
    // re-routes to addTransfer and creates a duplicate mirror.
    const payload = await db.getTransaction(transaction.id);
    const updated = { ...payload, date: '2017-01-05' };
    await db.updateTransaction(updated);
    // The payload actually written, not the pre-update entity — passing the
    // latter makes the assertions vacuous.
    await transfer.onUpdate(updated);

    const mirrors = await getMirrorRows(transaction.id);
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]).toMatchObject({
      schedule: 'schedule-1',
      schedule_occurrence: 20170101,
    });
  });

  it('leaves the mirror stamp alone when a partial update omits the field', async () => {
    // The case that makes `?? null` wrong: an explicit null would be WRITTEN,
    // unstamping the mirror on every partial update that never mentions the
    // field. `schedule` sits directly above it and behaves identically, so the
    // realistic shape omits both together.
    await prepareScheduleDatabase();

    const transaction: ScheduledTransaction = {
      account: 'one',
      amount: 5000,
      payee: await getTransferTwo(),
      date: '2017-01-01',
      schedule: 'schedule-1',
      schedule_occurrence: '2017-01-01',
    };
    transaction.id = await db.insertTransaction(transaction);
    await transfer.onInsert(transaction);

    const payload = await db.getTransaction(transaction.id);
    const { schedule, schedule_occurrence, ...withoutSchedule } = payload;
    expect(schedule).toBe('schedule-1');
    expect(schedule_occurrence).toBe('2017-01-01');

    await db.updateTransaction(withoutSchedule);
    await transfer.onUpdate(withoutSchedule);

    const mirrors = await getMirrorRows(transaction.id);
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]).toMatchObject({
      schedule: 'schedule-1',
      schedule_occurrence: 20170101,
    });
  });

  it('clears the mirror stamp when the schedule link is removed', async () => {
    await prepareScheduleDatabase();

    const transaction: ScheduledTransaction = {
      account: 'one',
      amount: 5000,
      payee: await getTransferTwo(),
      date: '2017-01-01',
      schedule: 'schedule-1',
      schedule_occurrence: '2017-01-01',
    };
    transaction.id = await db.insertTransaction(transaction);
    await transfer.onInsert(transaction);

    const payload = await db.getTransaction(transaction.id);
    const cleared = {
      ...payload,
      schedule: null,
      schedule_occurrence: null,
    };
    await db.updateTransaction(cleared);
    await transfer.onUpdate(cleared);

    const mirrors = await getMirrorRows(transaction.id);
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0].schedule).toBeNull();
    expect(mirrors[0].schedule_occurrence).toBeNull();
  });
});
