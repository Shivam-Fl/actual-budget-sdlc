import * as d from 'date-fns';
// @ts-strict-ignore
import MockDate from 'mockdate';

import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { runHandler } from '#server/mutators';
import { loadRules, updateRule } from '#server/transactions/transaction-rules';
import { dayFromDate, parseDate } from '#shared/months';
import { q } from '#shared/query';
import {
  computeSchedulePreviewTransactions,
  getHasTransactionsQuery,
  getNextDate,
  getStatus,
} from '#shared/schedules';
import type { ScheduleStatuses } from '#shared/schedules';

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

      return computeSchedulePreviewTransactions(
        [schedule],
        statuses,
        upcomingLength,
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

      // next_date lands ON the posted occurrence, which is what makes the
      // status 'paid' and drops it from the preview list.
      expect((await getSchedule(id)).next_date).toBe(OCCURRENCES[1]);

      // The posted occurrence is gone and the later ones are untouched — one
      // occurrence consumed, not the whole window.
      expect(await getPreviewDates(id)).toEqual(OCCURRENCES.slice(2));
    });

    it('dates the transaction on the occurrence it was given, not next_date', async () => {
      const id = await createWeeklySchedule();

      await post(id, { date: OCCURRENCES[2] });

      expect(await getTransactionDates(id)).toEqual([OCCURRENCES[2]]);
      expect(await getPreviewDates(id)).not.toContain(OCCURRENCES[2]);
    });

    it('posts on next_date and leaves it alone when no date is given', async () => {
      // The Schedules page and auto-posting both send a bare id.
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

    it('does not double-advance when the service later runs', async () => {
      const id = await createWeeklySchedule();

      await post(id, { date: OCCURRENCES[1] });
      expect((await getSchedule(id)).next_date).toBe(OCCURRENCES[1]);

      // Auto-posting advances the schedule itself, so an advance from the post
      // above too would skip occurrence #3 entirely.
      await advanceSchedulesService(true);

      expect((await getSchedule(id)).next_date).toBe(OCCURRENCES[2]);
    });

    it('consumes an occurrence further out than any fixed step budget', async () => {
      // A daily schedule over a long upcoming window previews hundreds of
      // occurrences, and `CustomUpcomingLength` puts no upper bound on the
      // window — so the gap between next_date and the clicked occurrence is
      // not bounded by anything the user controls. Whatever step budget the
      // advance uses, this gap must not exceed it.
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

      // next_date must land ON the posted occurrence, so the status is 'paid'
      // and that occurrence drops out of the preview list.
      expect((await getSchedule(id)).next_date).toBe(TARGET);

      const preview = await getPreviewDates(id, '1-year');
      expect(preview).not.toContain(TARGET);
      // The occurrences after it are still previewed.
      expect(preview.length).toBeGreaterThan(0);
    });
  });
});
