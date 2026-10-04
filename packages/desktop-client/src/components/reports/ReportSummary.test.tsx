import React from 'react';

import * as monthUtils from '@actual-app/core/shared/months';
import type { DataEntity } from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { ReportSummary } from './ReportSummary';

const data = {
  intervalData: [],
  totalDebts: -100,
  totalAssets: 200,
  netAssets: 100,
  netDebts: 0,
  totalTotals: 100,
  totalBudgeted: 0,
} satisfies DataEntity;

/**
 * `monthUtils.currentDay()` is hardcoded under the test setup (it short-circuits
 * on `global.IS_TESTING`), so the clamp cannot be moved with fake timers — the
 * module function itself has to be replaced.
 */
function pinToday(today: string) {
  vi.spyOn(monthUtils, 'currentDay').mockReturnValue(today);
}

/**
 * The date range lives in the summary's first child view. Read it directly
 * rather than through `getByText`, because a yearly report collapses the range
 * to a bare year and the summary body renders other strings a substring search
 * would trip over.
 */
function getHeader(container: HTMLElement) {
  const header = container.firstElementChild?.firstElementChild;
  if (!header) {
    throw new Error('Summary header did not render');
  }
  return header;
}

function renderSummary({
  startDate,
  endDate,
  interval,
  firstDayOfWeekIdx,
}: {
  startDate: string;
  endDate: string;
  interval: string;
  firstDayOfWeekIdx?: SyncedPrefs['firstDayOfWeekIdx'];
}) {
  return render(
    <TestProviders>
      <ReportSummary
        startDate={startDate}
        endDate={endDate}
        data={data}
        balanceTypeOp="netAssets"
        interval={interval}
        intervalsCount={4}
        firstDayOfWeekIdx={firstDayOfWeekIdx}
      />
    </TestProviders>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReportSummary date range', () => {
  it('stops a weekly header at today while the final week is in progress', () => {
    pinToday('2026-10-02');

    renderSummary({
      startDate: '2026-08-30',
      endDate: '2026-09-27',
      interval: 'Weekly',
    });

    // 2026-09-27 is a Sunday whose week runs to 10/03, but 10/03 has not
    // happened, so the header stops at today.
    expect(screen.getByText('08/30/2026 to 10/02/2026')).toBeInTheDocument();
    expect(screen.queryByText(/to 09\/27\/2026/)).not.toBeInTheDocument();
  });

  it("stops an elapsed weekly header at the week's end", () => {
    pinToday('2026-10-04');

    renderSummary({
      startDate: '2026-08-30',
      endDate: '2026-09-27',
      interval: 'Weekly',
    });

    expect(screen.getByText('08/30/2026 to 10/03/2026')).toBeInTheDocument();
    expect(screen.queryByText(/10\/04\/2026/)).not.toBeInTheDocument();
  });

  it('keeps a weekly header in the past on that past week', () => {
    pinToday('2026-10-02');

    renderSummary({
      startDate: '2026-08-30',
      endDate: '2026-09-13',
      interval: 'Weekly',
    });

    expect(screen.getByText('08/30/2026 to 09/19/2026')).toBeInTheDocument();
    expect(screen.queryByText(/10\/02\/2026/)).not.toBeInTheDocument();
  });

  it('clamps a weekly header whose week has not started yet to today', () => {
    pinToday('2026-10-02');

    renderSummary({
      startDate: '2026-09-06',
      endDate: '2026-10-11',
      interval: 'Weekly',
    });

    expect(screen.getByText('09/06/2026 to 10/02/2026')).toBeInTheDocument();
  });

  it('honours a Monday first day of week in the weekly header', () => {
    pinToday('2026-10-09');

    const { container } = renderSummary({
      startDate: '2026-09-28',
      endDate: '2026-09-28',
      interval: 'Weekly',
      firstDayOfWeekIdx: '1',
    });

    expect(getHeader(container)).toHaveTextContent('09/28/2026 to 10/04/2026');
  });

  it('stops a Sunday-first week one day earlier than a Monday-first one', () => {
    // Same inputs as above, so the pair proves the pref reaches the header: a
    // To that is itself the last day of its week would make either case a
    // no-op and both assertions pass with the pref ignored.
    pinToday('2026-10-09');

    const { container } = renderSummary({
      startDate: '2026-09-28',
      endDate: '2026-09-28',
      interval: 'Weekly',
      firstDayOfWeekIdx: '0',
    });

    expect(getHeader(container)).toHaveTextContent('09/28/2026 to 10/03/2026');
  });

  it('leaves a Daily header on the dates it was given', () => {
    pinToday('2026-10-02');

    renderSummary({
      startDate: '2026-08-30',
      endDate: '2026-09-27',
      interval: 'Daily',
    });

    expect(screen.getByText('08/30/2026 to 09/27/2026')).toBeInTheDocument();
  });

  it('leaves a Monthly header at month granularity', () => {
    pinToday('2026-10-02');

    renderSummary({
      startDate: '2026-08-01',
      endDate: '2026-09-30',
      interval: 'Monthly',
    });

    expect(screen.getByText("Aug '26 to Sep '26")).toBeInTheDocument();
  });

  it('collapses a Yearly header that falls inside one year', () => {
    pinToday('2026-10-02');

    const { container } = renderSummary({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      interval: 'Yearly',
    });

    // Exact text, not a substring: both ends format to '2026', so the
    // from-to segment is suppressed entirely.
    expect(getHeader(container).textContent).toBe('2026');
  });
});
