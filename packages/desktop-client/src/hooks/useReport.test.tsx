import type { ReactNode } from 'react';

import { initServer } from '@actual-app/core/platform/client/connection';
import type { CustomReportEntity } from '@actual-app/core/types/models';
import { render, renderHook, screen, waitFor } from '@testing-library/react';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { readNormalizedSource } from '#mocks/source';

import { useReport } from './useReport';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

const report: CustomReportEntity = {
  id: 'report-1',
  name: 'Groceries',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  isDateStatic: true,
  dateRange: '2026-01-01 to 2026-12-31',
  mode: 'expenses',
  groupBy: 'category',
  interval: 'monthly',
  balanceType: 'totalExpenses',
  showEmpty: false,
  showOffBudget: false,
  showHiddenCategories: false,
  includeCurrentInterval: false,
  showUncategorized: true,
  trimIntervals: false,
  showTrendLines: false,
  graphType: 'bar',
  conditionsOp: 'and',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

let reportCalls = 0;
let nextReports: Promise<CustomReportEntity[]>;

beforeEach(() => {
  reportCalls = 0;
  nextReports = Promise.resolve([report]);
  initServer({
    'report/get': () => {
      reportCalls += 1;
      return nextReports;
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

// Records what CustomReport would have rendered on every render, so a claim
// like "it never went back to the spinner" is checked across the refetch and
// not only against the value the hook settled on.
function ReportProbe({ onRender }: { onRender: (isPending: boolean) => void }) {
  const { data, isPending } = useReport(report.id);
  onRender(isPending);

  return isPending ? (
    <div>Loading report</div>
  ) : (
    <div>Report: {data?.name ?? 'new report'}</div>
  );
}

describe('useReport', () => {
  it('is neither pending nor loading for bare /reports/custom, which has no id', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useReport(), { wrapper });

    // The route CustomReport is mounted on when no widget id is in the URL. It
    // renders <LoadingIndicator /> while isPending is true, so a query left
    // 'pending' forever by its disabled state meant that route never rendered.
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.isPending).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(reportCalls).toBe(0);
  });

  it('is pending and loading on the first load, and neither once it resolves', async () => {
    const reports = deferred<CustomReportEntity[]>();
    nextReports = reports.promise;

    const { wrapper } = setup();
    const { result } = renderHook(() => useReport(report.id), { wrapper });

    expect(result.current.isPending).toBe(true);
    expect(result.current.isLoading).toBe(true);

    reports.resolve([report]);

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data?.name).toBe('Groceries');
  });

  // Spreading the react-query result would put these back next to a derived
  // isPending that disagrees with them on bare /reports/custom. `error` had no
  // reader at all, so it is dropped too; `fetchStatus` stays because the derived
  // flag above is computed from it.
  it('exposes only data, the derived loading flags and fetchStatus', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useReport(), { wrapper });

    expect(result.current).not.toHaveProperty('status');
    expect(result.current).not.toHaveProperty('isSuccess');
    expect(result.current).not.toHaveProperty('isInitialLoading');
    expect(result.current).not.toHaveProperty('error');
  });

  it('records in a comment what isFirstLoad actually computes', () => {
    const source = readNormalizedSource(import.meta.dirname, 'useReport.ts');

    // This comment is a copy of useDashboardWidget's, so it is asserted the
    // same way — the two must not drift apart.
    expect(source).not.toContain("react-query's own isLoading definition");
    expect(source).toContain('isPending && isFetching');
    expect(source).toContain('paused');
  });

  it('stays loaded through a background refetch over cached data', async () => {
    const reports = deferred<CustomReportEntity[]>();
    nextReports = reports.promise;

    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(['reports', 'lists'], [report]);

    const renders: boolean[] = [];
    render(<ReportProbe onRender={isPending => renders.push(isPending)} />, {
      wrapper,
    });

    // Even the fetch the mount itself triggers is a refetch over cached data.
    await waitFor(() => expect(reportCalls).toBe(1));
    expect(screen.getByText('Report: Groceries')).toBeInTheDocument();

    void queryClient.refetchQueries();

    reports.resolve([report]);

    await waitFor(() => expect(reportCalls).toBe(2));
    expect(screen.getByText('Report: Groceries')).toBeInTheDocument();
    // Deriving the flag from fetchStatus alone would put a spinner back here on
    // every navigation to a report.
    expect(renders).not.toContain(true);
  });
});
