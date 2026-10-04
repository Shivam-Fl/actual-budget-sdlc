import * as d from 'date-fns';
// @ts-strict-ignore
import MockDate from 'mockdate';

import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { toDateRepr } from '#server/models';
import { runHandler } from '#server/mutators';
import { app as transactionsApp } from '#server/transactions/app';
import { mergeTransactions } from '#server/transactions/merge';
import { loadRules, updateRule } from '#server/transactions/transaction-rules';
import {
  addDays,
  currentDay,
  dayFromDate,
  parseDate,
  subDays,
} from '#shared/months';
import { q } from '#shared/query';
import {
  computeSchedulePreviewTransactions,
  getHasTransactionsQuery,
  getNextDate,
  getPostedScheduleTransactionsQuery,
  getStatus,
  indexPostedScheduleTransactions,
} from '#shared/schedules';
import type {
  PostedScheduleTransaction,
  ScheduleStatuses,
} from '#shared/schedules';
import {
  makeEmptySplitSubtransactions,
  splitTransaction,
} from '#shared/transactions';

import {
  advanceSchedulesService,
  areConditionValuesEqual,
  createSchedule,
  deleteSchedule,
  app as schedulesApp,
  setNextDate,
  skipNextDate,
  updateConditions,
  updateSchedule,
} from './app';

beforeEach(async () => {
  await global.emptyDatabase()();
  await loadMappings();
  await loadRules();
});

describe('schedule app', () => {
  describe('utility', () => {
    it('conditions are updated when they exist', () => {
      const conds = [
        { op: 'is', field: 'payee', value: 'FOO' },
        { op: 'is', field: 'date', value: '2020-01-01' },
      ];

      const updated = updateConditions(conds, [
        {
          op: 'is',
          field: 'payee',
          value: 'bar',
        },
      ]);

      expect(updated.length).toBe(2);
      expect(updated[0].value).toBe('bar');
    });

    it("conditions are added if they don't exist", () => {
      const conds = [
        { op: 'contains', field: 'payee', value: 'FOO' },
        { op: 'contains', field: 'notes', value: 'dflksjdflskdjf' },
      ];

      const updated = updateConditions(conds, [
        {
          op: 'is',
          field: 'payee',
          value: 'bar',
        },
      ]);

      expect(updated.length).toBe(3);
    });

    it('getNextDate works with date conditions', () => {
      expect(
        getNextDate({ op: 'is', field: 'date', value: '2021-04-30' }),
      ).toBe('2021-04-30');

      expect(
        getNextDate({
          op: 'is',
          field: 'date',
          value: {
            start: '2020-12-20',
            frequency: 'monthly',
            patterns: [
              { type: 'day', value: 15 },
              { type: 'day', value: 30 },
            ],
          },
        }),
      ).toBe('2020-12-30');
    });

    it('areConditionValuesEqual matches nested objects regardless of key order', () => {
      expect(
        areConditionValuesEqual(
          {
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 15 },
                { type: 'day', value: 30 },
              ],
            },
            field: 'date',
          },
          {
            field: 'date',
            value: {
              patterns: [
                { value: 15, type: 'day' },
                { value: 30, type: 'day' },
              ],
              frequency: 'monthly',
              start: '2020-12-20',
            },
          },
        ),
      ).toBe(true);
    });

    it('areConditionValuesEqual returns false for different array ordering', () => {
      expect(
        areConditionValuesEqual(
          [{ field: 'date' }, { field: 'account' }],
          [{ field: 'account' }, { field: 'date' }],
        ),
      ).toBe(false);
    });

    it('areConditionValuesEqual distinguishes nullish values', () => {
      expect(areConditionValuesEqual(null, undefined)).toBe(false);
      expect(areConditionValuesEqual(undefined, undefined)).toBe(true);
    });
  });

  describe('methods', () => {
    it('createSchedule creates a schedule', async () => {
      const id = await createSchedule({
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 15 },
                { type: 'day', value: 30 },
              ],
            },
          },
        ],
      });

      const {
        data: [row],
      } = await aqlQuery(q('schedules').filter({ id }).select('*'));

      expect(row).toBeTruthy();
      expect(row.rule).toBeTruthy();
      expect(row.next_date).toBe('2020-12-30');

      await expect(
        createSchedule({
          conditions: [{ op: 'is', field: 'payee', value: 'p1' }],
        }),
      ).rejects.toThrow(/date condition is required/);
    });

    it('identifies schedules with split actions', async () => {
      const id = await createSchedule({
        conditions: [{ op: 'is', field: 'date', value: '2020-12-20' }],
      });
      const { data: ruleId } = await aqlQuery(
        q('schedules').filter({ id }).calculate('rule'),
      );

      await updateRule({
        id: ruleId,
        actions: [
          {
            op: 'set',
            field: 'payee',
            value: 'destination-payee',
            options: { splitIndex: 0 },
          },
          { op: 'link-schedule', value: id },
        ],
      });

      const { data: parentActionMatches } = await aqlQuery(
        q('schedules').filter({ _has_splits: true }).select(['id']),
      );
      expect(parentActionMatches).toEqual([]);

      await updateRule({
        id: ruleId,
        actions: [
          {
            op: 'set',
            field: 'payee',
            value: 'destination-payee',
            options: { splitIndex: 1 },
          },
          { op: 'link-schedule', value: id },
        ],
      });

      const { data: splitActionMatches } = await aqlQuery(
        q('schedules').filter({ _has_splits: true }).select(['id']),
      );

      expect(splitActionMatches).toEqual([{ id }]);
    });

    it('trims schedule names when creating and updating schedules', async () => {
      const id = await createSchedule({
        schedule: { name: '  Rent  ' },
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: '2020-12-20',
          },
        ],
      });

      let res = await aqlQuery(q('schedules').filter({ id }).select(['name']));
      expect(res.data[0].name).toBe('Rent');

      await updateSchedule({
        schedule: { id, name: '  Mortgage  ' },
      });

      res = await aqlQuery(q('schedules').filter({ id }).select(['name']));
      expect(res.data[0].name).toBe('Mortgage');
    });

    it('treats names as duplicates after trimming whitespace', async () => {
      await createSchedule({
        schedule: { name: 'Rent' },
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: '2020-12-20',
          },
        ],
      });

      await expect(
        createSchedule({
          schedule: { name: '  Rent  ' },
          conditions: [
            {
              op: 'is',
              field: 'date',
              value: '2020-12-20',
            },
          ],
        }),
      ).rejects.toThrow(/same name/);
    });

    it('updateSchedule updates a schedule', async () => {
      const id = await createSchedule({
        conditions: [
          { op: 'is', field: 'payee', value: 'foo' },
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 15 },
                { type: 'day', value: 30 },
              ],
            },
          },
        ],
      });

      let res = await aqlQuery(
        q('schedules')
          .filter({ id })
          .select(['next_date', 'posts_transaction']),
      );
      let row = res.data[0];

      expect(row.next_date).toBe('2020-12-30');
      expect(row.posts_transaction).toBe(false);

      MockDate.set(new Date(2021, 4, 17));

      await updateSchedule({
        schedule: { id, posts_transaction: true },
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 18 },
                { type: 'day', value: 29 },
              ],
            },
          },
        ],
      });

      res = await aqlQuery(
        q('schedules')
          .filter({ id })
          .select(['next_date', 'posts_transaction']),
      );
      row = res.data[0];

      // Updating the date condition updates `next_date`
      expect(row.next_date).toBe('2021-05-18');
      expect(row.posts_transaction).toBe(true);
    });

    it('updateSchedule does not update `next_date` when unrelated conditions change', async () => {
      const id = await createSchedule({
        conditions: [
          { op: 'is', field: 'payee', value: 'foo' },
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 15 },
                { type: 'day', value: 30 },
              ],
            },
          },
        ],
      });

      MockDate.set(new Date(2021, 4, 17));

      await updateSchedule({
        schedule: { id },
        conditions: [{ op: 'is', field: 'payee', value: 'bar' }],
      });

      const {
        data: [row],
      } = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));

      expect(row.next_date).toBe('2020-12-30');
    });

    it('updateSchedule ignores the condition `type` field when date value is unchanged', async () => {
      const id = await createSchedule({
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 15 },
                { type: 'day', value: 30 },
              ],
            },
          },
        ],
      });

      MockDate.set(new Date(2021, 4, 17));

      await updateSchedule({
        schedule: { id },
        conditions: [
          {
            op: 'is',
            field: 'date',
            type: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 15 },
                { type: 'day', value: 30 },
              ],
            },
          },
        ],
      });

      const {
        data: [row],
      } = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));

      expect(row.next_date).toBe('2020-12-30');
    });

    it('deleteSchedule deletes a schedule', async () => {
      const id = await createSchedule({
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 15 },
                { type: 'day', value: 30 },
              ],
            },
          },
        ],
      });

      const { data: schedules } = await aqlQuery(q('schedules').select('*'));
      expect(schedules.length).toBe(1);

      await deleteSchedule({ id });
      const { data: schedules2 } = await aqlQuery(q('schedules').select('*'));
      expect(schedules2.length).toBe(0);
    });

    it('setNextDate sets `next_date`', async () => {
      const id = await createSchedule({
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 15 },
                { type: 'day', value: 30 },
              ],
            },
          },
        ],
      });

      const { data: ruleId } = await aqlQuery(
        q('schedules').filter({ id }).calculate('rule'),
      );

      // Manually update the rule
      await updateRule({
        id: ruleId,
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-20',
              frequency: 'monthly',
              patterns: [
                { type: 'day', value: 18 },
                { type: 'day', value: 28 },
              ],
            },
          },
        ],
      });

      let res = await aqlQuery(
        q('schedules').filter({ id }).select(['next_date']),
      );
      let row = res.data[0];

      expect(row.next_date).toBe('2020-12-30');

      await setNextDate({ id });

      res = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));
      row = res.data[0];

      expect(row.next_date).toBe('2021-05-18');
    });

    it('skipNextDate skips `next_date`', async () => {
      /* Dec 2020 calendar for reference:
        | Su | Mo | Tu | We | Th | Fr | Sa |
        |    |    | 01 | 02 | 03 | 04 | 05 |
        | 06 | 07 | 08 | 09 | 10 | 11 | 12 |
        | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
        | 20 | 21 | 22 | 23 | 24 | 25 | 26 |
        | 27 | 28 | 29 | 30 | 31 |
        */
      const id = await createSchedule({
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-05',
              frequency: 'weekly',
              patterns: [],
            },
          },
        ],
      });

      let res = await aqlQuery(
        q('schedules').filter({ id }).select(['next_date']),
      );
      let row = res.data[0];

      expect(row.next_date).toBe('2020-12-05');

      await skipNextDate({ id });

      res = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));
      row = res.data[0];

      expect(row.next_date).toBe('2020-12-12');
    });

    it('skipNextDate skips `next_date` moving `after` weekend', async () => {
      /* Dec 2020 calendar for reference:
        | Su | Mo | Tu | We | Th | Fr | Sa |
        |    |    | 01 | 02 | 03 | 04 | 05 |
        | 06 | 07 | 08 | 09 | 10 | 11 | 12 |
        | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
        | 20 | 21 | 22 | 23 | 24 | 25 | 26 |
        | 27 | 28 | 29 | 30 | 31 |
        */
      const id = await createSchedule({
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-05',
              frequency: 'weekly',
              patterns: [],
              skipWeekend: true,
              weekendSolveMode: 'after',
            },
          },
        ],
      });

      let res = await aqlQuery(
        q('schedules').filter({ id }).select(['next_date']),
      );
      let row = res.data[0];

      expect(row.next_date).toBe('2020-12-07');

      await skipNextDate({ id });

      res = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));
      row = res.data[0];

      expect(row.next_date).toBe('2020-12-14');
    });

    it('skipNextDate skips `next_date` moving `before` weekend', async () => {
      /* Dec 2020 calendar for reference:
        | Su | Mo | Tu | We | Th | Fr | Sa |
        |    |    | 01 | 02 | 03 | 04 | 05 |
        | 06 | 07 | 08 | 09 | 10 | 11 | 12 |
        | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
        | 20 | 21 | 22 | 23 | 24 | 25 | 26 |
        | 27 | 28 | 29 | 30 | 31 |
        */
      const id = await createSchedule({
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-05',
              frequency: 'weekly',
              patterns: [],
              skipWeekend: true,
              weekendSolveMode: 'before',
            },
          },
        ],
      });

      let res = await aqlQuery(
        q('schedules').filter({ id }).select(['next_date']),
      );
      let row = res.data[0];

      expect(row.next_date).toBe('2020-12-04');

      await skipNextDate({ id });

      res = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));
      row = res.data[0];

      expect(row.next_date).toBe('2020-12-11');
    });

    it('skipNextDate keeps the next occurrence when moving `before` weekend', async () => {
      /* Dec 2020 calendar for reference:
        | Su | Mo | Tu | We | Th | Fr | Sa |
        |    |    | 01 | 02 | 03 | 04 | 05 |
        | 06 | 07 | 08 | 09 | 10 | 11 | 12 |
        | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
        | 20 | 21 | 22 | 23 | 24 | 25 | 26 |
        | 27 | 28 | 29 | 30 | 31 |
        */
      const id = await createSchedule({
        conditions: [
          {
            op: 'is',
            field: 'date',
            value: {
              start: '2020-12-04',
              frequency: 'daily',
              patterns: [],
              skipWeekend: true,
              weekendSolveMode: 'before',
            },
          },
        ],
      });

      let res = await aqlQuery(
        q('schedules').filter({ id }).select(['next_date']),
      );
      let row = res.data[0];

      expect(row.next_date).toBe('2020-12-04');

      await skipNextDate({ id });

      res = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));
      row = res.data[0];

      expect(row.next_date).toBe('2020-12-07');
    });

    it('auto-posts every missed recurring occurrence while catching up', async () => {
      MockDate.set(new Date(2016, 11, 31, 12));
      schedulesApp.startServices();

      try {
        const accountId = await db.insertAccount({
          name: 'Checking',
          offbudget: 0,
          closed: 0,
        });

        const id = await createSchedule({
          schedule: { posts_transaction: true },
          conditions: [
            {
              op: 'is',
              field: 'account',
              value: accountId,
            },
            {
              op: 'is',
              field: 'amount',
              value: -10000,
            },
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2016-12-05',
                frequency: 'weekly',
                interval: 2,
                patterns: [],
              },
            },
          ],
        });
        const nextDateRow = await db.first<{
          id: string;
        }>('SELECT id FROM schedules_next_date WHERE schedule_id = ?', [id]);

        await db.update('schedules_next_date', {
          id: nextDateRow.id,
          local_next_date: 20161205,
          local_next_date_ts: Date.now(),
          base_next_date: 20161205,
          base_next_date_ts: Date.now(),
        });

        await advanceSchedulesService(true);

        const { data: transactions } = await aqlQuery(
          q('transactions')
            .filter({ schedule: id })
            .select(['date', 'amount'])
            .orderBy({ date: 'asc' }),
        );

        expect(
          transactions.map(({ date, amount }) => ({ date, amount })),
        ).toEqual([
          { date: '2016-12-05', amount: -10000 },
          { date: '2016-12-19', amount: -10000 },
        ]);

        const {
          data: [schedule],
        } = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));

        expect(schedule.next_date).toBe('2017-01-02');
      } finally {
        MockDate.reset();
        await schedulesApp.stopServices();
      }
    });

    it('continues auto-post catch-up after an already paid occurrence', async () => {
      MockDate.set(new Date(2016, 11, 31, 12));
      schedulesApp.startServices();

      try {
        const accountId = await db.insertAccount({
          name: 'Checking',
          offbudget: 0,
          closed: 0,
        });

        const id = await createSchedule({
          schedule: { posts_transaction: true },
          conditions: [
            {
              op: 'is',
              field: 'account',
              value: accountId,
            },
            {
              op: 'is',
              field: 'amount',
              value: -10000,
            },
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2016-12-05',
                frequency: 'weekly',
                interval: 2,
                patterns: [],
              },
            },
          ],
        });
        const nextDateRow = await db.first<{
          id: string;
        }>('SELECT id FROM schedules_next_date WHERE schedule_id = ?', [id]);

        await db.update('schedules_next_date', {
          id: nextDateRow.id,
          local_next_date: 20161205,
          local_next_date_ts: Date.now(),
          base_next_date: 20161205,
          base_next_date_ts: Date.now(),
        });
        await db.insertTransaction({
          account: accountId,
          amount: -10000,
          date: '2016-12-05',
          schedule: id,
        });

        await advanceSchedulesService(true);

        const { data: transactions } = await aqlQuery(
          q('transactions')
            .filter({ schedule: id })
            .select(['date', 'amount'])
            .orderBy({ date: 'asc' }),
        );

        expect(
          transactions.map(({ date, amount }) => ({ date, amount })),
        ).toEqual([
          { date: '2016-12-05', amount: -10000 },
          { date: '2016-12-19', amount: -10000 },
        ]);

        const {
          data: [schedule],
        } = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));

        expect(schedule.next_date).toBe('2017-01-02');
      } finally {
        MockDate.reset();
        await schedulesApp.stopServices();
      }
    });

    it('catches up an auto-post schedule moved `before` a weekend occurrence', async () => {
      /* Dec 2016 / Jan 2017 calendar for reference:
        | Su | Mo | Tu | We | Th | Fr | Sa |
        | 18 | 19 | 20 | 21 | 22 | 23 | 24 |
        | 25 | 26 | 27 | 28 | 29 | 30 | 31 |
        | 01 | 02 | 03 | 04 | 05 | 06 | 07 |
        */
      MockDate.set(new Date(2016, 11, 31, 12));
      schedulesApp.startServices();

      try {
        const accountId = await db.insertAccount({
          name: 'Checking',
          offbudget: 0,
          closed: 0,
        });

        const id = await createSchedule({
          schedule: { posts_transaction: true },
          conditions: [
            {
              op: 'is',
              field: 'account',
              value: accountId,
            },
            {
              op: 'is',
              field: 'amount',
              value: -10000,
            },
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2016-12-24',
                frequency: 'weekly',
                interval: 1,
                patterns: [],
                skipWeekend: true,
                weekendSolveMode: 'before',
              },
            },
          ],
        });
        const nextDateRow = await db.first<{
          id: string;
        }>('SELECT id FROM schedules_next_date WHERE schedule_id = ?', [id]);

        await db.update('schedules_next_date', {
          id: nextDateRow.id,
          local_next_date: 20161223,
          local_next_date_ts: Date.now(),
          base_next_date: 20161223,
          base_next_date_ts: Date.now(),
        });
        await db.insertTransaction({
          account: accountId,
          amount: -10000,
          date: '2016-12-23',
          schedule: id,
        });

        await advanceSchedulesService(true);

        const { data: transactions } = await aqlQuery(
          q('transactions')
            .filter({ schedule: id })
            .select(['date', 'amount'])
            .orderBy({ date: 'asc' }),
        );

        expect(
          transactions.map(({ date, amount }) => ({ date, amount })),
        ).toEqual([
          { date: '2016-12-23', amount: -10000 },
          { date: '2016-12-30', amount: -10000 },
        ]);

        const {
          data: [schedule],
        } = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));

        expect(schedule.next_date).toBe('2017-01-06');
      } finally {
        MockDate.reset();
        await schedulesApp.stopServices();
      }
    });

    it('completes one-time auto-post schedules that are already paid', async () => {
      MockDate.set(new Date(2016, 11, 31, 12));
      schedulesApp.startServices();

      try {
        const accountId = await db.insertAccount({
          name: 'Checking',
          offbudget: 0,
          closed: 0,
        });

        const id = await createSchedule({
          schedule: { posts_transaction: true },
          conditions: [
            {
              op: 'is',
              field: 'account',
              value: accountId,
            },
            {
              op: 'is',
              field: 'amount',
              value: -10000,
            },
            {
              op: 'is',
              field: 'date',
              value: '2016-12-05',
            },
          ],
        });
        await db.insertTransaction({
          account: accountId,
          amount: -10000,
          date: '2016-12-05',
          schedule: id,
        });

        await advanceSchedulesService(true);

        const {
          data: [schedule],
        } = await aqlQuery(q('schedules').filter({ id }).select(['completed']));

        expect(schedule.completed).toBe(true);

        const { data: transactions } = await aqlQuery(
          q('transactions').filter({ schedule: id }).select(['date']),
        );

        expect(transactions).toHaveLength(1);
      } finally {
        MockDate.reset();
        await schedulesApp.stopServices();
      }
    });

    it('auto-posts one-time schedules that are due', async () => {
      MockDate.set(new Date(2016, 11, 31, 12));
      schedulesApp.startServices();

      try {
        const accountId = await db.insertAccount({
          name: 'Checking',
          offbudget: 0,
          closed: 0,
        });

        const id = await createSchedule({
          schedule: { posts_transaction: true },
          conditions: [
            {
              op: 'is',
              field: 'account',
              value: accountId,
            },
            {
              op: 'is',
              field: 'amount',
              value: -10000,
            },
            {
              op: 'is',
              field: 'date',
              value: '2016-12-31',
            },
          ],
        });

        await advanceSchedulesService(true);

        const { data: transactions } = await aqlQuery(
          q('transactions').filter({ schedule: id }).select(['date', 'amount']),
        );

        expect(
          transactions.map(({ date, amount }) => ({ date, amount })),
        ).toEqual([{ date: '2016-12-31', amount: -10000 }]);
      } finally {
        MockDate.reset();
        await schedulesApp.stopServices();
      }
    });

    it('keeps a schedule posted today paid for the rest of the day', async () => {
      // In tests `currentDay()` is fixed at 2017-01-01, so that is "today".
      MockDate.set(new Date(2016, 11, 31, 12));
      schedulesApp.startServices();

      try {
        const accountId = await db.insertAccount({
          name: 'Checking',
          offbudget: 0,
          closed: 0,
        });

        const id = await createSchedule({
          schedule: { posts_transaction: true },
          conditions: [
            {
              op: 'is',
              field: 'account',
              value: accountId,
            },
            {
              op: 'is',
              field: 'amount',
              value: -10000,
            },
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2016-12-18',
                frequency: 'weekly',
                interval: 1,
                patterns: [],
              },
            },
          ],
        });
        const nextDateRow = await db.first<{
          id: string;
        }>('SELECT id FROM schedules_next_date WHERE schedule_id = ?', [id]);

        await db.update('schedules_next_date', {
          id: nextDateRow.id,
          local_next_date: 20170101,
          local_next_date_ts: Date.now(),
          base_next_date: 20170101,
          base_next_date_ts: Date.now(),
        });

        await advanceSchedulesService(true);

        const { data: transactions } = await aqlQuery(
          q('transactions')
            .filter({ schedule: id })
            .select(['date', 'amount'])
            .orderBy({ date: 'asc' }),
        );

        expect(
          transactions.map(({ date, amount }) => ({ date, amount })),
        ).toEqual([{ date: '2017-01-01', amount: -10000 }]);

        const {
          data: [schedule],
        } = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));

        expect(schedule.next_date).toBe('2017-01-01');

        // A same-day re-run (e.g. offline retry) neither posts again nor
        // advances; the schedule stays paid on today's date. Advancement on
        // a later day is covered by the catch-up tests above.
        await advanceSchedulesService(true);

        const { data: transactionsAfter } = await aqlQuery(
          q('transactions')
            .filter({ schedule: id })
            .select(['date', 'amount'])
            .orderBy({ date: 'asc' }),
        );

        expect(transactionsAfter).toHaveLength(1);

        const {
          data: [scheduleAfter],
        } = await aqlQuery(q('schedules').filter({ id }).select(['next_date']));

        expect(scheduleAfter.next_date).toBe('2017-01-01');
      } finally {
        MockDate.reset();
        await schedulesApp.stopServices();
      }
    });

    it('keeps a `set amount` action in sync when the amount is edited', async () => {
      MockDate.set(new Date(2016, 11, 31, 12));
      schedulesApp.startServices();

      try {
        const accountId = await db.insertAccount({
          name: 'Checking',
          offbudget: 0,
          closed: 0,
        });

        const id = await createSchedule({
          schedule: { posts_transaction: true },
          conditions: [
            { op: 'is', field: 'account', value: accountId },
            { op: 'is', field: 'amount', value: -6000 },
            { op: 'is', field: 'date', value: '2016-12-31' },
          ],
        });

        // Some schedules have a rule that also *sets* the amount (e.g. a rule
        // customized via "Edit as rule"). Posting runs the rule, so the action
        // value must track the amount condition.
        const { data: ruleId } = await aqlQuery(
          q('schedules').filter({ id }).calculate('rule'),
        );
        const ruleRow = await db.first<Pick<db.DbRule, 'actions'>>(
          'SELECT actions FROM rules WHERE id = ?',
          [ruleId],
        );
        await updateRule({
          id: ruleId,
          actions: [
            { op: 'set', field: 'amount', value: -6000 },
            ...JSON.parse(ruleRow.actions),
          ],
        });

        // Edit the amount in the schedule editor (condition only).
        await updateSchedule({
          schedule: { id },
          conditions: [
            { op: 'is', field: 'account', value: accountId },
            { op: 'is', field: 'date', value: '2016-12-31' },
            { op: 'is', field: 'amount', value: -8000 },
          ],
        });

        await advanceSchedulesService(true);

        const { data: transactions } = await aqlQuery(
          q('transactions').filter({ schedule: id }).select(['amount']),
        );

        expect(transactions.map(({ amount }) => amount)).toEqual([-8000]);
      } finally {
        MockDate.reset();
        await schedulesApp.stopServices();
      }
    });
  });

  // Posting a specific occurrence from the register used to throw the
  // occurrence date away and date the transaction on the schedule's first
  // un-posted `next_date`, leaving the preview row for the occurrence the user
  // actually clicked in place.
  describe('posting a specific occurrence', () => {
    // `currentDay()` is pinned to 2017-01-01 under test, so the recurrence is
    // built forward from there: a Monday, weekly, five occurrences inside a
    // 30-day preview window.
    const UPCOMING = '30-day';
    const OCCURRENCES = [
      '2017-01-02',
      '2017-01-09',
      '2017-01-16',
      '2017-01-23',
      '2017-01-30',
    ];

    async function createWeeklySchedule() {
      const accountId = await db.insertAccount({
        name: 'Checking',
        offbudget: 0,
        closed: 0,
      });

      const id = await createSchedule({
        schedule: { posts_transaction: true },
        conditions: [
          { op: 'is', field: 'account', value: accountId },
          { op: 'is', field: 'amount', value: -10000 },
          {
            op: 'is',
            field: 'date',
            value: {
              start: OCCURRENCES[0],
              frequency: 'weekly',
              patterns: [],
            },
          },
        ],
      });

      // createSchedule derives next_date from the `start` condition, which is
      // OCCURRENCES[0] — `currentDay()` is pinned under test, so no pinning is
      // needed to make this deterministic.
      return id;
    }

    async function getSchedule(id: string) {
      const { data } = await aqlQuery(
        q('schedules').filter({ id }).select('*'),
      );
      return data[0];
    }

    async function getTransactionDates(id: string) {
      const { data } = await aqlQuery(
        q('transactions')
          .filter({ schedule: id })
          .select(['date'])
          .orderBy({ date: 'asc' }),
      );
      return data.map(({ date }) => date);
    }

    async function getPreviewDates(id: string, upcomingLength = UPCOMING) {
      const schedule = await getSchedule(id);
      const { data: hasTransData } = await aqlQuery(
        getHasTransactionsQuery([schedule]),
      );
      const hasTrans = hasTransData
        .filter(Boolean)
        .some(row => row.schedule === id);

      const statuses: ScheduleStatuses = new Map([
        [
          id,
          getStatus(
            schedule.next_date,
            schedule.completed,
            hasTrans,
            upcomingLength,
          ),
        ],
      ]);

      const { data: posted } = await aqlQuery(
        getPostedScheduleTransactionsQuery([schedule]),
      );

      return computeSchedulePreviewTransactions(
        [schedule],
        statuses,
        upcomingLength,
        undefined,
        indexPostedScheduleTransactions(
          posted.filter(Boolean) as PostedScheduleTransaction[],
        ),
      )
        .filter(({ schedule: scheduleId }) => scheduleId === id)
        .map(({ date }) => date)
        .sort();
    }

    function post(id: string, args: { date?: string; today?: boolean } = {}) {
      return runHandler(schedulesApp.handlers['schedule/post-transaction'], {
        id,
        ...args,
      });
    }

    beforeEach(() => {
      // `_account` and the other rule-derived fields on a schedule only
      // resolve once the JSON-path mappings are populated.
      schedulesApp.startServices();
    });

    afterEach(async () => {
      await schedulesApp.stopServices();
    });

    it('consumes exactly the occurrence that was posted', async () => {
      const id = await createWeeklySchedule();

      expect(await getPreviewDates(id)).toEqual(OCCURRENCES);

      // Post occurrence #1, the schedule's own next_date.
      await post(id, { date: OCCURRENCES[0] });

      expect(await getTransactionDates(id)).toEqual([OCCURRENCES[0]]);
      expect(await getPreviewDates(id)).toEqual(OCCURRENCES.slice(1));

      // Now post occurrence #2 — the bug: this used to create a *second*
      // transaction on occurrence #1's date and leave occurrence #2 previewed.
      await post(id, { date: OCCURRENCES[1] });

      expect(await getTransactionDates(id)).toEqual([
        OCCURRENCES[0],
        OCCURRENCES[1],
      ]);

      // The posted occurrence is gone and the later ones are untouched — one
      // occurrence consumed, not the whole window.
      expect(await getPreviewDates(id)).toEqual(OCCURRENCES.slice(2));
    });

    // The regression that failed QA's T-12 on the previous revision. Posting a
    // LATER occurrence used to walk `next_date` forward over every occurrence
    // between, writing nothing for any of them: the skipped-over occurrence
    // stopped being previewed AND could never be posted, because
    // `getHasTransactionsQuery` only ever asks about `next_date`.
    it('leaves an earlier unpaid occurrence previewed and payable', async () => {
      const id = await createWeeklySchedule();

      // Post occurrence #2 while occurrence #1 is still owed — do NOT post #1
      // first. This is the exact repro.
      await post(id, { date: OCCURRENCES[1] });

      // (a) exactly one transaction, dated on the occurrence that was posted.
      expect(await getTransactionDates(id)).toEqual([OCCURRENCES[1]]);

      // (b) `next_date` stays on the unpaid occurrence, so #1 is still owed.
      expect((await getSchedule(id)).next_date).toBe(OCCURRENCES[0]);

      // (c) #1 is still previewed and every later occurrence is undamaged.
      expect(await getPreviewDates(id)).toEqual([
        OCCURRENCES[0],
        OCCURRENCES[2],
        OCCURRENCES[3],
        OCCURRENCES[4],
      ]);

      // And #1 is genuinely payable: posting it now creates a transaction on
      // its own date rather than duplicating #2.
      await post(id, { date: OCCURRENCES[0] });

      expect(await getTransactionDates(id)).toEqual([
        OCCURRENCES[0],
        OCCURRENCES[1],
      ]);
      expect(await getPreviewDates(id)).toEqual(OCCURRENCES.slice(2));
    });

    it('dates the transaction on the occurrence it was given, not next_date', async () => {
      const id = await createWeeklySchedule();

      await post(id, { date: OCCURRENCES[2] });

      expect(await getTransactionDates(id)).toEqual([OCCURRENCES[2]]);
      expect(await getPreviewDates(id)).not.toContain(OCCURRENCES[2]);
    });

    it('stamps the occurrence that was posted, not the next_date it sat on', async () => {
      // The occurrence stamp is the identity the whole per-occurrence model
      // rests on: the register drops an occurrence by matching on it, so a
      // stamp naming `next_date` would leave the occurrence the user actually
      // posted still previewed.
      const id = await createWeeklySchedule();

      await post(id, { date: OCCURRENCES[2] });

      const { data } = await aqlQuery(
        q('transactions')
          .filter({ schedule: id })
          .select(['schedule_occurrence']),
      );

      expect(data[0].schedule_occurrence).toBe(OCCURRENCES[2]);
      expect((await getSchedule(id)).next_date).toBe(OCCURRENCES[0]);
    });

    it('posts on next_date and leaves it alone when no date is given', async () => {
      // The Schedules page and auto-posting both send a bare id, and neither
      // may advance the schedule: `advanceSchedulesService` owns `next_date`.
      const id = await createWeeklySchedule();

      await post(id);

      expect(await getTransactionDates(id)).toEqual([OCCURRENCES[0]]);
      expect((await getSchedule(id)).next_date).toBe(OCCURRENCES[0]);
    });

    it("'post today' dates today and does not consume the occurrence", async () => {
      const id = await createWeeklySchedule();

      await post(id, { date: OCCURRENCES[2], today: true });

      expect(await getTransactionDates(id)).toEqual(['2017-01-01']);
      expect((await getSchedule(id)).next_date).toBe(OCCURRENCES[0]);
      expect(await getPreviewDates(id)).toContain(OCCURRENCES[2]);
    });

    it('adds a second transaction on a later occurrence rather than repeating the first', async () => {
      const id = await createWeeklySchedule();

      await post(id, { date: OCCURRENCES[0] });
      await post(id, { date: OCCURRENCES[3] });

      const dates = await getTransactionDates(id);

      expect(dates).toEqual([OCCURRENCES[0], OCCURRENCES[3]]);
      // AC-6: no two posted transactions share a date.
      expect(new Set(dates).size).toBe(dates.length);
    });

    it('consumes every occurrence when posted in order', async () => {
      const id = await createWeeklySchedule();

      for (const occurrence of OCCURRENCES) {
        await post(id, { date: occurrence });

        const posted = await getTransactionDates(id);
        expect(posted).toContain(occurrence);
        expect(await getPreviewDates(id)).not.toContain(occurrence);
        // Every later occurrence is still previewed: a post consumes exactly
        // one occurrence, never the rest of the window.
        expect(await getPreviewDates(id)).toEqual(
          OCCURRENCES.slice(OCCURRENCES.indexOf(occurrence) + 1),
        );
      }

      const dates = await getTransactionDates(id);
      expect(dates).toEqual(OCCURRENCES);
      // AC-6.
      expect(new Set(dates).size).toBe(dates.length);
      // AC-6: nothing is ever dated before the occurrence that was selected.
      expect(await getPreviewDates(id)).toEqual([]);
    });

    it('consumes an occurrence further out than any fixed step budget', async () => {
      // A daily schedule over a long upcoming window previews hundreds of
      // occurrences, and `CustomUpcomingLength` puts no upper bound on the
      // window — so the gap between next_date and the clicked occurrence is
      // not bounded by anything the user controls. The occurrence consumed
      // here is found by matching, not by stepping that gap.
      const START = '2017-01-02';
      const GAP = 150;
      const TARGET = dayFromDate(d.addDays(parseDate(START), GAP));

      const accountId = await db.insertAccount({
        name: 'Checking',
        offbudget: 0,
        closed: 0,
      });

      const id = await createSchedule({
        schedule: { posts_transaction: true },
        conditions: [
          { op: 'is', field: 'account', value: accountId },
          { op: 'is', field: 'amount', value: -10000 },
          {
            op: 'is',
            field: 'date',
            value: { start: START, frequency: 'daily', patterns: [] },
          },
        ],
      });

      await post(id, { date: TARGET });

      // The transaction lands on the requested date regardless.
      expect(await getTransactionDates(id)).toEqual([TARGET]);

      const preview = await getPreviewDates(id, '1-year');
      expect(preview).not.toContain(TARGET);
      // The occurrences after it are still previewed.
      expect(preview.length).toBeGreaterThan(0);
    });

    describe('consuming an occurrence twice', async () => {
      // The occurrence stamp IS the identity this whole design rests on, so a
      // handler that can write it twice makes it meaningless. These two calls
      // are what a double-clicked menu item or a redelivered message look
      // like.
      it('writes one transaction when posted twice in sequence', async () => {
        const id = await createWeeklySchedule();

        await post(id, { date: OCCURRENCES[1] });
        await post(id, { date: OCCURRENCES[1] });

        expect(await getTransactionDates(id)).toEqual([OCCURRENCES[1]]);

        const { data } = await aqlQuery(
          q('transactions')
            .filter({ schedule: id })
            .select(['schedule_occurrence']),
        );
        expect(
          data.map(({ schedule_occurrence }) => schedule_occurrence),
        ).toEqual([OCCURRENCES[1]]);
      });

      it('writes one transaction when both calls are dispatched together', async () => {
        const id = await createWeeklySchedule();

        // Not awaited individually: the second call is queued behind the
        // first, because `runHandler` routes a mutating handler through the
        // sequential `runMutator`. If this ever fails, the guard is in the
        // wrong place — do not weaken the test.
        await Promise.all([
          post(id, { date: OCCURRENCES[1] }),
          post(id, { date: OCCURRENCES[1] }),
        ]);

        expect(await getTransactionDates(id)).toEqual([OCCURRENCES[1]]);
      });

      // Splitting is not an edge case here: it is what the register's Split
      // affordance does to a posted transaction, and it moves the occurrence
      // stamp onto a row the guard's default query cannot see.
      //
      // Every assertion below goes through `readStampedRows` rather than
      // `getTransactionDates`, because that helper queries with the default
      // 'inline' splits and reports zero rows for a split parent — reusing it
      // would make a correct implementation look broken.
      async function readStampedRows(scheduleId: string, occurrence?: string) {
        const { data } = await aqlQuery(
          q('transactions')
            .options({ splits: 'all' })
            .filter({
              schedule: scheduleId,
              ...(occurrence != null
                ? { schedule_occurrence: occurrence }
                : {}),
            })
            .select(['id', 'is_parent', 'date', 'schedule_occurrence'])
            .orderBy({ date: 'asc' }),
        );
        return data;
      }

      // Driven through the same two calls the UI makes, so a failure here is
      // attributable to the guard rather than to a hand-written row that never
      // went through the split.
      async function splitPostedTransaction(
        scheduleId: string,
        occurrence: string,
      ) {
        const [parent] = await readStampedRows(scheduleId, occurrence);
        const { diff } = splitTransaction(
          [await db.getTransaction(parent.id)],
          parent.id,
          makeEmptySplitSubtransactions,
        );

        await runHandler(
          transactionsApp.handlers['transactions-batch-update'],
          diff,
        );
      }

      // The split parent and its children — the only place the stamp's fate
      // across a split is observable. `splits: 'all'` is required: the default
      // 'inline' hides the split parent, which is the row carrying the stamp.
      async function readSplitFamily(parentId: string) {
        const { data } = await aqlQuery(
          q('transactions')
            .options({ splits: 'all' })
            .filter({ $or: [{ id: parentId }, { parent_id: parentId }] })
            .select([
              'id',
              'is_parent',
              'parent_id',
              'schedule',
              'schedule_occurrence',
            ]),
        );
        return data;
      }

      it('writes no second transaction when the posted one has been split', async () => {
        const id = await createWeeklySchedule();

        // Posted with no `date`, which is what the Schedules page's menu item
        // sends: the occurrence is `next_date`, and a second such call targets
        // the same one.
        await post(id);
        await splitPostedTransaction(id, OCCURRENCES[0]);
        await post(id);

        // The split parent, and nothing else. Before the guard was widened to
        // read split parents, this second post wrote a fresh un-split row and
        // the occurrence was paid twice.
        const stamped = await readStampedRows(id, OCCURRENCES[0]);
        expect(stamped).toHaveLength(1);
        expect(stamped[0].is_parent).toBe(true);
      });

      it('keeps the occurrence stamp on the split parent and off its children', async () => {
        // Isolates WHERE the stamp lives, so a failure in the case above is
        // attributable to the guard's row set rather than to the split having
        // dropped or duplicated the stamp. It is also why the guard has to
        // widen: the stamp survives on exactly one row, and it is a parent.
        const id = await createWeeklySchedule();

        await post(id);
        const [parent] = await readStampedRows(id, OCCURRENCES[0]);
        await splitPostedTransaction(id, OCCURRENCES[0]);

        const family = await readSplitFamily(parent.id);
        const splitParent = family.find(row => row.id === parent.id);
        expect(splitParent).toMatchObject({ is_parent: true, schedule: id });

        // Read through `readStampedRows` as well, which filters on the
        // occurrence too.
        expect(
          (await readStampedRows(id, OCCURRENCES[0])).map(row => row.id),
        ).toEqual([parent.id]);

        // makeChild copies neither field, so a widened guard cannot newly
        // match a child and over-block on it.
        const children = family.filter(row => row.parent_id === parent.id);
        expect(children).toHaveLength(2);
        for (const child of children) {
          expect(child.schedule).toBeFalsy();
          expect(child.schedule_occurrence).toBeFalsy();
        }
      });

      it('does not let a split occurrence mark a later one paid', async () => {
        // The direction the widening could plausibly over-reach: a guard that
        // matched on anything coarser than an exact stamp — the date, the
        // schedule alone — would swallow the next, still-owed occurrence and a
        // payment would silently not happen.
        const id = await createWeeklySchedule();

        await post(id);
        await splitPostedTransaction(id, OCCURRENCES[0]);
        await post(id, { date: OCCURRENCES[1] });

        const stamped = await readStampedRows(id);
        expect(stamped.map(row => row.schedule_occurrence)).toEqual([
          OCCURRENCES[0],
          OCCURRENCES[1],
        ]);
        expect(await readStampedRows(id, OCCURRENCES[1])).toHaveLength(1);
      });

      it('still reports a split-parented occurrence as posted', async () => {
        // Both status queries read split parents, so the split parent stamped
        // for this occurrence keeps the Schedules page showing it as paid.
        // That they agree with the guard is pinned by the sibling case above,
        // 'writes no second transaction when the posted one has been split' —
        // which is the one that fails if the guard stops reading split parents.
        // This case does not drive a second post, so it cannot pin that.
        const id = await createWeeklySchedule();

        await post(id);
        await splitPostedTransaction(id, OCCURRENCES[0]);

        const schedule = await getSchedule(id);

        const { data: hasTrans } = await aqlQuery(
          getHasTransactionsQuery([schedule]),
        );
        expect(
          hasTrans.filter(Boolean).filter(row => row.schedule === id),
        ).toHaveLength(1);

        const { data: posted } = await aqlQuery(
          getPostedScheduleTransactionsQuery([schedule]),
        );
        expect(
          posted
            .filter(Boolean)
            .filter(row => row.schedule === id)
            .map(row => row.schedule_occurrence),
        ).toEqual([OCCURRENCES[0]]);
      });

      it('does not guard `today`, which may legitimately be posted twice', async () => {
        // `today` pays `next_date` early and deliberately leaves that
        // occurrence pending, so paying it again must still write again.
        const id = await createWeeklySchedule();

        await post(id, { date: OCCURRENCES[1], today: true });
        await post(id, { date: OCCURRENCES[1], today: true });

        expect(await getTransactionDates(id)).toEqual([
          '2017-01-01',
          '2017-01-01',
        ]);
        expect(await getPreviewDates(id)).toContain(OCCURRENCES[1]);
      });
    });

    // `next_date` has exactly one owner now: `advanceSchedulesService`. Posting
    // no longer moves it, so a schedule left pointing at an occurrence the user
    // posted PAST is still owed that occurrence — and the service must post it
    // rather than walk past it.
    describe('auto-posting a schedule left behind by an out-of-order post', async () => {
      const MISSED = '2016-12-26';
      const SKIPPED_PAST = '2017-01-02';

      async function createOverdueWeeklySchedule() {
        const accountId = await db.insertAccount({
          name: 'Checking',
          offbudget: 0,
          closed: 0,
        });

        const id = await createSchedule({
          schedule: { posts_transaction: true },
          conditions: [
            { op: 'is', field: 'account', value: accountId },
            { op: 'is', field: 'amount', value: -10000 },
            {
              op: 'is',
              field: 'date',
              value: { start: MISSED, frequency: 'weekly', patterns: [] },
            },
          ],
        });

        // `createSchedule` derives next_date from today onwards; pin it to an
        // occurrence that has already passed.
        const nextDateRow = await db.first<{ id: string }>(
          'SELECT id FROM schedules_next_date WHERE schedule_id = ?',
          [id],
        );
        await db.update('schedules_next_date', {
          id: nextDateRow.id,
          local_next_date: toDateRepr(MISSED),
          local_next_date_ts: Date.now(),
          base_next_date: toDateRepr(MISSED),
          base_next_date_ts: Date.now(),
        });

        return id;
      }

      it('posts the occurrence the user skipped past, not the one after it', async () => {
        const id = await createOverdueWeeklySchedule();

        // The user posts a later occurrence while the earlier one is unpaid.
        await post(id, { date: SKIPPED_PAST });

        expect((await getSchedule(id)).next_date).toBe(MISSED);

        await advanceSchedulesService(true);

        // The skipped-over occurrence is auto-posted — it was never paid — and
        // the already-paid one is not posted a second time.
        expect(await getTransactionDates(id)).toEqual([MISSED, SKIPPED_PAST]);

        // No gap: next_date lands on the occurrence after the one already paid.
        expect((await getSchedule(id)).next_date).toBe('2017-01-09');
      });

      it('does not double-advance across a second sync', async () => {
        const id = await createOverdueWeeklySchedule();

        await post(id, { date: SKIPPED_PAST });
        await advanceSchedulesService(true);
        expect((await getSchedule(id)).next_date).toBe('2017-01-09');

        await advanceSchedulesService(true);

        expect((await getSchedule(id)).next_date).toBe('2017-01-09');
        expect(await getTransactionDates(id)).toEqual([MISSED, SKIPPED_PAST]);
      });
    });
  });

  // Which schedule OCCURRENCE a transaction was posted for, as opposed to the
  // date it happens to carry. The date is the user's to edit; the occurrence is
  // not, and every matcher below has to key on the latter.
  describe('occurrence stamp', () => {
    // `currentDay()` is pinned to 2017-01-01 under test, so the occurrence a
    // schedule is sitting on is the one before it.
    const NEXT_DATE = '2016-12-02';

    async function createRecurringSchedule({
      postsTransaction = false,
    }: { postsTransaction?: boolean } = {}) {
      MockDate.set(new Date(2016, 11, 31, 12));
      schedulesApp.startServices();

      const accountId = await db.insertAccount({
        name: 'Checking',
        offbudget: 0,
        closed: 0,
      });

      const id = await createSchedule({
        schedule: { posts_transaction: postsTransaction },
        conditions: [
          { op: 'is', field: 'account', value: accountId },
          { op: 'is', field: 'amount', value: -10000 },
          {
            op: 'is',
            field: 'date',
            value: { start: NEXT_DATE, frequency: 'monthly', patterns: [] },
          },
        ],
      });

      const nextDateRow = await db.first<{ id: string }>(
        'SELECT id FROM schedules_next_date WHERE schedule_id = ?',
        [id],
      );
      await db.update('schedules_next_date', {
        id: nextDateRow.id,
        local_next_date: toDateRepr(NEXT_DATE),
        local_next_date_ts: Date.now(),
        base_next_date: toDateRepr(NEXT_DATE),
        base_next_date_ts: Date.now(),
      });

      return { accountId, id };
    }

    async function readSchedule(scheduleId: string) {
      const {
        data: [schedule],
      } = await aqlQuery(q('schedules').filter({ id: scheduleId }).select('*'));
      return schedule;
    }

    async function postTransaction(scheduleId: string, today?: boolean) {
      await runHandler(schedulesApp.handlers['schedule/post-transaction'], {
        id: scheduleId,
        today,
      });
    }

    async function readPostedTransaction(scheduleId: string) {
      const {
        data: [transaction],
      } = await aqlQuery(
        q('transactions')
          .filter({ schedule: scheduleId })
          .select(['id', 'schedule', 'date', 'schedule_occurrence']),
      );
      return transaction;
    }

    async function updatePostedTransaction(
      scheduleId: string,
      fields: { date?: string; schedule_occurrence?: string },
    ) {
      const { id } = await readPostedTransaction(scheduleId);
      await db.update('transactions', {
        id,
        ...fields,
        ...(fields.date && { date: toDateRepr(fields.date) }),
        ...(fields.schedule_occurrence && {
          schedule_occurrence: toDateRepr(fields.schedule_occurrence),
        }),
      });
    }

    // What `getHasTransactionsQuery` says about the schedule: zero rows means
    // the occurrence reads as un-paid, which is what regenerates the forecast
    // row and flips the Schedules page back to "Due".
    async function readMatches(scheduleId: string) {
      const { data } = await aqlQuery(
        getHasTransactionsQuery([await readSchedule(scheduleId)]),
      );
      return data.filter(Boolean);
    }

    it('stamps the occurrence when posting a schedule', async () => {
      try {
        const { id } = await createRecurringSchedule();

        await postTransaction(id);

        expect(await readPostedTransaction(id)).toMatchObject({
          schedule: id,
          date: NEXT_DATE,
          schedule_occurrence: NEXT_DATE,
        });
      } finally {
        await schedulesApp.stopServices();
      }
    });

    it('stamps the occurrence, not the date, when posting today', async () => {
      try {
        // next_date is yesterday and "today" is 2017-01-01, so the two differ.
        const { id } = await createRecurringSchedule();

        await postTransaction(id, true);

        expect(await readPostedTransaction(id)).toMatchObject({
          date: currentDay(),
          schedule_occurrence: NEXT_DATE,
        });
      } finally {
        await schedulesApp.stopServices();
      }
    });

    it('still pays the occurrence after the payment is re-dated 7 days early', async () => {
      try {
        const { id } = await createRecurringSchedule();
        await postTransaction(id);

        expect(await readMatches(id)).toHaveLength(1);

        // The reported bug: the user moves the payment to an earlier day and
        // the schedule comes back as an un-posted forecast row.
        await updatePostedTransaction(id, { date: subDays(NEXT_DATE, 7) });

        expect(await readMatches(id)).toHaveLength(1);
      } finally {
        await schedulesApp.stopServices();
      }
    });

    it('does not pay the current occurrence for a payment stamped for the previous one', async () => {
      try {
        const { id } = await createRecurringSchedule();
        await postTransaction(id);

        // Re-stamped for the previous occurrence AND dated late, inside any
        // plausible grace, so this cannot pass vacuously.
        await updatePostedTransaction(id, {
          schedule_occurrence: subDays(NEXT_DATE, 1),
          date: subDays(NEXT_DATE, 4),
        });

        expect(await readMatches(id)).toHaveLength(0);
      } finally {
        await schedulesApp.stopServices();
      }
    });

    it('still pays the occurrence for a payment dated after it', async () => {
      // The guard against over-correcting: an upper bound on the date would
      // break every payment made a few days late.
      try {
        const { id } = await createRecurringSchedule();
        await postTransaction(id);

        await updatePostedTransaction(id, { date: addDays(NEXT_DATE, 8) });

        expect(await readMatches(id)).toHaveLength(1);

        await advanceSchedulesService(true);

        expect((await readSchedule(id)).next_date).toBe('2017-01-02');
      } finally {
        await schedulesApp.stopServices();
      }
    });

    it('keeps matching unstamped transactions by the unchanged date bound', async () => {
      // Every budget that already exists has transactions with no stamp.
      try {
        const { accountId, id } = await createRecurringSchedule();

        await db.insertTransaction({
          account: accountId,
          amount: -10000,
          date: NEXT_DATE,
          schedule: id,
        });

        expect(await readMatches(id)).toHaveLength(1);
      } finally {
        await schedulesApp.stopServices();
      }
    });

    it('stays paid after the posted transaction is merged with an earlier duplicate', async () => {
      // The user posts an occurrence, then tidies the register by merging the
      // payment with an identical one they dated weeks earlier. Before the
      // stamp travelled with the schedule link, the survivor kept the link but
      // lost the identity, matched neither branch of getHasTransactionsQuery,
      // and the occurrence flipped back to "Due" with its forecast row.
      try {
        const { accountId, id } = await createRecurringSchedule();
        await postTransaction(id);

        expect(await readMatches(id)).toHaveLength(1);

        // Same account and the SAME amount — validForMergeExplanation rejects
        // a mismatch. A plain 'YYYY-MM-DD' string: toDateRepr is for the db
        // update path only and throws `Invalid date` on an insert.
        const duplicateId = await db.insertTransaction({
          account: accountId,
          amount: -10000,
          date: subDays(NEXT_DATE, 21),
          category: null,
        });

        const { id: postedId } = await readPostedTransaction(id);
        const keptId = await mergeTransactions([
          { id: postedId },
          { id: duplicateId },
        ]);

        expect(await db.getTransaction(keptId)).toMatchObject({
          schedule: id,
          schedule_occurrence: NEXT_DATE,
        });

        // Asserted through readMatches, not a raw SELECT: the dropped row is
        // tombstoned rather than physically deleted.
        expect(await readMatches(id)).toHaveLength(1);
      } finally {
        await schedulesApp.stopServices();
      }
    });

    it('settles next_date instead of advancing without bound', async () => {
      // If the fallback branch ever compiled to OR, every schedule-linked
      // transaction would match every occurrence and this would never settle.
      try {
        const { id } = await createRecurringSchedule({
          postsTransaction: true,
        });
        await postTransaction(id);

        await advanceSchedulesService(true);

        expect((await readSchedule(id)).next_date).toBe('2017-01-02');
      } finally {
        MockDate.reset();
        await schedulesApp.stopServices();
      }
    });
  });
});
