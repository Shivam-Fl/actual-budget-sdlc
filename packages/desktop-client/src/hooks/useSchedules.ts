import { useEffect, useRef, useState } from 'react';

import { q } from '@actual-app/core/shared/query';
import type { ObjectExpression, Query } from '@actual-app/core/shared/query';
import {
  getHasTransactionsQuery,
  getPostedScheduleTransactionsQuery,
  getStatus,
  indexPostedScheduleTransactions,
} from '@actual-app/core/shared/schedules';
import type {
  PostedScheduleTransaction,
  ScheduleStatuses,
} from '@actual-app/core/shared/schedules';
import type {
  AccountEntity,
  ScheduleEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';

import { accountFilter } from '#queries';
import { liveQuery } from '#queries/liveQuery';
import type { LiveQuery } from '#queries/liveQuery';
import { getStatusLabel } from '#util/schedule';

import { useSyncedPref } from './useSyncedPref';

export type ScheduleStatusLabelType = ReturnType<typeof getStatusLabel>;
export type ScheduleStatusLabels = Map<
  ScheduleEntity['id'],
  ScheduleStatusLabelType
>;
function loadStatuses(
  schedules: readonly ScheduleEntity[],
  onData: (data: ScheduleStatuses) => void,
  onError: (error: Error) => void,
  upcomingLength: string = '7',
) {
  return liveQuery<TransactionEntity>(getHasTransactionsQuery(schedules), {
    onData: data => {
      const hasTrans = new Set(data.filter(Boolean).map(row => row.schedule));

      const scheduleStatuses = new Map(
        schedules.map(s => [
          s.id,
          getStatus(
            s.next_date,
            s.completed,
            hasTrans.has(s.id),
            s.custom_upcoming_length ?? upcomingLength,
          ),
        ]),
      ) as ScheduleStatuses;

      onData?.(scheduleStatuses);
    },
    onError,
  });
}
function loadPostedTransactions(
  schedules: readonly ScheduleEntity[],
  onData: (data: Map<string, PostedScheduleTransaction[]>) => void,
  onError: (error: Error) => void,
) {
  return liveQuery<TransactionEntity>(
    getPostedScheduleTransactionsQuery(schedules),
    {
      onData: data => {
        onData?.(
          indexPostedScheduleTransactions(
            data.filter(Boolean) as PostedScheduleTransaction[],
          ),
        );
      },
      onError,
    },
  );
}
export type UseSchedulesProps = {
  query?: Query;
};
type ScheduleData = {
  schedules: readonly ScheduleEntity[];
  statuses: ScheduleStatuses;
  statusLabels: ScheduleStatusLabels;
  postedTransactionsBySchedule: Map<string, PostedScheduleTransaction[]>;
};
export type UseSchedulesResult = ScheduleData & {
  readonly isLoading: boolean;
  readonly error?: Error;
};

export function useSchedules({
  query,
}: UseSchedulesProps = {}): UseSchedulesResult {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [data, setData] = useState<ScheduleData>({
    schedules: [],
    statuses: new Map(),
    statusLabels: new Map(),
    postedTransactionsBySchedule: new Map(),
  });
  const [upcomingLength] = useSyncedPref('upcomingScheduledTransactionLength');

  const scheduleQueryRef = useRef<LiveQuery<ScheduleEntity> | null>(null);
  const statusQueryRef = useRef<LiveQuery<TransactionEntity> | null>(null);
  const postedQueryRef = useRef<LiveQuery<TransactionEntity> | null>(null);
  // `publish` runs from a query callback, not during render, so it cannot read
  // the `data` state variable without closing over the render that created the
  // query. This ref always holds the most recently published `ScheduleData`.
  const latestDataRef = useRef<ScheduleData>(data);

  useEffect(() => {
    let isUnmounted = false;

    setError(undefined);

    if (!query) {
      // This usually means query is not yet set on this render cycle.
      return;
    }

    function onError(error: Error) {
      if (!isUnmounted) {
        setError(error);
        setIsLoading(false);
      }
    }

    if (query.state.table !== 'schedules') {
      onError(new Error('Query must be a schedules query.'));
      return;
    }

    setIsLoading(true);

    scheduleQueryRef.current = liveQuery<ScheduleEntity>(query, {
      onData: async schedules => {
        // `onData` fires again whenever the schedules change, so tear down the
        // previous status and posted-transaction queries first. Otherwise each
        // refresh orphans live queries that stay subscribed to sync events and
        // keep re-running.
        statusQueryRef.current?.unsubscribe();
        postedQueryRef.current?.unsubscribe();

        // The two queries are independent subscriptions and can land in either
        // order, so each publishes with whatever the other has most recently
        // reported. Waiting for both would strand the register in its loading
        // state whenever one of them is slow to deliver.
        //
        // Starting from empty maps instead would let whichever query lands
        // first publish a schedule list paired with an empty status map. Every
        // schedule then fails `isForPreview` and the register's Upcoming rows
        // vanish for a round trip. So both start from the last published values
        // instead: a schedule whose status genuinely changed shows its previous
        // status until the status query corrects it, which is strictly better
        // than showing nothing at all for the same window.
        let statuses: ScheduleStatuses = latestDataRef.current.statuses;
        let postedTransactionsBySchedule =
          latestDataRef.current.postedTransactionsBySchedule;

        const publish = () => {
          if (isUnmounted) {
            return;
          }

          const previous = latestDataRef.current;
          // The status query always builds a fresh map, so an unchanged `statuses`
          // is the previous map by identity and its labels are still valid.
          // Rebuilding unconditionally would hand consumers a new
          // `statusLabels` instance on every published-transaction event.
          const statusLabels =
            statuses === previous.statuses
              ? previous.statusLabels
              : new Map(
                  [...statuses.keys()].map(key => [
                    key,
                    getStatusLabel(statuses.get(key) || ''),
                  ]),
                );

          const next: ScheduleData = {
            schedules,
            statuses,
            statusLabels,
            postedTransactionsBySchedule,
          };

          latestDataRef.current = next;
          setData(next);
        };

        statusQueryRef.current = loadStatuses(
          schedules,
          next => {
            statuses = next;
            publish();
            setIsLoading(false);
          },
          onError,
          upcomingLength,
        );

        postedQueryRef.current = loadPostedTransactions(
          schedules,
          next => {
            postedTransactionsBySchedule = next;
            publish();
          },
          onError,
        );
      },
      onError,
    });

    return () => {
      isUnmounted = true;
      scheduleQueryRef.current?.unsubscribe();
      statusQueryRef.current?.unsubscribe();
      postedQueryRef.current?.unsubscribe();
    };
  }, [query, upcomingLength]);

  return {
    isLoading,
    error,
    ...data,
  };
}

export function getSchedulesQuery(
  view?: AccountEntity['id'] | 'onbudget' | 'offbudget' | 'uncategorized',
) {
  const filterByAccount = accountFilter(view, '_account');
  const filterByPayee = accountFilter(view, '_payee.transfer_acct');

  let query = q('schedules')
    .select('*')
    .filter({
      $and: [{ '_account.closed': false }],
    });

  if (view) {
    if (view === 'uncategorized') {
      query = query.filter({ next_date: null });
    } else {
      const scheduleFilters: ObjectExpression[] = [
        filterByAccount,
        filterByPayee,
      ].filter(filter => filter !== null);

      if (view !== 'onbudget' && view !== 'offbudget') {
        scheduleFilters.push({
          _has_splits: true,
        });
      }

      query = query.filter({
        $or: scheduleFilters,
      });
    }
  }

  return query.orderBy({ next_date: 'desc' });
}
