import MockDate from 'mockdate';

import { compileQuery, schema, schemaConfig } from '#server/aql';
import type { RuleConditionEntity, ScheduleEntity } from '#types/models';

import * as monthUtils from './months';
import {
  computeSchedulePreviewTransactions,
  getHasTransactionsQuery,
  getNextDate,
  getNextDateAfter,
  getPostedScheduleTransactionsQuery,
  getScheduleOccurrenceMatchStartDate,
  getStatus,
  getUpcomingDays,
  indexPostedScheduleTransactions,
  isCustomUpcomingLength,
  isScheduleOccurrencePosted,
  UPCOMING_LENGTH_PRESET_LABELS,
  UPCOMING_LENGTH_PRESET_OPTIONS,
  UPCOMING_LENGTH_PRESET_VALUES,
} from './schedules';
import type {
  PostedScheduleTransaction,
  ScheduleOccurrenceMatchInput,
  ScheduleStatuses,
} from './schedules';

describe('schedules', () => {
  const today = new Date(2017, 0, 1); // Global date when testing is set to 2017-01-01 per monthUtils.currentDay()
  const dateFormat = 'yyyy-MM-dd';
  const todayString = monthUtils.format(today, dateFormat);

  beforeEach(() => {
    MockDate.set(new Date(2021, 4, 14));
  });
  afterEach(() => {
    MockDate.reset();
  });

  describe('getStatus', () => {
    it('returns completed if completed', () => {
      expect(getStatus(todayString, true, false, '7')).toBe('completed');
    });

    it('returns paid if has transactions', () => {
      expect(getStatus(todayString, false, true, '7')).toBe('paid');
    });

    it('returns due if today', () => {
      expect(getStatus(todayString, false, false, '7')).toBe('due');
    });

    it.each([1, 7, 14, 30])(
      'returns upcoming if within upcoming range %n',
      (upcomingLength: number) => {
        const daysOut = upcomingLength;
        const tomorrow = monthUtils.addDays(today, 1);
        const upcomingDate = monthUtils.addDays(today, daysOut);
        const scheduledDate = monthUtils.addDays(today, daysOut + 1);
        expect(
          getStatus(tomorrow, false, false, upcomingLength.toString()),
        ).toBe('upcoming');
        expect(
          getStatus(upcomingDate, false, false, upcomingLength.toString()),
        ).toBe('upcoming');
        expect(
          getStatus(scheduledDate, false, false, upcomingLength.toString()),
        ).toBe('scheduled');
      },
    );

    it('returns missed if past', () => {
      expect(getStatus(monthUtils.addDays(today, -1), false, false, '7')).toBe(
        'missed',
      );
    });

    it('returns scheduled if not due, upcoming, or missed', () => {
      expect(getStatus(monthUtils.addDays(today, 8), false, false, '7')).toBe(
        'scheduled',
      );
    });
  });

  describe('getUpcomingDays', () => {
    it.each([
      ['1', 1, '2017-01-01'],
      ['7', 7, '2017-01-01'],
      ['14', 14, '2017-01-01'],
      ['oneMonth', 31, '2017-01-01'],
      ['oneMonth', 30, '2017-04-01'],
      ['oneMonth', 30, '2017-04-15'],
      ['oneMonth', 28, '2017-02-01'],
      ['oneMonth', 29, '2020-02-01'], // leap-year
      ['currentMonth', 30, '2017-01-01'],
      ['currentMonth', 27, '2017-02-01'],
      ['currentMonth', 20, '2017-02-08'],
      ['currentMonth', 28, '2020-02-01'], // leap-year
      ['2-day', 2, '2017-01-01'],
      ['5-week', 35, '2017-01-01'],
      ['3-month', 91, '2017-01-01'],
      ['4-year', 1462, '2017-01-01'],
      ['1-year', 366, '2017-06-15'], // Test year from mid-year (Jun 1, 2017 to Jun 1, 2018 + 1)
      ['1-year', 367, '2019-06-15'], // Test year from mid-year with leap year 2020
      ['2-year', 731, '2017-06-15'], // Test 2 years from mid-year (Jun 1, 2017 to Jun 1, 2019 + 1)
    ])(
      'value of %s on returns %i days on %s',
      (value: string, expected: number, date: string) => {
        expect(getUpcomingDays(value, date)).toEqual(expected);
      },
    );
  });

  describe('computeSchedulePreviewTransactions', () => {
    describe('forceUpcoming flag', () => {
      function makeSchedule(
        overrides: Partial<ScheduleEntity> &
          Pick<ScheduleEntity, 'id' | 'next_date' | '_conditions'>,
      ): ScheduleEntity {
        return {
          rule: 'rule-1',
          completed: false,
          posts_transaction: false,
          tombstone: false,
          _payee: 'payee-1',
          _account: 'acct-1',
          _amount: -10000,
          _amountOp: 'is',
          _date: overrides.next_date,
          _actions: [],
          ...overrides,
        };
      }

      it('sets forceUpcoming=false for past dates of a missed recurring schedule', () => {
        const schedule = makeSchedule({
          id: 'sched-1',
          next_date: '2016-12-19',
          _conditions: [
            {
              field: 'date',
              op: 'isapprox',
              value: { start: '2016-12-01', frequency: 'weekly' },
            },
          ],
        });

        const statuses: ScheduleStatuses = new Map([['sched-1', 'missed']]);
        const result = computeSchedulePreviewTransactions(
          [schedule],
          statuses,
          '7',
        );

        const pastEntries = result.filter(r => r.date < '2017-01-01');
        expect(pastEntries.length).toBeGreaterThan(0);
        expect(pastEntries.every(r => r.forceUpcoming === false)).toBe(true);
      });

      it('sets forceUpcoming=true for future dates that differ from next_date', () => {
        const schedule = makeSchedule({
          id: 'sched-1',
          next_date: '2016-12-19',
          _conditions: [
            {
              field: 'date',
              op: 'isapprox',
              value: { start: '2016-12-01', frequency: 'weekly' },
            },
          ],
        });

        const statuses: ScheduleStatuses = new Map([['sched-1', 'missed']]);
        const result = computeSchedulePreviewTransactions(
          [schedule],
          statuses,
          '7',
        );

        const futureEntries = result.filter(r => r.date > '2017-01-01');
        expect(futureEntries.length).toBeGreaterThan(0);
        expect(futureEntries.every(r => r.forceUpcoming === true)).toBe(true);
      });

      it('sets forceUpcoming=false for next_date when not paid', () => {
        const schedule = makeSchedule({
          id: 'sched-1',
          next_date: '2017-01-03',
          _conditions: [{ field: 'date', op: 'is', value: '2017-01-03' }],
        });

        const statuses: ScheduleStatuses = new Map([['sched-1', 'upcoming']]);
        const result = computeSchedulePreviewTransactions(
          [schedule],
          statuses,
          '7',
        );

        expect(result).toHaveLength(1);
        expect(result[0].forceUpcoming).toBe(false);
      });

      it('shifts next_date and forces upcoming for paid schedules', () => {
        const schedule = makeSchedule({
          id: 'sched-1',
          next_date: '2017-01-02',
          _conditions: [
            {
              field: 'date',
              op: 'isapprox',
              value: { start: '2016-12-01', frequency: 'weekly' },
            },
          ],
        });

        const statuses: ScheduleStatuses = new Map([['sched-1', 'paid']]);
        const result = computeSchedulePreviewTransactions(
          [schedule],
          statuses,
          '7',
        );

        expect(result.find(r => r.date === '2017-01-02')).toBeUndefined();
        expect(
          result
            .filter(r => r.date >= '2017-01-01')
            .every(r => r.forceUpcoming === true),
        ).toBe(true);
      });
    });

    it('does not crash when a recurring schedule has an end date in the past', () => {
      function makeSchedule(
        overrides: Partial<ScheduleEntity> &
          Pick<ScheduleEntity, 'id' | 'next_date' | '_conditions'>,
      ): ScheduleEntity {
        return {
          rule: 'rule-1',
          completed: false,
          posts_transaction: false,
          tombstone: false,
          _payee: 'payee-1',
          _account: 'acct-1',
          _amount: -10000,
          _amountOp: 'is',
          _date: overrides.next_date,
          _actions: [],
          ...overrides,
        };
      }

      // Schedule that recurs monthly but ended in the past (2016-08-25)
      // while current date is 2017-01-01
      const schedule = makeSchedule({
        id: 'sched-expired',
        next_date: '2016-08-25',
        _conditions: [
          {
            field: 'date',
            op: 'isapprox',
            value: {
              start: '2016-01-25',
              frequency: 'monthly',
              endMode: 'on_date',
              endDate: '2016-08-25',
            },
          },
        ],
      });

      const statuses: ScheduleStatuses = new Map([['sched-expired', 'missed']]);
      const result = computeSchedulePreviewTransactions(
        [schedule],
        statuses,
        '7',
      );

      // Should not crash; schedule with past end date produces its next_date entry only
      expect(result).toBeDefined();
    });

    // A skipped occurrence writes no transaction, so the occurrence stamp
    // cannot see it. The skip list is the only record that the date will not
    // happen, and this is the only place that decides what the register lists.
    describe('skipped occurrences', () => {
      function makeWeeklySchedule(
        skipped_occurrences?: string[] | null,
      ): ScheduleEntity {
        return {
          id: 'sched-1',
          rule: 'rule-1',
          completed: false,
          posts_transaction: false,
          tombstone: false,
          _payee: 'payee-1',
          _account: 'acct-1',
          _amount: -10000,
          _amountOp: 'is',
          _date: '2017-01-02',
          _actions: [],
          next_date: '2017-01-02',
          skipped_occurrences,
          _conditions: [
            {
              field: 'date',
              op: 'isapprox',
              value: { start: '2017-01-02', frequency: 'weekly' },
            },
          ],
        };
      }

      const UPCOMING_DATES = [
        '2017-01-02',
        '2017-01-09',
        '2017-01-16',
        '2017-01-23',
        '2017-01-30',
      ];

      function preview(schedule: ScheduleEntity) {
        const statuses: ScheduleStatuses = new Map([['sched-1', 'upcoming']]);
        return computeSchedulePreviewTransactions(
          [schedule],
          statuses,
          '30-day',
        )
          .map(({ date }) => date)
          .sort();
      }

      it('omits a skipped date and keeps every other occurrence', () => {
        const result = preview(makeWeeklySchedule(['2017-01-16']));

        expect(result).toEqual(
          UPCOMING_DATES.filter(date => date !== '2017-01-16'),
        );
      });

      it('previews exactly as before when nothing is skipped', () => {
        // Guards the filter against the failure mode it shares with the
        // forecast's: reading a field that is absent everywhere and quietly
        // dropping everything.
        expect(preview(makeWeeklySchedule())).toEqual(UPCOMING_DATES);
        expect(preview(makeWeeklySchedule(null))).toEqual(UPCOMING_DATES);
        expect(preview(makeWeeklySchedule([]))).toEqual(UPCOMING_DATES);
      });

      it('skips the third of five weekly occurrences and keeps the other four', () => {
        const result = preview(makeWeeklySchedule(['2017-01-16']));

        expect(result).toHaveLength(4);
        expect(result).not.toContain('2017-01-16');
        expect(result).toContain('2017-01-09');
        expect(result).toContain('2017-01-30');
      });

      it('skips several occurrences at once', () => {
        const result = preview(
          makeWeeklySchedule(['2017-01-09', '2017-01-23']),
        );

        expect(result).toEqual(['2017-01-02', '2017-01-16', '2017-01-30']);
      });

      it('does not disturb the `paid` shift', () => {
        // `status` describes `next_date` only, and a skip never moves
        // `next_date`, so the shift consumes the head and a skipped date is
        // still honoured independently of it.
        const schedule = makeWeeklySchedule(['2017-01-16']);
        const statuses: ScheduleStatuses = new Map([['sched-1', 'paid']]);
        const result = computeSchedulePreviewTransactions(
          [schedule],
          statuses,
          '30-day',
        )
          .map(({ date }) => date)
          .sort();

        expect(result).toEqual(['2017-01-09', '2017-01-23', '2017-01-30']);
        // The head was shifted off, and the skip took one more out — neither
        // swallowed the other.
        expect(result).not.toContain('2017-01-02');
        expect(result).not.toContain('2017-01-16');
      });

      it('ignores a skipped date that is not an occurrence of the recurrence', () => {
        // A stale id from a stale register row records a date nothing matches;
        // it must not remove a real occurrence.
        const result = preview(makeWeeklySchedule(['2017-01-17']));

        expect(result).toEqual(UPCOMING_DATES);
      });
    });
  });

  describe('getHasTransactionsQuery', () => {
    it('matches nothing when there are no schedules', () => {
      // An empty `$or` compiles away to no constraint at all, which would make
      // this scan every transaction in the budget. It must never do that.
      const filters = getHasTransactionsQuery([]).serialize().filterExpressions;

      expect(filters).toEqual([{ id: null }]);
      expect(filters[0]).not.toHaveProperty('$or');
    });

    it('matches the occurrence stamp first, falling back to the date bound', () => {
      const filters = getHasTransactionsQuery([
        {
          id: 'schedule-1',
          next_date: '2024-03-10',
          _conditions: [{ op: 'is', field: 'date', value: '2024-03-10' }],
        },
      ]).serialize().filterExpressions;

      expect(filters).toEqual([
        {
          $or: [
            {
              $and: {
                schedule: 'schedule-1',
                $or: [
                  { schedule_occurrence: '2024-03-10' },
                  {
                    $and: [
                      { schedule_occurrence: null },
                      { date: { $gte: '2024-03-10' } },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ]);
    });

    it('leaves the fallback date bound unchanged from today', () => {
      // The stamp carries occurrence identity for anything this app posted;
      // the fallback bound must keep matching exactly what it matched before,
      // so no grace window is silently reintroduced (or widened).
      function fallbackDateBound(
        schedule: {
          id: string;
          next_date: string;
        } & ScheduleOccurrenceMatchInput,
      ) {
        const [{ $or: perSchedule }] = getHasTransactionsQuery([
          schedule,
        ]).serialize().filterExpressions as [
          { $or: Array<{ $and: { $or: unknown[] } }> },
        ];
        const [, fallback] = perSchedule[0].$and.$or as [
          unknown,
          { $and: [{ schedule_occurrence: null }, { date: { $gte: string } }] },
        ];
        return fallback.$and[1].date.$gte;
      }

      const opIs: {
        id: string;
        next_date: string;
      } & ScheduleOccurrenceMatchInput = {
        id: 'schedule-1',
        next_date: '2026-11-02',
        _conditions: [
          {
            op: 'is',
            field: 'date',
            value: { start: '2026-11-02', frequency: 'monthly' },
          },
        ],
      };

      expect(fallbackDateBound(opIs)).toBe('2026-11-02');

      expect(
        fallbackDateBound({
          id: 'schedule-2',
          next_date: '2026-11-02',
          posts_transaction: false,
        }),
      ).toBe('2026-10-31');

      expect(
        fallbackDateBound({
          id: 'schedule-3',
          next_date: '2026-11-02',
          posts_transaction: true,
        }),
      ).toBe('2026-11-02');
    });

    it('only ever asks about next_date, and must keep doing so', () => {
      // Asserted directly rather than relied on: widening this to match any
      // occurrence is what would reintroduce BUG-1 inside
      // `advanceSchedulesService`, where a later posted occurrence would mark an
      // earlier, still-unpaid one paid and skip it. Per-occurrence matching
      // belongs to `getPostedScheduleTransactionsQuery`, not here.
      const [{ $or: perSchedule }] = getHasTransactionsQuery([
        {
          id: 'schedule-1',
          next_date: '2024-03-10',
          _conditions: [{ op: 'is', field: 'date', value: '2024-03-10' }],
        },
      ]).serialize().filterExpressions as [
        { $or: Array<{ $and: { $or: unknown[] } }> },
      ];

      // The one occurrence identity it names is `next_date`, and nothing else
      // about an occurrence is constrained.
      expect(
        perSchedule[0].$and.$or.filter(
          arm =>
            typeof arm === 'object' &&
            arm != null &&
            'schedule_occurrence' in arm,
        ),
      ).toEqual([{ schedule_occurrence: '2024-03-10' }]);
    });

    it('compiles the fallback arm with AND, not OR', () => {
      // AQL's `compileOr` joins the conditions *inside* a branch with OR, so
      // the object form `{ schedule_occurrence: null, date: {...} }` compiles
      // to `IS NULL OR date >= bound` — matching every schedule-linked
      // transaction and making each occurrence look permanently paid. The
      // serialised filter above looks fine either way, so assert the SQL.
      const { sqlPieces } = compileQuery(
        getHasTransactionsQuery([
          {
            id: 's1',
            next_date: '2016-12-02',
            _conditions: [{ op: 'is', field: 'date', value: '2016-12-02' }],
          },
        ]).serialize(),
        schema,
        schemaConfig,
      );

      // Strip the internal-table prefix and the formatting so the assertion is
      // about the operators, not about which view the table resolved to.
      const where = sqlPieces.where
        .replace(/v_transactions_internal(_alive)?\./g, '')
        .replace(/\s+/g, ' ');

      expect(where).toBe(
        "WHERE (((schedules1.id = 's1' " +
          'AND (schedule_occurrence = 20161202 ' +
          'OR (schedule_occurrence IS NULL AND date >= 20161202)))))',
      );
    });
  });

  describe('getPostedScheduleTransactionsQuery', () => {
    it('matches nothing when there are no schedules', () => {
      const filters = getPostedScheduleTransactionsQuery([]).serialize()
        .filterExpressions;

      expect(filters).toEqual([{ id: null }]);
      expect(filters[0]).not.toHaveProperty('$or');
    });

    it('asks about every occurrence of every schedule, not just next_date', () => {
      // The query `getHasTransactionsQuery` cannot express: it filters on
      // `schedule_occurrence: next_date`, so it can never return a transaction
      // posted for a later occurrence. This one only constrains `schedule`.
      const filters = getPostedScheduleTransactionsQuery([
        { id: 'schedule-1' },
        { id: 'schedule-2' },
      ]).serialize().filterExpressions;

      expect(filters).toEqual([
        { $or: [{ schedule: 'schedule-1' }, { schedule: 'schedule-2' }] },
      ]);
    });

    it('selects only the three columns the occurrence matcher reads', () => {
      const query = getPostedScheduleTransactionsQuery([{ id: 'schedule-1' }]);

      expect(query.serialize().selectExpressions).toEqual([
        'schedule',
        'date',
        'schedule_occurrence',
      ]);
    });
  });

  describe('per-occurrence preview filtering', () => {
    function makeSchedule(
      overrides: Partial<ScheduleEntity> = {},
    ): ScheduleEntity {
      return {
        id: 'sched-1',
        rule: 'rule-1',
        next_date: '2017-01-02',
        completed: false,
        posts_transaction: true,
        tombstone: false,
        _payee: 'payee-1',
        _account: 'acct-1',
        _amount: -10000,
        _amountOp: 'is',
        _date: '2017-01-02',
        _actions: [],
        _conditions: [
          {
            field: 'date',
            op: 'is',
            value: { start: '2017-01-02', frequency: 'weekly', patterns: [] },
          },
        ],
        ...overrides,
      };
    }

    // `currentDay()` is 2017-01-01, so a weekly schedule from 2017-01-02
    // previews five Mondays inside a 30-day window.
    const OCCURRENCES = [
      '2017-01-02',
      '2017-01-09',
      '2017-01-16',
      '2017-01-23',
      '2017-01-30',
    ];

    function previewDates(
      schedule: ScheduleEntity,
      statuses: ScheduleStatuses,
      posted?: PostedScheduleTransaction[],
    ) {
      const postedTransactionsBySchedule = new Map();
      if (posted) {
        for (const tx of posted) {
          const existing = postedTransactionsBySchedule.get(tx.schedule!);
          postedTransactionsBySchedule.set(
            tx.schedule!,
            existing ? [...existing, tx] : [tx],
          );
        }
      }

      return computeSchedulePreviewTransactions(
        [schedule],
        statuses,
        '30-day',
        undefined,
        postedTransactionsBySchedule,
      )
        .map(({ date }) => date)
        .sort();
    }

    it('drops a stamped occurrence wherever it sits in the list', () => {
      // `status` is one bit per schedule and only ever describes next_date, so
      // the `dates.shift()` cannot remove occurrence #2. Only the per-occurrence
      // match can.
      const schedule = makeSchedule();
      const statuses: ScheduleStatuses = new Map([['sched-1', 'due']]);

      expect(previewDates(schedule, statuses)).toEqual(OCCURRENCES);

      expect(
        previewDates(schedule, statuses, [
          {
            schedule: 'sched-1',
            date: OCCURRENCES[1],
            schedule_occurrence: OCCURRENCES[1],
          },
        ]),
      ).toEqual([
        OCCURRENCES[0],
        OCCURRENCES[2],
        OCCURRENCES[3],
        OCCURRENCES[4],
      ]);
    });

    it('drops several occurrences of the same schedule at once', () => {
      const schedule = makeSchedule();
      const statuses: ScheduleStatuses = new Map([['sched-1', 'due']]);

      expect(
        previewDates(schedule, statuses, [
          {
            schedule: 'sched-1',
            date: OCCURRENCES[1],
            schedule_occurrence: OCCURRENCES[1],
          },
          {
            schedule: 'sched-1',
            date: OCCURRENCES[3],
            schedule_occurrence: OCCURRENCES[3],
          },
        ]),
      ).toEqual([OCCURRENCES[0], OCCURRENCES[2], OCCURRENCES[4]]);
    });

    it('drops nothing when the map is omitted, so existing callers are unaffected', () => {
      const schedule = makeSchedule();
      const statuses: ScheduleStatuses = new Map([['sched-1', 'due']]);

      expect(
        computeSchedulePreviewTransactions([schedule], statuses, '30-day')
          .map(({ date }) => date)
          .sort(),
      ).toEqual(OCCURRENCES);

      expect(previewDates(schedule, statuses, [])).toEqual(OCCURRENCES);
    });

    it('leaves a schedule with no posted transactions alone', () => {
      const schedule = makeSchedule();
      const statuses: ScheduleStatuses = new Map([['sched-1', 'due']]);

      expect(
        previewDates(schedule, statuses, [
          {
            schedule: 'some-other-schedule',
            date: OCCURRENCES[1],
            schedule_occurrence: OCCURRENCES[1],
          },
        ]),
      ).toEqual(OCCURRENCES);
    });

    it('still drops next_date when the status is paid', () => {
      const schedule = makeSchedule();
      const statuses: ScheduleStatuses = new Map([['sched-1', 'paid']]);

      expect(previewDates(schedule, statuses)).toEqual(OCCURRENCES.slice(1));
    });

    it('drops a stamped occurrence even when the transaction carries another date', () => {
      // The re-dating case `isScheduleOccurrencePosted` exists for: the date is
      // the user's to edit, the occurrence it discharges is not.
      const schedule = makeSchedule();
      const statuses: ScheduleStatuses = new Map([['sched-1', 'due']]);

      expect(
        previewDates(schedule, statuses, [
          {
            schedule: 'sched-1',
            date: '2016-12-20',
            schedule_occurrence: OCCURRENCES[2],
          },
        ]),
      ).toEqual([
        OCCURRENCES[0],
        OCCURRENCES[1],
        OCCURRENCES[3],
        OCCURRENCES[4],
      ]);
    });

    it('does not let an unstamped transaction between occurrences un-pay any of them', () => {
      // The two filters deliberately disagree here, and this is the safe
      // direction. `getHasTransactionsQuery`'s fallback is a lower bound, so a
      // legacy unstamped payment dated 2017-01-25 makes the schedule read
      // 'paid' and shifts next_date off 2017-01-02. The per-occurrence match is
      // two-sided, so it discharges nothing: the payment belongs to no
      // occurrence. The extra preview row that costs is better than the missing
      // one the reverse disagreement would produce, which is why the shift is
      // kept rather than replaced by this filter.
      const schedule = makeSchedule();
      const betweenOccurrences = '2017-01-25';

      expect(
        previewDates(makeSchedule(), new Map([['sched-1', 'paid']]), [
          { schedule: 'sched-1', date: betweenOccurrences },
        ]),
      ).toEqual(OCCURRENCES.slice(1));

      expect(
        previewDates(schedule, new Map([['sched-1', 'due']]), [
          { schedule: 'sched-1', date: betweenOccurrences },
        ]),
      ).toEqual(OCCURRENCES);
    });

    it('lets an unstamped transaction on the occurrence date discharge it', () => {
      // The counterpart: budgets that predate the stamp still consume the
      // occurrence they were paid for, so the fix does not depend on a backfill.
      const schedule = makeSchedule();
      const statuses: ScheduleStatuses = new Map([['sched-1', 'due']]);

      expect(
        previewDates(schedule, statuses, [
          { schedule: 'sched-1', date: OCCURRENCES[1] },
        ]),
      ).toEqual([
        OCCURRENCES[0],
        OCCURRENCES[2],
        OCCURRENCES[3],
        OCCURRENCES[4],
      ]);
    });
  });

  describe('getScheduleOccurrenceMatchStartDate', () => {
    const occurrenceDate = '2024-03-10';

    it('uses exact date for one-time schedules', () => {
      expect(
        getScheduleOccurrenceMatchStartDate(
          {
            _conditions: [{ op: 'is', field: 'date', value: occurrenceDate }],
          },
          occurrenceDate,
        ),
      ).toBe(occurrenceDate);
    });

    it('uses exact date for auto-posted recurring schedules', () => {
      expect(
        getScheduleOccurrenceMatchStartDate(
          { posts_transaction: true },
          occurrenceDate,
        ),
      ).toBe(occurrenceDate);
    });

    it('uses a 2-day lookback for manual recurring schedules', () => {
      expect(
        getScheduleOccurrenceMatchStartDate(
          { posts_transaction: false },
          occurrenceDate,
        ),
      ).toBe('2024-03-08');
    });

    it('uses exact date for recurring schedules with op is', () => {
      expect(
        getScheduleOccurrenceMatchStartDate(
          {
            posts_transaction: false,
            _conditions: [
              {
                op: 'is',
                field: 'date',
                value: { start: occurrenceDate, frequency: 'monthly' },
              },
            ],
          },
          occurrenceDate,
        ),
      ).toBe(occurrenceDate);
    });

    it('uses exact date for daily recurring schedules with op is', () => {
      expect(
        getScheduleOccurrenceMatchStartDate(
          {
            posts_transaction: false,
            _conditions: [
              {
                op: 'is',
                field: 'date',
                value: { start: occurrenceDate, frequency: 'daily' },
              },
            ],
          },
          occurrenceDate,
        ),
      ).toBe(occurrenceDate);
    });
  });

  describe('indexPostedScheduleTransactions', () => {
    it('groups schedule-linked transactions by schedule id', () => {
      const indexed = indexPostedScheduleTransactions([
        { schedule: 'sched-1', date: '2024-03-09' },
        { schedule: 'sched-2', date: '2024-03-10' },
        { schedule: 'sched-1', date: '2024-04-10' },
        { date: '2024-03-11' },
      ]);

      expect(indexed.get('sched-1')).toEqual([
        { schedule: 'sched-1', date: '2024-03-09' },
        { schedule: 'sched-1', date: '2024-04-10' },
      ]);
      expect(indexed.get('sched-2')).toEqual([
        { schedule: 'sched-2', date: '2024-03-10' },
      ]);
      expect(indexed.has('missing')).toBe(false);
    });
  });

  describe('isScheduleOccurrencePosted', () => {
    const scheduleId = 'sched-1';
    const occurrenceDate = '2024-03-10';
    const manualRecurringSchedule = { posts_transaction: false };
    const autoPostSchedule = { posts_transaction: true };
    const oneTimeSchedule = {
      _conditions: [
        { op: 'is', field: 'date', value: occurrenceDate } as const,
      ],
    };
    const manualRecurringWithIsOp = {
      posts_transaction: false,
      _conditions: [
        {
          op: 'is',
          field: 'date',
          value: { start: occurrenceDate, frequency: 'monthly' },
        },
      ] satisfies RuleConditionEntity[],
    };

    function expectPosted(
      schedule: Parameters<typeof getScheduleOccurrenceMatchStartDate>[0],
      txDate: string,
      expected: boolean,
    ) {
      expect(
        isScheduleOccurrencePosted({
          schedule,
          scheduleId,
          occurrenceDate,
          postedTransactions: [{ schedule: scheduleId, date: txDate }],
        }),
      ).toBe(expected);
    }

    it.each([
      [
        'same-day manual recurring',
        manualRecurringSchedule,
        occurrenceDate,
        true,
      ],
      [
        'early pay day before due for recurring date cond',
        manualRecurringWithIsOp,
        '2024-03-09',
        false,
      ],
      ['early pay within 2 days', manualRecurringSchedule, '2024-03-09', true],
      [
        'early pay outside window',
        manualRecurringSchedule,
        '2024-03-07',
        false,
      ],
      ['auto-post day before due', autoPostSchedule, '2024-03-09', false],
      ['auto-post on due date', autoPostSchedule, occurrenceDate, true],
      ['one-time on due date', oneTimeSchedule, occurrenceDate, true],
      ['one-time day before due', oneTimeSchedule, '2024-03-09', false],
      [
        'later month tx does not satisfy earlier occurrence',
        manualRecurringSchedule,
        '2024-04-10',
        false,
      ],
    ] as const)('%s', (_label, schedule, txDate, expected) => {
      expectPosted(schedule, txDate, expected);
    });

    function expectStamped(
      schedule: Parameters<typeof getScheduleOccurrenceMatchStartDate>[0],
      occurrence: string | null,
      txDate: string,
      expected: boolean,
    ) {
      expect(
        isScheduleOccurrencePosted({
          schedule,
          scheduleId,
          occurrenceDate,
          postedTransactions: [
            {
              schedule: scheduleId,
              date: txDate,
              schedule_occurrence: occurrence,
            },
          ],
        }),
      ).toBe(expected);
    }

    it('credits a stamped transaction to its occurrence however it is dated', () => {
      // The reported bug: the payment was posted for this occurrence and then
      // moved seven days earlier. The date is the user's; the stamp is not.
      expectStamped(
        manualRecurringWithIsOp,
        occurrenceDate,
        '2024-03-03',
        true,
      );
    });

    it('does not credit a transaction stamped for a different occurrence', () => {
      expectStamped(
        manualRecurringWithIsOp,
        '2024-02-10',
        occurrenceDate,
        false,
      );
      // Dated late and inside any plausible grace, so this cannot pass
      // vacuously by falling out of the window.
      expectStamped(manualRecurringWithIsOp, '2024-02-10', '2024-03-09', false);
    });

    it('matches exactly for a schedule that both auto-posts and recurs on op is', () => {
      const bothShape = {
        posts_transaction: true,
        _conditions: manualRecurringWithIsOp._conditions,
      };

      expectStamped(bothShape, occurrenceDate, '2024-03-03', true);
      expectStamped(bothShape, occurrenceDate, '2024-03-12', true);
      expectStamped(bothShape, '2024-02-10', occurrenceDate, false);
      expectStamped(bothShape, '2024-02-10', '2024-03-09', false);
    });
  });

  describe('getNextDate', () => {
    it('returns last occurrence for a recurring schedule with an end date in the past', () => {
      const dateCond = {
        op: 'isapprox',
        value: {
          start: '2016-01-25',
          frequency: 'monthly',
          endMode: 'on_date',
          endDate: '2016-08-25',
        },
      };

      // Current date is 2017-01-01 via MockDate
      const result = getNextDate(dateCond);
      expect(result).not.toBeNull();
      // The last occurrence should be returned (reverse lookup)
      expect(result).toBe('2016-08-25');
    });

    it('returns null when the end date is before the start date', () => {
      const dateCond = {
        op: 'isapprox',
        value: {
          start: '2016-03-25',
          frequency: 'monthly',
          endMode: 'on_date',
          endDate: '2016-01-25',
        },
      };

      const result = getNextDate(dateCond, new Date(2017, 0, 1));
      expect(result).toBeNull();
    });
  });

  describe('getNextDateAfter', () => {
    /* Dec 2020 calendar for reference:
      | Su | Mo | Tu | We | Th | Fr | Sa |
      |    |    | 01 | 02 | 03 | 04 | 05 |
      | 06 | 07 | 08 | 09 | 10 | 11 | 12 |
      | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
      | 20 | 21 | 22 | 23 | 24 | 25 | 26 |
      | 27 | 28 | 29 | 30 | 31 |
      */
    function weeklyOnSaturday(extra = {}) {
      return {
        op: 'isapprox',
        value: {
          start: '2020-12-05',
          frequency: 'weekly',
          patterns: [],
          ...extra,
        },
      };
    }

    it('returns the next occurrence after the given date', () => {
      expect(getNextDateAfter(weeklyOnSaturday(), '2020-12-05')).toBe(
        '2020-12-12',
      );
    });

    it('returns the next occurrence when moving `after` the weekend', () => {
      const dateCond = weeklyOnSaturday({
        skipWeekend: true,
        weekendSolveMode: 'after',
      });

      expect(getNextDateAfter(dateCond, '2020-12-07')).toBe('2020-12-14');
    });

    it('includes a weekend occurrence moved `after` the given date', () => {
      const dateCond = weeklyOnSaturday({
        skipWeekend: true,
        weekendSolveMode: 'after',
      });

      expect(getNextDateAfter(dateCond, '2020-12-13')).toBe('2020-12-14');
    });

    it('does not return the same occurrence when moving `after` the weekend', () => {
      const dateCond = {
        op: 'isapprox',
        value: {
          start: '2020-12-06',
          frequency: 'weekly',
          patterns: [],
          skipWeekend: true,
          weekendSolveMode: 'after',
        },
      };

      expect(getNextDateAfter(dateCond, '2020-12-07')).toBe('2020-12-14');
    });

    it('does not return the same occurrence when moving `before` the weekend', () => {
      const dateCond = weeklyOnSaturday({
        skipWeekend: true,
        weekendSolveMode: 'before',
      });

      expect(getNextDateAfter(dateCond, '2020-12-04')).toBe('2020-12-11');
    });

    it('keeps a Monday occurrence that follows a `before` weekend adjustment', () => {
      const dateCond = {
        op: 'isapprox',
        value: {
          start: '2020-12-04',
          frequency: 'daily',
          patterns: [],
          skipWeekend: true,
          weekendSolveMode: 'before',
        },
      };

      expect(getNextDateAfter(dateCond, '2020-12-04')).toBe('2020-12-07');
    });

    it('walks past every occurrence that resolves on or before the given date', () => {
      /* Aug 2026 calendar for reference:
        | Su | Mo | Tu | We | Th | Fr | Sa |
        | 23 | 24 | 25 | 26 | 27 | 28 | 29 |
        | 30 | 31 |
        */
      const dateCond = {
        op: 'isapprox',
        value: {
          start: '2026-08-24',
          frequency: 'daily',
          patterns: [],
          skipWeekend: true,
          weekendSolveMode: 'before',
        },
      };

      expect(getNextDateAfter(dateCond, '2026-08-28')).toBe('2026-08-31');
    });

    it('returns null when the schedule has no further occurrences', () => {
      const dateCond = weeklyOnSaturday({
        endMode: 'after_n_occurrences',
        endOccurrences: 2,
      });

      expect(getNextDateAfter(dateCond, '2020-12-05')).toBe('2020-12-12');
      expect(getNextDateAfter(dateCond, '2020-12-12')).toBeNull();
    });
  });

  describe('shared presets', () => {
    it('preset values and options align', () => {
      const valuesFromOptions = UPCOMING_LENGTH_PRESET_OPTIONS.map(
        o => o.value,
      );
      expect(valuesFromOptions).toEqual(
        UPCOMING_LENGTH_PRESET_VALUES as readonly string[],
      );
    });

    it('every preset has a label entry', () => {
      for (const v of UPCOMING_LENGTH_PRESET_VALUES) {
        expect(UPCOMING_LENGTH_PRESET_LABELS[v]).toBeDefined();
        expect(typeof UPCOMING_LENGTH_PRESET_LABELS[v]).toBe('string');
      }
    });

    it('isCustomUpcomingLength recognizes presets and custom values', () => {
      for (const v of UPCOMING_LENGTH_PRESET_VALUES) {
        expect(isCustomUpcomingLength(v)).toBe(false);
      }

      expect(isCustomUpcomingLength('1-day')).toBe(true);
      expect(isCustomUpcomingLength('2-week')).toBe(true);
      expect(isCustomUpcomingLength(null)).toBe(false);
      expect(isCustomUpcomingLength(undefined)).toBe(false);
    });
  });
});
