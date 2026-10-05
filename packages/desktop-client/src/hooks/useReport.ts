import { useQuery } from '@tanstack/react-query';

import { reportQueries } from '#reports';

export function useReport(id?: string | null) {
  const query = useQuery({
    ...reportQueries.list(),
    select: reports => reports.find(report => report.id === id),
    enabled: !!id,
  });

  // See useDashboardWidget: a disabled query stays 'pending' forever, so bare
  // /reports/custom would render its loading indicator indefinitely instead of
  // falling back to the new-report default view.
  //
  // This computes `isPending && fetchStatus !== 'idle'`, which is not
  // react-query's own isPending && isFetching (queryObserver.js:310). The two
  // differ in exactly one case — a paused query — and it is deliberately
  // counted as loading here: such a query is still trying and may resume, so
  // dropping out of the loading branch would render an empty report with no
  // explanation, which is worse than a spinner.
  const isFirstLoad = query.isPending && query.fetchStatus !== 'idle';

  // See useDashboardWidget, which states the reasoning first. The rule is the
  // same here: the return carries what a caller needs — the data, the derived
  // loading flag, and `fetchStatus` because that is the un-derived input the
  // derivation reads, so a caller seeing `isPending: false` can tell a disabled
  // query from one that resolved with no data.
  //
  // Returned explicitly rather than spread because spreading would leave
  // react-query's `status`, `isSuccess` and `isInitialLoading` visible next to a
  // derived `isPending` that disagrees with them on an id-less route. Everything
  // else react-query exposes either disagrees with the derived flag or has no
  // reader.
  return {
    data: query.data,
    isPending: isFirstLoad,
    isLoading: isFirstLoad,
    fetchStatus: query.fetchStatus,
  };
}
