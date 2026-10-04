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
  // an id-less route would spin indefinitely. This is react-query's own
  // isLoading definition, and the conjunction is what keeps a background
  // refetch over cached data off the loading branch.
  const isFirstLoad = query.isPending && query.fetchStatus !== 'idle';

  return { ...query, isPending: isFirstLoad, isLoading: isFirstLoad };
}
