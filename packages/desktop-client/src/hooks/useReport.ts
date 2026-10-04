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
  const isFirstLoad = query.isPending && query.fetchStatus !== 'idle';

  return { ...query, isPending: isFirstLoad, isLoading: isFirstLoad };
}
