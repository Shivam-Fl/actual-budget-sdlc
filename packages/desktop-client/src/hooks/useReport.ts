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

  // Returned explicitly rather than spread: spreading would leave `status`,
  // `isSuccess` and `isInitialLoading` visible next to a derived `isPending`
  // that disagrees with them on an id-less route.
  return {
    data: query.data,
    error: query.error,
    isPending: isFirstLoad,
    isLoading: isFirstLoad,
    fetchStatus: query.fetchStatus,
  };
}
