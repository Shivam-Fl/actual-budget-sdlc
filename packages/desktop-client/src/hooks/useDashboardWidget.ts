import type { DashboardWidgetEntity } from '@actual-app/core/types/models';
import { useQuery } from '@tanstack/react-query';

import { dashboardQueries } from '#reports';

type UseDashboardWidgetProps<W extends DashboardWidgetEntity> = Partial<
  Pick<W, 'id' | 'type'>
>;

export function useDashboardWidget<W extends DashboardWidgetEntity>({
  id,
  type,
}: UseDashboardWidgetProps<W>) {
  const query = useQuery({
    ...dashboardQueries.listDashboardWidgets<W>(),
    select: widgets => widgets.find(w => w.id === id && w.type === type),
    enabled: !!id && !!type,
  });

  // A disabled query never fetches, so react-query leaves it 'pending' forever.
  // Every report route renders <LoadingIndicator /> while isPending is true, so
  // an id-less route would spin indefinitely. The conjunction is what keeps a
  // background refetch over cached data off the loading branch.
  //
  // This computes `isPending && fetchStatus !== 'idle'`, which is not
  // react-query's own isPending && isFetching (queryObserver.js:310). The two
  // differ in exactly one case — a paused query — and it is deliberately
  // counted as loading here: such a query is still trying and may resume, so
  // dropping out of the loading branch would render an empty report with no
  // explanation, which is worse than a spinner.
  const isFirstLoad = query.isPending && query.fetchStatus !== 'idle';

  // One rule for the whole return: it carries what a caller needs — the data,
  // the derived loading flag, and `fetchStatus` because that is the un-derived
  // input the derivation reads, so a caller seeing `isPending: false` can tell a
  // disabled query from one that resolved with no data.
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
