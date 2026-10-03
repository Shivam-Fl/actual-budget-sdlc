import React from 'react';

import { send } from '@actual-app/core/platform/client/connection';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { useTransactionBatchActions } from './useTransactionBatchActions';

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: vi.fn(),
}));

function renderBatchActions() {
  return renderHook(() => useTransactionBatchActions(), {
    wrapper: ({ children }) => <TestProviders>{children}</TestProviders>,
  });
}

describe('useTransactionBatchActions.onBatchUnlinkSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('clears the occurrence stamp alongside the schedule link', async () => {
    const { result } = renderBatchActions();

    await result.current.onBatchUnlinkSchedule({ ids: ['t1', 't2'] });

    // Asserted on the literal payload the register sends rather than on the
    // builder in isolation, so this still fails if the hook is routed around
    // `unlinkScheduleUpdate`.
    expect(send).toHaveBeenCalledWith('transactions-batch-update', {
      updated: [
        { id: 't1', schedule: null, schedule_occurrence: null },
        { id: 't2', schedule: null, schedule_occurrence: null },
      ],
    });
  });

  test('calls onSuccess with the unlinked ids', async () => {
    const { result } = renderBatchActions();
    const onSuccess = vi.fn();

    await result.current.onBatchUnlinkSchedule({
      ids: ['t1', 't2'],
      onSuccess,
    });

    expect(onSuccess).toHaveBeenCalledWith(['t1', 't2']);
  });
});
