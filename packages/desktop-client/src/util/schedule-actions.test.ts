import { describe, expect, test } from 'vitest';

import { linkScheduleUpdate, unlinkScheduleUpdate } from './schedule-actions';

describe('linkScheduleUpdate', () => {
  test('writes the link and a nulled occurrence stamp as one pair', () => {
    // `toStrictEqual`, not `toMatchObject`: an object with `schedule_occurrence`
    // absent satisfies `toMatchObject`, which is exactly the defect this pair
    // of builders exists to prevent — an update that drops the key leaves the
    // column holding the stamp from the schedule the row used to be linked to.
    expect(linkScheduleUpdate('t1', 'schedule-1')).toStrictEqual({
      id: 't1',
      schedule: 'schedule-1',
      schedule_occurrence: null,
    });
  });

  test('carries schedule_occurrence as an own property, not a missing key', () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        linkScheduleUpdate('t1', 'schedule-1'),
        'schedule_occurrence',
      ),
    ).toBe(true);
  });
});

describe('unlinkScheduleUpdate', () => {
  test('clears the link and the occurrence stamp together', () => {
    expect(unlinkScheduleUpdate('t1')).toStrictEqual({
      id: 't1',
      schedule: null,
      schedule_occurrence: null,
    });
  });

  test('carries schedule_occurrence as an own property, not a missing key', () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        unlinkScheduleUpdate('t1'),
        'schedule_occurrence',
      ),
    ).toBe(true);
  });
});
