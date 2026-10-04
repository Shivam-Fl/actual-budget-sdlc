import { send } from '@actual-app/core/platform/client/connection';
import { addDays, currentDay } from '@actual-app/core/shared/months';
import type { PostedScheduleTransaction } from '@actual-app/core/shared/schedules';
import type {
  ScheduleEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  comparePreviewTransactions,
  usePreviewTransactions,
} from './usePreviewTransactions';
import type { UseSchedulesResult } from './useSchedules';

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: vi.fn(),
}));

const { useCachedSchedules } = vi.hoisted(() => ({
  useCachedSchedules: vi.fn(),
}));

vi.mock('./useCachedSchedules', () => ({ useCachedSchedules }));

vi.mock('./useSyncedPref', () => ({
  useSyncedPref: () => ['30-day', vi.fn()],
}));

describe('comparePreviewTransactions', () => {
  test('sorts by date descending first', () => {
    const a = { date: '2024-01-01', amount: 100, sort_order: 0 };
    const b = { date: '2024-01-05', amount: 100, sort_order: 0 };
    expect(comparePreviewTransactions(a, b)).toBeGreaterThan(0);
    expect(comparePreviewTransactions(b, a)).toBeLessThan(0);
  });

  test('same date: sorts by sort_order descending', () => {
    const a = { date: '2024-01-01', amount: 100, sort_order: 5 };
    const b = { date: '2024-01-01', amount: 100, sort_order: 10 };
    expect(comparePreviewTransactions(a, b)).toBeGreaterThan(0);
    expect(comparePreviewTransactions(b, a)).toBeLessThan(0);
  });

  test('same date, null/equal sort_order: falls back to amount ascending', () => {
    const a = { date: '2024-01-01', amount: 200, sort_order: null };
    const b = { date: '2024-01-01', amount: 100, sort_order: null };
    expect(comparePreviewTransactions(a, b)).toBeGreaterThan(0);
    expect(comparePreviewTransactions(b, a)).toBeLessThan(0);
  });

  test('same date, one sort_order undefined treated as 0', () => {
    const a = { date: '2024-01-01', amount: 100, sort_order: undefined };
    const b = { date: '2024-01-01', amount: 999, sort_order: 5 };
    // b has higher sort_order (5 > 0), so b sorts first regardless of amount
    expect(comparePreviewTransactions(a, b)).toBeGreaterThan(0);
  });
});

describe('usePreviewTransactions', () => {
  // The preview window is anchored on the real current day here, so the
  // occurrences have to be too: a weekly schedule starting tomorrow previews
  // five occurrences inside the mocked 30-day upcoming length.
  const START = addDays(currentDay(), 1);
  const OCCURRENCES = [0, 7, 14, 21, 28].map(days => addDays(START, days));

  const schedule: ScheduleEntity = {
    id: 'sched-1',
    rule: 'rule-1',
    next_date: START,
    completed: false,
    posts_transaction: true,
    tombstone: false,
    sort_order: 0,
    _payee: 'payee-1',
    _account: 'acct-1',
    _amount: -10000,
    _amountOp: 'is',
    _date: START,
    _actions: [],
    _conditions: [
      {
        field: 'date',
        op: 'is',
        value: {
          start: START,
          frequency: 'weekly',
          patterns: [],
        },
      },
    ],
  };

  function setContext(
    postedTransactionsBySchedule: Map<string, PostedScheduleTransaction[]>,
  ) {
    useCachedSchedules.mockReturnValue({
      isLoading: false,
      schedules: [schedule],
      statuses: new Map([[schedule.id, 'upcoming']]),
      statusLabels: new Map(),
      postedTransactionsBySchedule,
    } as UseSchedulesResult);
  }

  beforeEach(() => {
    vi.mocked(send).mockReset();
    // The hook fires one `rules-run` per preview row; echo the transaction back
    // the way the server does, so the effect's `.then` runs.
    vi.mocked(send).mockImplementation((_method, args) =>
      Promise.resolve({
        ...(args as { transaction: TransactionEntity }).transaction,
      }),
    );
  });

  const previewDates = (transactions: ReadonlyArray<TransactionEntity>) =>
    transactions.map(({ date }) => date).sort();

  test('previews every occurrence when nothing has been posted', async () => {
    setContext(new Map());

    const { result } = renderHook(() => usePreviewTransactions());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(previewDates(result.current.previewTransactions)).toEqual(
      OCCURRENCES,
    );
  });

  test('a newly posted occurrence removes only its own preview row', async () => {
    // The whole point of the hook carrying the occurrence index: occurrence #2
    // is consumed, while #1 — still owed — and #3..#5 are untouched.
    setContext(
      new Map([
        [
          schedule.id,
          [
            {
              schedule: schedule.id,
              date: OCCURRENCES[1],
              schedule_occurrence: OCCURRENCES[1],
            },
          ],
        ],
      ]),
    );

    const { result } = renderHook(() => usePreviewTransactions());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(previewDates(result.current.previewTransactions)).toEqual([
      OCCURRENCES[0],
      OCCURRENCES[2],
      OCCURRENCES[3],
      OCCURRENCES[4],
    ]);
  });

  test('recomputes the previews when a posted occurrence arrives', async () => {
    // The new map is in the dependency array, so a post that lands mid-session
    // recomputes rather than leaving the consumed occurrence previewed.
    setContext(new Map());

    const { result, rerender } = renderHook(() => usePreviewTransactions());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(previewDates(result.current.previewTransactions)).toContain(
      OCCURRENCES[1],
    );

    setContext(
      new Map([
        [
          schedule.id,
          [
            {
              schedule: schedule.id,
              date: OCCURRENCES[1],
              schedule_occurrence: OCCURRENCES[1],
            },
          ],
        ],
      ]),
    );
    rerender();

    await waitFor(() =>
      expect(previewDates(result.current.previewTransactions)).not.toContain(
        OCCURRENCES[1],
      ),
    );
    expect(previewDates(result.current.previewTransactions)).toEqual([
      OCCURRENCES[0],
      OCCURRENCES[2],
      OCCURRENCES[3],
      OCCURRENCES[4],
    ]);
  });
});
