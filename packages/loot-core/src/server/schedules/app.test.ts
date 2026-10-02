// @ts-strict-ignore
import MockDate from 'mockdate';

import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { toDateRepr } from '#server/models';
import { runHandler } from '#server/mutators';
import { loadRules, updateRule } from '#server/transactions/transaction-rules';
import { addDays, currentDay, subDays } from '#shared/months';
import { q } from '#shared/query';
import { getHasTransactionsQuery, getNextDate } from '#shared/schedules';

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
