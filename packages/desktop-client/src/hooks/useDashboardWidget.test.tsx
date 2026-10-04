import type { ReactNode } from 'react';

import { initServer } from '@actual-app/core/platform/client/connection';
import type { NetWorthWidget } from '@actual-app/core/types/models';
import { render, renderHook, screen, waitFor } from '@testing-library/react';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';

import { useDashboardWidget } from './useDashboardWidget';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

const widget: NetWorthWidget = {
  id: 'widget-1',
  dashboard_page_id: 'page-1',
  type: 'net-worth-card',
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  meta: { name: 'Net Worth' },
  tombstone: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

let queryCalls = 0;
type WidgetQueryResult = { data: NetWorthWidget[]; dependencies: string[] };

let nextWidgets: Promise<WidgetQueryResult>;

beforeEach(() => {
  queryCalls = 0;
  nextWidgets = Promise.resolve({ data: [widget], dependencies: [] });
  initServer({
    query: () => {
      queryCalls += 1;
      return nextWidgets;
    },
  });
});

function setup() {
  const queryClient = createTestQueryClient();
  const store = configureTestAppStore({ queryClient });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TestProviders queryClient={queryClient} store={store}>
      {children}
    </TestProviders>
  );

  return { queryClient, wrapper };
}

// Records what a report route would have rendered on every render, so a claim
// like "it never went back to the spinner" is checked across the refetch and
// not only against the value the hook settled on.
function WidgetProbe({ onRender }: { onRender: (isPending: boolean) => void }) {
  const { data, isPending } = useDashboardWidget<NetWorthWidget>({
    id: widget.id,
    type: 'net-worth-card',
  });
  onRender(isPending);

  return isPending ? (
    <div>Loading widget</div>
  ) : (
    <div>Net Worth widget: {data?.meta?.name}</div>
  );
}

describe('useDashboardWidget', () => {
  it('is neither pending nor loading when the widget is disabled by a missing id', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useDashboardWidget({ id: undefined }), {
      wrapper,
    });

    // A disabled query never fetches, and react-query would otherwise leave it
    // 'pending' forever, which is what kept every id-less report route spinning.
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.isPending).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(queryCalls).toBe(0);
  });

  it('is pending and loading on the first load, and neither once it resolves', async () => {
    const widgets = deferred<WidgetQueryResult>();
    nextWidgets = widgets.promise;

    const { wrapper } = setup();
    const { result } = renderHook(
      () =>
        useDashboardWidget<NetWorthWidget>({
          id: widget.id,
          type: 'net-worth-card',
        }),
      { wrapper },
    );

    expect(result.current.isPending).toBe(true);
    expect(result.current.isLoading).toBe(true);

    widgets.resolve({ data: [widget], dependencies: [] });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data?.meta?.name).toBe('Net Worth');
  });

  it('stays loaded through a background refetch over cached data', async () => {
    const widgets = deferred<WidgetQueryResult>();
    nextWidgets = widgets.promise;

    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(['dashboards', 'lists', 'widgets'], [widget]);

    const renders: boolean[] = [];
    render(<WidgetProbe onRender={isPending => renders.push(isPending)} />, {
      wrapper,
    });

    // Even the fetch the mount itself triggers is a refetch over cached data.
    await waitFor(() => expect(queryCalls).toBe(1));
    expect(screen.getByText('Net Worth widget: Net Worth')).toBeInTheDocument();

    void queryClient.refetchQueries();

    widgets.resolve({ data: [widget], dependencies: [] });

    await waitFor(() => expect(queryCalls).toBe(2));
    expect(screen.getByText('Net Worth widget: Net Worth')).toBeInTheDocument();
    // Deriving the flag from fetchStatus alone would put a spinner back here on
    // every navigation to a report.
    expect(renders).not.toContain(true);
  });
});
