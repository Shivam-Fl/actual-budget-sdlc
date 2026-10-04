import { q } from '@actual-app/core/shared/query';
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
