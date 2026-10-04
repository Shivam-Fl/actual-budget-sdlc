import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import { computeSchedulePreviewTransactions } from '@actual-app/core/shared/schedules';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { liveQuery } from '#queries/liveQuery';
import type { LiveQuery } from '#queries/liveQuery';

import { getSchedulesQuery, useSchedules } from './useSchedules';

vi.mock('#queries/liveQuery', () => ({
  liveQuery: vi.fn(),
}));

vi.mock('./useSyncedPref', () => ({
  useSyncedPref: () => ['7', vi.fn()],
}));

type LiveQueryCall = {
  onData: (data: unknown[], previousData: unknown[]) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
};

describe('useSchedules', () => {
  let calls: LiveQueryCall[];

  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];

    // `vi.mocked` keeps the mock bound to the real `liveQuery` signature, so a
    // change to how the hook calls it still fails typecheck.
    vi.mocked(liveQuery).mockImplementation((_query, { onData }) => {
      const handle = {
        onData: onData ?? vi.fn(),
        unsubscribe: vi.fn(),
      };
      calls.push(handle);
      // `LiveQuery` is a class with private state; only the subscription
      // surface used by the hook is faked here.
      return handle as unknown as LiveQuery<unknown>;
    });
  });

  it('does not open any live query when no query is given', () => {
    renderHook(() => useSchedules({}));

    expect(liveQuery).not.toHaveBeenCalled();
  });

  it('unsubscribes the previous status and posted queries when schedules refresh', () => {
    renderHook(() => useSchedules({ query: q('schedules').select('*') }));

    // The schedules query is opened first; its onData opens the status query
    // and the posted-transaction query.
    expect(calls).toHaveLength(1);
    const schedulesQuery = calls[0];

    schedulesQuery.onData([], []);
    expect(calls).toHaveLength(3);
    const firstStatusQuery = calls[1];
    const firstPostedQuery = calls[2];
    expect(firstStatusQuery.unsubscribe).not.toHaveBeenCalled();
    expect(firstPostedQuery.unsubscribe).not.toHaveBeenCalled();

    // A refresh must tear down the previous queries rather than orphan them —
    // an orphan stays subscribed to sync events and keeps re-running.
    schedulesQuery.onData([], []);
    expect(firstStatusQuery.unsubscribe).toHaveBeenCalledTimes(1);
    expect(firstPostedQuery.unsubscribe).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(5);
  });

  it('unsubscribes every query on unmount', () => {
    const { unmount } = renderHook(() =>
      useSchedules({ query: q('schedules').select('*') }),
    );

    calls[0].onData([], []);
    expect(calls).toHaveLength(3);

    unmount();

    expect(calls[0].unsubscribe).toHaveBeenCalled();
    expect(calls[1].unsubscribe).toHaveBeenCalled();
    expect(calls[2].unsubscribe).toHaveBeenCalled();
  });

  // The register needs per-occurrence knowledge — which specific occurrences
  // of a schedule have been posted — to drop one preview row without moving
  // the pointer the list is anchored to. `statuses` is one bit per schedule
  // and cannot express that.
  it('exposes posted transactions indexed by schedule id', () => {
    const { result } = renderHook(() =>
      useSchedules({ query: q('schedules').select('*') }),
    );

    calls[0].onData(
      [
        { id: 'sched-1', next_date: '2017-01-02', _conditions: [] },
        { id: 'sched-2', next_date: '2017-01-03', _conditions: [] },
      ],
      [],
    );

    // call order: schedules, status, posted-transactions
    const postedQuery = calls[2];
    act(() =>
      postedQuery.onData(
        [
          {
            schedule: 'sched-1',
            date: '2017-01-02',
            schedule_occurrence: '2017-01-02',
          },
          {
            schedule: 'sched-1',
            date: '2017-01-09',
            schedule_occurrence: '2017-01-09',
          },
          { schedule: 'sched-2', date: '2017-01-03' },
          null,
        ],
        [],
      ),
    );

    expect(
      [...result.current.postedTransactionsBySchedule.keys()].sort(),
    ).toEqual(['sched-1', 'sched-2']);
    expect(result.current.postedTransactionsBySchedule.get('sched-1')).toEqual([
      {
        schedule: 'sched-1',
        date: '2017-01-02',
        schedule_occurrence: '2017-01-02',
      },
      {
        schedule: 'sched-1',
        date: '2017-01-09',
        schedule_occurrence: '2017-01-09',
      },
    ]);
    expect(result.current.postedTransactionsBySchedule.get('sched-2')).toEqual([
      { schedule: 'sched-2', date: '2017-01-03' },
    ]);
  });

  it('starts with an empty occurrence index and no error', () => {
    const { result } = renderHook(() => useSchedules({}));

    expect(result.current.postedTransactionsBySchedule.size).toBe(0);
    expect(result.current.error).toBeUndefined();
  });

  // Every case below drives the refresh race the two independent dependent
  // queries have in real life. `onData` publishes from whichever of them lands
  // first, and the posted-transactions query — a plain `$or` over three columns
  // — is expected to beat the status query, whose `$or` fans out over a
  // `calculate` upstream. So "refresh, deliver only the posted query" is the
  // common case, not an exotic one, and it is what used to empty the register.
  describe('refresh', () => {
    // Delivering a schedule `daysFromToday` out lands it inside the upcoming
    // window regardless of when the suite runs, so `getStatus` reports
    // 'upcoming' rather than a date-dependent 'missed'.
    function buildSchedule(id: string, daysFromToday: number, overrides = {}) {
      return {
        id,
        next_date: monthUtils.addDays(monthUtils.currentDay(), daysFromToday),
        completed: false,
        _account: 'acct-1',
        _payee: 'payee-1',
        _amount: 1000,
        _actions: [],
        _conditions: [],
        ...overrides,
      };
    }

    // The schedules `onData` is `async`. Handing `act` its promise would queue
    // an un-awaited async act and leak it into the next test, so the callback
    // is voided to keep the flush synchronous.
    function deliver(call: LiveQueryCall, data: unknown[] = []) {
      act(() => {
        void call.onData(data, []);
      });
    }

    // One full cycle: the schedules query delivers, then both dependent
    // queries, ending with the published data both of them together.
    function firstCycle(schedules: unknown[]) {
      deliver(calls[0], schedules);
      deliver(calls[1]);
      deliver(calls[2]);
    }

    // The refresh half of that cycle. `calls[3]` is the new status query and
    // `calls[4]` the new posted-transactions query; returning `calls[4]` lets a
    // test pick which of the two wins the race.
    function refresh(schedules: unknown[]) {
      deliver(calls[0], schedules);
      expect(calls).toHaveLength(5);
    }

    it('keeps the published statuses when the posted-transactions query wins the race on refresh', () => {
      const query = q('schedules').select('*');
      const { result } = renderHook(() => useSchedules({ query }));
      const schedules = [
        buildSchedule('sched-1', 1),
        buildSchedule('sched-2', 2),
      ];

      firstCycle(schedules);
      expect(result.current.schedules).toHaveLength(2);
      expect(result.current.statuses.size).toBe(2);

      refresh(schedules);
      // The status query has not landed yet — only the cheap query has.
      deliver(calls[4]);

      expect(result.current.schedules).toHaveLength(2);
      expect(result.current.statuses.size).toBe(2);
    });

    it('reuses the same statusLabels Map instance when statuses is unchanged by identity', () => {
      const query = q('schedules').select('*');
      const { result } = renderHook(() => useSchedules({ query }));
      const schedules = [buildSchedule('sched-1', 1)];

      firstCycle(schedules);
      const statusLabels = result.current.statusLabels;

      refresh(schedules);
      deliver(calls[4]);

      expect(result.current.statusLabels).toBe(statusLabels);
    });

    it('rebuilds statusLabels once the status query delivers a new map', () => {
      const query = q('schedules').select('*');
      const { result } = renderHook(() => useSchedules({ query }));
      const schedules = [buildSchedule('sched-1', 1)];

      firstCycle(schedules);
      const statusLabels = result.current.statusLabels;

      refresh(schedules);
      deliver(calls[3]);

      expect(result.current.statusLabels).not.toBe(statusLabels);
    });

    it('does not seed a status for a schedule added by the refresh', () => {
      const query = q('schedules').select('*');
      const { result } = renderHook(() => useSchedules({ query }));

      firstCycle([buildSchedule('sched-1', 1)]);

      // A schedule the refresh brings in has no previous status to seed from,
      // and an unknown status reads as "not for preview" — so it stays out for
      // one round trip rather than flashing in with the wrong status.
      refresh([buildSchedule('sched-1', 1), buildSchedule('sched-2', 2)]);
      deliver(calls[4]);

      expect(result.current.statuses.has('sched-2')).toBe(false);

      deliver(calls[3]);

      expect(result.current.statuses.has('sched-2')).toBe(true);
    });

    it('leaves a schedule the refresh marks completed out of the preview immediately', () => {
      const query = q('schedules').select('*');
      const { result } = renderHook(() => useSchedules({ query }));

      firstCycle([buildSchedule('sched-1', 1), buildSchedule('sched-2', 2)]);

      refresh([
        buildSchedule('sched-1', 1, { completed: true }),
        buildSchedule('sched-2', 2),
      ]);
      deliver(calls[4]);

      // The seeded status still says 'upcoming' for sched-1, but
      // `isForPreview` reads the schedule's own `completed` flag, so completing
      // one takes effect at the save rather than a round trip later. sched-2 is
      // the control: it must survive on the seeded status.
      const previewIds = computeSchedulePreviewTransactions(
        result.current.schedules,
        result.current.statuses,
        '7',
        undefined,
        result.current.postedTransactionsBySchedule,
      ).map(preview => preview.schedule);

      expect(previewIds).toEqual(['sched-2']);
    });
  });
});

describe('getSchedulesQuery', () => {
  it('loads split schedules for concrete account views', () => {
    const query = getSchedulesQuery('savings');

    expect(query.state.filterExpressions).toContainEqual({
      $or: [
        { _account: 'savings' },
        { '_payee.transfer_acct': 'savings' },
        { _has_splits: true },
      ],
    });
  });
});
