// @ts-strict-ignore
import * as d from 'date-fns';
import { v4 as uuidv4 } from 'uuid';

import { captureBreadcrumb } from '#platform/exceptions';
import * as connection from '#platform/server/connection';
import { logger } from '#platform/server/log';
import { addTransactions } from '#server/accounts/sync';
import { createApp } from '#server/app';
import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { toDateRepr } from '#server/models';
import { mutator, runMutator } from '#server/mutators';
import * as prefs from '#server/prefs';
import { Rule } from '#server/rules';
import { addSyncListener, batchMessages } from '#server/sync';
import {
  getRules,
  insertRule,
  ruleModel,
  updateRule,
} from '#server/transactions/transaction-rules';
import { undoable } from '#server/undo';
import { RSchedule } from '#server/util/rschedule';
import { currentDay, dayFromDate } from '#shared/months';
import { q } from '#shared/query';
import {
  DEFAULT_UPCOMING_SCHEDULE_DAYS,
  extractScheduleConds,
  getDateWithSkippedWeekend,
  getHasTransactionsQuery,
  getNextDate,
  getNextDateAfter,
  getScheduledAmount,
  getStatus,
  MAX_ADVANCE_ATTEMPTS,
  recurConfigToRSchedule,
} from '#shared/schedules';
import type {
  RuleActionEntity,
  RuleConditionEntity,
  ScheduleEntity,
} from '#types/models';

import { findSchedules } from './find-schedules';

// Utilities

function zip(arr1, arr2) {
  const result = [];
  for (let i = 0; i < arr1.length; i++) {
    result.push([arr1[i], arr2[i]]);
  }
  return result;
}

export function areConditionValuesEqual(left, right) {
  if (left === right) {
    return true;
  }

  if (left == null || right == null) {
    return left === right;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => areConditionValuesEqual(value, right[index]))
    );
  }

  if (typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();

    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => {
        const rightKey = rightKeys[index];
        return (
          key === rightKey &&
          areConditionValuesEqual(left[key], right[rightKey])
        );
      })
    );
  }

  return false;
}

function areScheduleConditionsEqual(
  left?: RuleConditionEntity,
  right?: RuleConditionEntity,
) {
  if (left == null || right == null) {
    return left === right;
  }

  const { type: _leftType, ...leftCondition } = left;
  const { type: _rightType, ...rightCondition } = right;

  return areConditionValuesEqual(leftCondition, rightCondition);
}

export function updateConditions(conditions, newConditions) {
  const scheduleConds = extractScheduleConds(conditions);
  const newScheduleConds = extractScheduleConds(newConditions);

  const replacements = zip(
    Object.values(scheduleConds),
    Object.values(newScheduleConds),
  );

  const updated = conditions.map(cond => {
    const r = replacements.find(r => cond === r[0]);
    return r && r[1] ? r[1] : cond;
  });

  const added = replacements
    .filter(x => x[0] == null && x[1] != null)
    .map(x => x[1]);

  return updated.concat(added);
}

// Keep a rule's actions in sync with its (edited) schedule conditions.
//
// A schedule's amount lives in the rule's amount *condition*, but a rule can
// also carry a plain `set amount` *action* (e.g. when customized via "Edit as
// rule"). Posting a scheduled transaction runs the rule, so a stale action
// would revert the posted amount to the old value, ignoring the edited
// amount. Keep such actions in sync with the amount condition.
//
// Only plain `set amount` actions are rewritten:
//   - Templated/formula actions (`options.template`/`options.formula`) compute
//     their own value, so they're left untouched.
//   - `set-split-amount` actions have a different `op` and so are excluded by
//     the `action.op === 'set'` check below.
//
// Returns `null` when nothing changed, so callers can avoid a redundant write.
function updateActions(
  conditions: RuleConditionEntity[],
  actions: RuleActionEntity[],
): RuleActionEntity[] | null {
  const { amount: amountCond } = extractScheduleConds(conditions);
  if (amountCond === null) {
    return null;
  }

  // Mirrors how `_amount` resolves: a deleted/empty amount condition value
  // yields 0, so the action is synced to 0 too, keeping it consistent with
  // the amount the schedule actually posts.
  const amount = getScheduledAmount(amountCond.value);

  let changed = false;
  const updated = actions.map(action => {
    if (
      action.op === 'set' &&
      action.field === 'amount' &&
      !action.options?.template &&
      !action.options?.formula &&
      action.value !== amount
    ) {
      changed = true;
      return { ...action, value: amount };
    }
    return action;
  });

  return changed ? updated : null;
}

export async function getRuleForSchedule(id: string | null): Promise<Rule> {
  if (id == null) {
    throw new Error('Schedule not attached to a rule');
  }

  const { data: ruleId } = await aqlQuery(
    q('schedules').filter({ id }).calculate('rule'),
  );
  return getRules().find(rule => rule.id === ruleId);
}

async function fixRuleForSchedule(id) {
  const { data: ruleId } = await aqlQuery(
    q('schedules').filter({ id }).calculate('rule'),
  );

  if (ruleId) {
    // Take the bad rule out of the system so it never causes problems
    // in the future
    await db.delete_('rules', ruleId);
  }

  const newId = await insertRule({
    stage: null,
    conditionsOp: 'and',
    conditions: [
      { op: 'isapprox', field: 'date', value: currentDay() },
      { op: 'isapprox', field: 'amount', value: 0 },
    ],
    actions: [{ op: 'link-schedule', value: id }],
  });

  await db.updateWithSchema('schedules', { id, rule: newId });

  return getRules().find(rule => rule.id === newId);
}

export async function setNextDate({
  id,
  conditions,
  reset,
  advance,
}: {
  id: string;
  conditions?;
  reset?: boolean;
  advance?: boolean;
}) {
  if (conditions == null) {
    const rule = await getRuleForSchedule(id);
    if (rule == null) {
      throw new Error('No rule found for schedule');
    }
    conditions = rule.serialize().conditions;
  }

  const { date: dateCond } = extractScheduleConds(conditions);

  const { data: nextDate } = await aqlQuery(
    q('schedules').filter({ id }).calculate('next_date'),
  );

  // Only do this if a date condition exists
  if (dateCond) {
    // Our `update` functon requires the id of the item and we don't
    // have it, so we need to query it. The skip list is read here too,
    // before the arithmetic, because it decides where `next_date` may land.
    const nd = await db.first<
      Pick<
        db.DbScheduleNextDate,
        'id' | 'base_next_date_ts' | 'skipped_occurrences'
      >
    >(
      'SELECT id, base_next_date_ts, skipped_occurrences FROM schedules_next_date WHERE schedule_id = ?',
      [id],
    );
    const skippedOccurrences = parseSkippedOccurrences(nd.skipped_occurrences);

    let newNextDate = advance
      ? getNextDateAfter(dateCond, nextDate)
      : getNextDate(dateCond, new Date());

    // `next_date` is what `getStatus` and `advanceSchedulesService` read as
    // "due", so it must never come to rest on an occurrence the user skipped:
    // that would auto-post a payment they said will not happen. The loop is
    // unconditional — the reset path and the bare `setNextDate({ id })` call
    // take the same route into it — and bounded, because a skip list can
    // name occurrences a recurrence stops producing.
    for (
      let attempt = 0;
      attempt < MAX_ADVANCE_ATTEMPTS &&
      newNextDate != null &&
      skippedOccurrences.includes(newNextDate);
      attempt++
    ) {
      newNextDate = getNextDateAfter(dateCond, newNextDate);
    }

    if (newNextDate != null && newNextDate !== nextDate) {
      await db.update('schedules_next_date', {
        id: nd.id,
        ...(reset
          ? {
              base_next_date: toDateRepr(newNextDate),
              base_next_date_ts: Date.now(),
            }
          : {
              local_next_date: toDateRepr(newNextDate),
              local_next_date_ts: nd.base_next_date_ts,
            }),
        // Skips `next_date` has now moved past can never be reached again,
        // so they are dropped here rather than accumulating for the life of
        // the schedule.
        skipped_occurrences: JSON.stringify(
          skippedOccurrences.filter(date => date > newNextDate).sort(),
        ),
      });
    }
  }
}

// Methods

async function checkIfScheduleExists(name, scheduleId) {
  const idForName = await db.first<Pick<db.DbSchedule, 'id'>>(
    'SELECT id from schedules WHERE tombstone = 0 AND name = ?',
    [name],
  );

  if (idForName == null) {
    return false;
  }
  if (scheduleId) {
    return idForName['id'] !== scheduleId;
  }
  return true;
}

function normalizeScheduleName(name) {
  const trimmedName = name?.trim();
  return trimmedName || null;
}

async function moveSchedule({
  id,
  targetId,
}: {
  id: string;
  targetId: string | null;
}) {
  await db.moveSchedule(id, targetId);
  return {};
}

export async function createSchedule({
  schedule = null,
  conditions = [],
}: {
  schedule?: Partial<ScheduleEntity> | null;
  conditions?: RuleConditionEntity[];
} = {}): Promise<ScheduleEntity['id']> {
  const scheduleId = schedule?.id || uuidv4();

  const { date: dateCond } = extractScheduleConds(conditions);
  if (dateCond == null) {
    throw new Error('A date condition is required to create a schedule');
  }
  if (dateCond.value == null) {
    throw new Error('Date is required');
  }

  const nextDate = getNextDate(dateCond);
  const nextDateRepr = nextDate ? toDateRepr(nextDate) : null;
  const scheduleFields = schedule && {
    ...schedule,
    name: normalizeScheduleName(schedule.name),
  };
  if (scheduleFields) {
    if (scheduleFields.name) {
      if (await checkIfScheduleExists(scheduleFields.name, scheduleId)) {
        throw new Error('Cannot create schedules with the same name');
      }
    }
  }

  // Create the rule here based on the info
  const ruleId = await insertRule({
    stage: null,
    conditionsOp: 'and',
    conditions,
    actions: [{ op: 'link-schedule', value: scheduleId }],
  });

  const now = Date.now();
  await db.insertWithUUID('schedules_next_date', {
    schedule_id: scheduleId,
    local_next_date: nextDateRepr,
    local_next_date_ts: now,
    base_next_date: nextDateRepr,
    base_next_date_ts: now,
  });

  await db.insertWithSchema('schedules', {
    ...scheduleFields,
    id: scheduleId,
    rule: ruleId,
  });

  return scheduleId;
}

// TODO: don't allow deleting rules that link schedules

export async function updateSchedule({
  schedule,
  conditions,
  resetNextDate,
}: {
  schedule: Partial<ScheduleEntity> & Pick<ScheduleEntity, 'id'>;
  conditions?: RuleConditionEntity[];
  resetNextDate?: boolean;
}) {
  if (schedule.rule) {
    throw new Error('You cannot change the rule of a schedule');
  }
  const scheduleFields = { ...schedule };
  if ('name' in scheduleFields) {
    scheduleFields.name = normalizeScheduleName(scheduleFields.name);
    if (
      scheduleFields.name &&
      (await checkIfScheduleExists(scheduleFields.name, scheduleFields.id))
    ) {
      throw new Error('Cannot update schedules with the same name');
    }
  }
  let rule;

  // This must be outside the `batchMessages` call because we change
  // and then read data
  if (conditions) {
    const { date: dateCond } = extractScheduleConds(conditions);
    if (dateCond && dateCond.value == null) {
      throw new Error('Date is required');
    }

    // We need to get the full rule to merge in the updated
    // conditions
    rule = await getRuleForSchedule(schedule.id);

    if (rule == null) {
      // In the edge case that a rule gets corrupted (either by a bug in
      // the system or user messing with their data), don't crash. We
      // generate a new rule because schedules have to have a rule
      // attached to them.
      rule = await fixRuleForSchedule(schedule.id);
    }
  }

  await batchMessages(async () => {
    if (conditions) {
      const oldConditions = rule.serialize().conditions;
      const newConditions = updateConditions(oldConditions, conditions);

      const newActions = updateActions(newConditions, rule.serialize().actions);

      await updateRule({
        id: rule.id,
        conditions: newConditions,
        ...(newActions ? { actions: newActions } : {}),
      });

      // Annoyingly, sometimes it has `type` and sometimes it doesn't
      const stripType = ({ type: _type, ...fields }) => fields;

      // Update `next_date` if the user forced it, or if the account
      // or date changed. We check account because we don't update
      // schedules automatically for closed account, and the user
      // might switch accounts from a closed one
      if (
        resetNextDate ||
        !areScheduleConditionsEqual(
          oldConditions.find(c => c.field === 'account'),
          newConditions.find(c => c.field === 'account'),
        ) ||
        !areConditionValuesEqual(
          stripType(oldConditions.find(c => c.field === 'date') || {}),
          stripType(newConditions.find(c => c.field === 'date') || {}),
        )
      ) {
        await setNextDate({
          id: schedule.id,
          conditions: newConditions,
          reset: true,
        });
      }
    } else if (resetNextDate) {
      await setNextDate({ id: schedule.id, reset: true });
    }

    await db.updateWithSchema('schedules', scheduleFields);
  });

  return scheduleFields.id;
}

export async function deleteSchedule({ id }) {
  const { data: ruleId } = await aqlQuery(
    q('schedules').filter({ id }).calculate('rule'),
  );

  await batchMessages(async () => {
    await db.delete_('rules', ruleId);
    await db.delete_('schedules', id);
  });
}

// The column holds a JSON array of `YYYY-MM-DD` strings, but it is read here
// through raw SQL rather than AQL, so it is still text at this boundary.
function parseSkippedOccurrences(value: string | null | undefined): string[] {
  if (value == null || value === '') {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Only reachable with a value this app did not write. Falling back to "no
    // skips recorded" degrades to the old behaviour — a skipped occurrence
    // reappears in the register and in the forecast — which is recoverable,
    // whereas failing the handler would strand the schedule entirely.
    return [];
  }
}

export async function skipNextDate({
  id,
  date,
}: {
  id: string;
  date?: string;
}) {
  if (date == null) {
    return setNextDate({ id, advance: true });
  }

  const { data: nextDate } = await aqlQuery(
    q('schedules').filter({ id }).calculate('next_date'),
  );

  // Skipping the occurrence `next_date` already sits on is the original
  // behaviour: advance the schedule's anchor one step.
  if (date === nextDate) {
    return setNextDate({ id, advance: true });
  }

  const nd = await db.first<
    Pick<db.DbScheduleNextDate, 'id' | 'skipped_occurrences'>
  >(
    'SELECT id, skipped_occurrences FROM schedules_next_date WHERE schedule_id = ?',
    [id],
  );

  const skippedOccurrences = parseSkippedOccurrences(nd.skipped_occurrences);

  // A record, not a move: `next_date` stays on the earliest occurrence still
  // owed, so skipping a later one does not take the occurrences in between
  // with it. The filter drops anything at or before `next_date` — a stale
  // occurrence is already unreachable, so it records nothing.
  await db.update('schedules_next_date', {
    id: nd.id,
    skipped_occurrences: JSON.stringify(
      [...new Set([...skippedOccurrences, date])]
        .filter(occurrence => occurrence > nextDate)
        .sort(),
    ),
  });
}

function discoverSchedules() {
  return findSchedules();
}

async function getUpcomingDates({ config, count }) {
  const rules = recurConfigToRSchedule(config);

  try {
    const schedule = new RSchedule({ rrules: rules });

    return schedule
      .occurrences({ start: d.startOfDay(new Date()), take: count })
      .toArray()
      .map(date =>
        config.skipWeekend
          ? getDateWithSkippedWeekend(date.date, config.weekendSolveMode)
          : date.date,
      )
      .map(date => dayFromDate(date));
  } catch (err) {
    captureBreadcrumb(config);
    throw err;
  }
}

// Services

function onRuleUpdate(rule) {
  const { actions, conditions } =
    rule instanceof Rule ? rule.serialize() : ruleModel.toJS(rule);

  if (actions && actions.find(a => a.op === 'link-schedule')) {
    const scheduleId = actions.find(a => a.op === 'link-schedule').value;

    if (scheduleId) {
      const conds = extractScheduleConds(conditions);

      const payeeIdx = conditions.findIndex(c => c === conds.payee);
      const accountIdx = conditions.findIndex(c => c === conds.account);
      const amountIdx = conditions.findIndex(c => c === conds.amount);
      const dateIdx = conditions.findIndex(c => c === conds.date);

      db.runQuery(
        'INSERT OR REPLACE INTO schedules_json_paths (schedule_id, payee, account, amount, date) VALUES (?, ?, ?, ?, ?)',
        [
          scheduleId,
          payeeIdx === -1 ? null : `$[${payeeIdx}]`,
          accountIdx === -1 ? null : `$[${accountIdx}]`,
          amountIdx === -1 ? null : `$[${amountIdx}]`,
          dateIdx === -1 ? null : `$[${dateIdx}]`,
        ],
      );
    }
  }
}

function trackJSONPaths() {
  // Populate the table
  db.transaction(() => {
    getRules().forEach(rule => {
      onRuleUpdate(rule);
    });
  });

  return addSyncListener(onApplySync);
}

function onApplySync(oldValues, newValues) {
  newValues.forEach((items, table) => {
    if (table === 'rules') {
      items.forEach(newValue => {
        onRuleUpdate(newValue);
      });
    }
  });
}

// This is the service that move schedules forward automatically and
// posts transactions

async function postTransactionForSchedule({
  id,
  date,
  today,
}: {
  id: string;
  date?: string;
  today?: boolean;
}) {
  const { data } = await aqlQuery(q('schedules').filter({ id }).select('*'));
  const schedule = data[0];
  if (schedule == null || schedule._account == null) {
    return;
  }

  // The occurrence this post discharges. Posting from the register can select a
  // LATER occurrence than the one `next_date` sits on, and that has to be the
  // one recorded — `next_date` here is simply the earliest one still owed.
  // `today` only decides when the transaction is dated, never which occurrence
  // it pays: a caller that names an occurrence is honoured for both.
  const occurrence = date ?? schedule.next_date;

  // Consuming an occurrence is idempotent: the stamp below IS the identity the
  // whole per-occurrence model rests on, so a second message for an occurrence
  // that is already posted must not write again. A double-clicked menu item, or
  // a message redelivered because the first reply was lost, would otherwise
  // leave two transactions stamped for one occurrence.
  //
  // This is safe without a lock because the handler is registered as
  // `mutator(undoable(...))`, and `runHandler` routes every marked handler
  // through `runMutator`, which is `sequential(_runMutator)` — two dispatches
  // cannot interleave, so the second check always sees the first write.
  //
  // Not applied to `today` without a date: that path pays `next_date` early
  // and leaves the occurrence pending, so it may legitimately be invoked more
  // than once. A `today` post that *did* name an occurrence consumes it, and is
  // guarded like any other.
  if (!today || date != null) {
    const {
      data: [alreadyPosted],
    } = await aqlQuery(
      q('transactions')
        .filter({ schedule: schedule.id, schedule_occurrence: occurrence })
        .select('id'),
    );

    if (alreadyPosted != null) {
      return;
    }
  }

  const transaction = {
    payee: schedule._payee,
    account: schedule._account,
    amount: getScheduledAmount(schedule._amount),
    date: today ? currentDay() : (date ?? schedule.next_date),
    schedule: schedule.id,
    // Records WHICH occurrence this discharges. The date above is the user's to
    // edit; this is not, and matching on it is what keeps a re-dated payment
    // from un-paying the occurrence it was posted for.
    schedule_occurrence: occurrence,
    cleared: false,
  };

  if (transaction.account) {
    await addTransactions(transaction.account, [transaction]);
  }
}

async function getSchedule(id: string): Promise<ScheduleEntity | null> {
  const {
    data: [schedule],
  } = await aqlQuery(q('schedules').filter({ id }).select('*'));

  return schedule ?? null;
}

export async function getCompletedScheduleRuleIds(): Promise<string[]> {
  const { data } = await aqlQuery(
    q('schedules').filter({ completed: true }).select(['rule']),
  );

  return data
    .map(schedule => schedule.rule)
    .filter((rule): rule is string => !!rule);
}

async function hasTransactionForSchedule(
  schedule: ScheduleEntity,
): Promise<boolean> {
  const { data } = await aqlQuery(getHasTransactionsQuery([schedule]));

  return data.filter(Boolean).some(row => row.schedule === schedule.id);
}

function isRecurringSchedule(schedule: ScheduleEntity): boolean {
  return (
    schedule._date != null &&
    typeof schedule._date === 'object' &&
    'frequency' in schedule._date
  );
}

async function advanceRecurringScheduleFromNextDate(
  schedule: ScheduleEntity,
): Promise<ScheduleEntity | null> {
  if (!isRecurringSchedule(schedule)) {
    return null;
  }

  const previousNextDate = schedule.next_date;

  try {
    await setNextDate({ id: schedule.id, advance: true });
  } catch {
    // This might error if the rule is corrupted and it can't find the rule.
    return null;
  }

  const updatedSchedule = await getSchedule(schedule.id);

  if (
    updatedSchedule == null ||
    updatedSchedule.next_date === previousNextDate
  ) {
    return null;
  }

  return updatedSchedule;
}

// TODO: make this sequential

export async function advanceSchedulesService(syncSuccess) {
  // Move all paid schedules
  const { data: schedules } = await aqlQuery(
    q('schedules')
      .filter({ completed: false, '_account.closed': false })
      .select('*'),
  );

  const { data: hasTransData } = await aqlQuery(
    getHasTransactionsQuery(schedules),
  );
  const hasTrans = new Set(
    hasTransData.filter(Boolean).map(row => row.schedule),
  );

  const failedToPost = [];
  let didPost = false;

  const { data: upcomingLength } = await aqlQuery(
    q('preferences')
      .filter({ id: 'upcomingScheduledTransactionLength' })
      .select('value'),
  );

  for (const schedule of schedules) {
    const status = getStatus(
      schedule.next_date,
      schedule.completed,
      hasTrans.has(schedule.id),
      schedule.custom_upcoming_length ??
        upcomingLength[0]?.value ??
        DEFAULT_UPCOMING_SCHEDULE_DAYS,
    );

    if (
      schedule.posts_transaction &&
      schedule._account &&
      (status !== 'paid' || isRecurringSchedule(schedule)) &&
      (status === 'paid' || status === 'due' || status === 'missed')
    ) {
      let currentSchedule = schedule;
      let currentStatus = status;

      while (
        currentSchedule.posts_transaction &&
        currentSchedule._account &&
        (currentStatus === 'paid' ||
          currentStatus === 'due' ||
          currentStatus === 'missed')
      ) {
        if (currentStatus === 'paid') {
          if (currentSchedule.next_date === currentDay()) {
            break;
          }

          const updatedSchedule =
            await advanceRecurringScheduleFromNextDate(currentSchedule);

          if (updatedSchedule == null) {
            break;
          }

          currentSchedule = updatedSchedule;
          currentStatus = getStatus(
            currentSchedule.next_date,
            currentSchedule.completed,
            await hasTransactionForSchedule(currentSchedule),
            currentSchedule.custom_upcoming_length ??
              upcomingLength[0]?.value ??
              DEFAULT_UPCOMING_SCHEDULE_DAYS,
          );
          continue;
        }

        // Automatically create a transaction for due schedules.
        if (syncSuccess) {
          await postTransactionForSchedule({ id: currentSchedule.id });

          didPost = true;
        } else {
          failedToPost.push(currentSchedule._payee);
          break;
        }

        // do not skip schedules due today
        if (currentStatus === 'due') {
          break;
        }

        if (!isRecurringSchedule(currentSchedule)) {
          break;
        }

        const updatedSchedule =
          await advanceRecurringScheduleFromNextDate(currentSchedule);

        if (updatedSchedule == null) {
          break;
        }

        currentSchedule = updatedSchedule;
        currentStatus = getStatus(
          currentSchedule.next_date,
          currentSchedule.completed,
          await hasTransactionForSchedule(currentSchedule),
          currentSchedule.custom_upcoming_length ??
            upcomingLength[0]?.value ??
            DEFAULT_UPCOMING_SCHEDULE_DAYS,
        );
      }
    } else if (status === 'paid') {
      if (schedule._date) {
        // Move forward recurring schedules
        if (isRecurringSchedule(schedule)) {
          try {
            await setNextDate({ id: schedule.id });
          } catch {
            // This might error if the rule is corrupted and it can't
            // find the rule
          }
        } else {
          if (schedule._date < currentDay()) {
            // Complete any single schedules
            await updateSchedule({
              schedule: { id: schedule.id, completed: true },
            });
          }
        }
      }
    }
  }

  if (failedToPost.length > 0) {
    connection.send('schedules-offline');
  } else if (didPost) {
    // This forces a full refresh of transactions because it
    // simulates them coming in from a full sync. This not a
    // great API right now, but I think generally the approach
    // is sane to treat them as external sync events.
    connection.send('sync-event', {
      type: 'success',
      tables: ['transactions'],
      syncDisabled: false,
    });
  }
}

export type SchedulesHandlers = {
  'schedule/create': typeof createSchedule;
  'schedule/update': typeof updateSchedule;
  'schedule/delete': typeof deleteSchedule;
  'schedule/move': typeof moveSchedule;
  'schedule/skip-next-date': typeof skipNextDate;
  'schedule/post-transaction': typeof postTransactionForSchedule;
  'schedule/force-run-service': typeof advanceSchedulesService;
  'schedule/discover': typeof discoverSchedules;
  'schedule/get-upcoming-dates': typeof getUpcomingDates;
};

// Expose functions to the client
export const app = createApp<SchedulesHandlers>();

app.method('schedule/create', mutator(undoable(createSchedule)));
app.method('schedule/update', mutator(undoable(updateSchedule)));
app.method('schedule/delete', mutator(undoable(deleteSchedule)));
app.method('schedule/move', mutator(undoable(moveSchedule)));
app.method('schedule/skip-next-date', mutator(undoable(skipNextDate)));
app.method(
  'schedule/post-transaction',
  mutator(undoable(postTransactionForSchedule)),
);
app.method(
  'schedule/force-run-service',
  mutator(() => advanceSchedulesService(true)),
);
app.method('schedule/discover', discoverSchedules);
app.method('schedule/get-upcoming-dates', getUpcomingDates);

app.service(trackJSONPaths);

app.events.on('sync', ({ type }) => {
  const completeEvent =
    type === 'success' || type === 'error' || type === 'unauthorized';

  if (completeEvent && prefs.getPrefs()) {
    if (!db.getDatabase()) {
      logger.info('database is not available, skipping schedule service');
      return;
    }

    const { lastScheduleRun } = prefs.getPrefs();
    if (lastScheduleRun !== currentDay()) {
      void runMutator(() => advanceSchedulesService(type === 'success'));

      // Only mark the day as done when sync succeeded, so that
      // schedule auto-posting is retried on subsequent successful syncs
      if (type === 'success') {
        void prefs.savePrefs({ lastScheduleRun: currentDay() });
      }
    }
  }
});
