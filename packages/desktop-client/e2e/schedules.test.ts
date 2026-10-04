import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { ConfigurationPage } from './page-models/configuration-page';
import { Navigation } from './page-models/navigation';
import type { SchedulesPage } from './page-models/schedules-page';

/**
 * The React warnings a controlled `Input` emits when it is first handed a
 * `null` value, and then a string once it is typed into. Each `.` below stands
 * for a backtick, so unrelated console output that merely mentions an input or
 * a value prop does not fail the test:
 *
 *   Warning: `value` prop on an input should not be null. Consider using an
 *   empty string to clear the component or `undefined` for uncontrolled
 *   components.
 *
 *   Warning: A component is changing an uncontrolled input to be controlled.
 */
const reactInputWarning =
  /.value. prop on an input should not be null|A component is changing an uncontrolled input to be controlled/;

/** How long to let the console channel drain when no warning arrives. */
const CONSOLE_SETTLE_MS = 1000;

/**
 * Collect React's controlled/uncontrolled input warnings off the page's
 * console channel while the schedule edit modal is driven.
 *
 * Console events are delivered over CDP out of band, so awaiting anything that
 * synchronises on the DOM does not wait for them — the channel has to be given
 * its own time, which is why the caller polls it rather than reading it once.
 * Narrowed to those two warnings on purpose: dev-mode console output during
 * this flow is otherwise noisy and unrelated to what is being guarded here.
 */
function watchReactInputWarnings(page: Page): { messages: string[] } {
  const messages: string[] = [];
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = message.text();
    if (!reactInputWarning.test(text)) return;
    messages.push(text);
  });
  return { messages };
}

/**
 * Run an AQL query against the app's in-page data layer and return its rows.
 *
 * This owns the `$send('query', …)` envelope rather than repeating it: a
 * `page.evaluate` callback is serialised into the browser and so cannot close
 * over a binding hoisted into Node scope, which means deduplicating the
 * envelope means giving it exactly one Node-side owner.
 */
async function aqlQuery<T>(
  page: Page,
  {
    table,
    filterExpressions,
    selectExpressions,
  }: {
    table: string;
    filterExpressions: unknown[];
    selectExpressions: string[];
  },
): Promise<T[]> {
  const { data } = await page.evaluate(
    async ({ table, filterExpressions, selectExpressions }) => {
      const $send = (
        window as unknown as {
          $send: <T>(type: string, args?: unknown) => Promise<T>;
        }
      ).$send;

      return $send<{ data: unknown[] }>('query', {
        table,
        tableOptions: {},
        filterExpressions,
        selectExpressions,
        groupExpressions: [],
        orderExpressions: [],
        calculation: false,
        rawMode: false,
        withDead: false,
        validateRefs: true,
        limit: null,
        offset: null,
      });
    },
    { table, filterExpressions, selectExpressions },
  );

  return data as T[];
}

/**
 * A schedule's stored next date as a timestamp, rather than its rendered one:
 * the table formats dates for the current locale, so only the stored value
 * compares as a date. Throws when the schedule has no next date, which would
 * otherwise read as "not later" rather than as a broken fixture.
 */
async function readScheduleNextDate(page: Page, name: string) {
  const [schedule] = await aqlQuery<{ next_date: string }>(page, {
    table: 'schedules',
    filterExpressions: [{ name }],
    selectExpressions: ['next_date'],
  });

  const nextDate = schedule?.next_date ?? null;
  if (nextDate === null) {
    throw new Error(`Schedule "${name}" has no next date`);
  }

  return Date.parse(nextDate);
}

test.describe('Schedules', () => {
  let page: Page;
  let navigation: Navigation;
  let schedulesPage: SchedulesPage;
  let configurationPage: ConfigurationPage;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    navigation = new Navigation(page);
    configurationPage = new ConfigurationPage(page);

    await page.goto('/');
    await configurationPage.createTestFile();

    schedulesPage = await navigation.goToSchedulesPage();
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('checks the page visuals', async () => {
    await expect(page).toMatchThemeScreenshots();
  });

  test('creates a new schedule, posts the transaction and later completes it', async () => {
    const scheduleEditModal = await schedulesPage.addNewSchedule();
    await scheduleEditModal.fill({
      payee: 'Home Depot',
      account: 'HSBC',
      amount: 25,
    });
    await scheduleEditModal.add();

    const schedule = schedulesPage.getNthSchedule(2);
    await expect(schedule.payee).toHaveText('Home Depot');
    await expect(schedule.account).toHaveText('HSBC');
    await expect(schedule.amount).toHaveText('~25.00');
    await expect(schedule.status).toHaveText('Due');
    await expect(page).toMatchThemeScreenshots();

    await schedulesPage.postNthSchedule(2);
    await expect(schedulesPage.getNthSchedule(2).status).toHaveText('Paid');
    await expect(page).toMatchThemeScreenshots();

    // Go to transactions page
    const accountPage = await navigation.goToAccountPage('HSBC');
    const transaction = accountPage.getNthTransaction(0);
    await expect(transaction.payee).toHaveText('Home Depot');
    await expect(transaction.category).toHaveText('Categorize');
    await expect(transaction.debit).toHaveText('25.00');
    await expect(transaction.credit).toHaveText('');

    const icon = transaction.payee.getByTestId('schedule-icon');
    await icon.hover();
    await expect(page).toMatchThemeScreenshots();

    // go to rules page
    const rulesPage = await navigation.goToRulesPage();
    await rulesPage.searchFor('Home Depot');
    const rule = rulesPage.getNthRule(0);
    await expect(rule.actions).toHaveText([
      'link schedule Home Depot (2017-01-01)',
    ]);
    await expect(rule.conditions).toHaveText([
      'payee is Home Depot',
      'and account is HSBC',
      'and date is approx Every month on the 1st',
      'and amount is approx -25.00',
    ]);

    // Go back to schedules page
    await navigation.goToSchedulesPage();
    await schedulesPage.completeNthSchedule(2);
    await expect(schedulesPage.getNthScheduleRow(4)).toHaveText(
      'Show completed schedules',
    );
    await expect(page).toMatchThemeScreenshots();
  });

  test('shows a scheduled split transfer in its destination account', async () => {
    const [destinationAccount] = await aqlQuery<{ id: string }>(page, {
      table: 'accounts',
      filterExpressions: [{ name: 'Ally Savings' }],
      selectExpressions: ['id'],
    });
    const [destinationPayee] = await aqlQuery<{ id: string }>(page, {
      table: 'payees',
      filterExpressions: [{ transfer_acct: destinationAccount.id }],
      selectExpressions: ['id'],
    });
    const [schedule] = await aqlQuery<{ rule: string }>(page, {
      table: 'schedules',
      filterExpressions: [{ name: 'Phone bills' }],
      selectExpressions: ['rule'],
    });

    // The rule-get/rule-update pair needs the page's own `$send`, so it stays
    // browser-side and takes its data in as plain serialisable arguments.
    await page.evaluate(
      async ({ scheduleRule, destinationPayeeId }) => {
        const $send = (
          window as unknown as {
            $send: <T>(type: string, args?: unknown) => Promise<T>;
          }
        ).$send;

        const rule = await $send<{
          actions: unknown[];
          conditions: unknown[];
          conditionsOp: 'and' | 'or';
          id: string;
          stage: 'pre' | 'post' | null;
        }>('rule-get', { id: scheduleRule });

        await $send('rule-update', {
          ...rule,
          actions: [
            ...rule.actions,
            {
              op: 'set-split-amount',
              value: -7_000,
              options: { splitIndex: 1, method: 'fixed-amount' },
            },
            {
              op: 'set-split-amount',
              value: null,
              options: { splitIndex: 2, method: 'remainder' },
            },
            {
              op: 'set',
              field: 'payee',
              value: destinationPayeeId,
              options: { splitIndex: 2 },
            },
          ],
        });
      },
      { scheduleRule: schedule.rule, destinationPayeeId: destinationPayee.id },
    );

    const destinationAccountPage =
      await navigation.goToAccountPage('Ally Savings');
    const previewTransfer = destinationAccountPage.transactionTableRow.filter({
      has: page.getByTestId('schedule-icon'),
      hasText: 'Bank of America',
    });

    await expect(previewTransfer).toHaveCount(1);
    await expect(previewTransfer.getByTestId('category')).toContainText('Due');
    await expect(previewTransfer.getByTestId('debit')).toHaveText('');
    await expect(previewTransfer.getByTestId('credit')).toHaveText('50.00');
  });

  test('creates two new schedules, posts both transactions and later completes one', async () => {
    // Adding two schedules with the same payee and account and amount, mimicking two different subscriptions
    let scheduleEditModal = await schedulesPage.addNewSchedule();
    await scheduleEditModal.fill({
      payee: 'Apple',
      account: 'HSBC',
      amount: 5,
    });
    await scheduleEditModal.add();

    scheduleEditModal = await schedulesPage.addNewSchedule();
    await scheduleEditModal.fill({
      payee: 'Apple',
      account: 'HSBC',
      amount: 5,
    });
    await scheduleEditModal.add();

    const schedule = schedulesPage.getNthSchedule(2);
    await expect(schedule.payee).toHaveText('Apple');
    await expect(schedule.account).toHaveText('HSBC');
    await expect(schedule.amount).toHaveText('~5.00');
    await expect(schedule.status).toHaveText('Due');
    await expect(page).toMatchThemeScreenshots();

    const schedule2 = schedulesPage.getNthSchedule(3);
    await expect(schedule2.payee).toHaveText('Apple');
    await expect(schedule2.account).toHaveText('HSBC');
    await expect(schedule2.amount).toHaveText('~5.00');
    await expect(schedule2.status).toHaveText('Due');
    await expect(page).toMatchThemeScreenshots();

    await schedulesPage.postNthSchedule(2);
    await expect(schedulesPage.getNthSchedule(2).status).toHaveText('Paid');
    await expect(schedulesPage.getNthSchedule(3).status).toHaveText('Due');
    await expect(page).toMatchThemeScreenshots();

    await schedulesPage.postNthSchedule(3);
    await expect(schedulesPage.getNthSchedule(2).status).toHaveText('Paid');
    await expect(schedulesPage.getNthSchedule(3).status).toHaveText('Paid');
    await expect(page).toMatchThemeScreenshots();

    // Go to transactions page
    const accountPage = await navigation.goToAccountPage('HSBC');
    const transaction = accountPage.getNthTransaction(0);
    await expect(transaction.payee).toHaveText('Apple');
    await expect(transaction.category).toHaveText('Categorize');
    await expect(transaction.debit).toHaveText('5.00');
    await expect(transaction.credit).toHaveText('');

    // Go to transactions page
    const transaction2 = accountPage.getNthTransaction(1);
    await expect(transaction2.payee).toHaveText('Apple');
    await expect(transaction2.category).toHaveText('Categorize');
    await expect(transaction2.debit).toHaveText('5.00');
    await expect(transaction2.credit).toHaveText('');

    const icon = transaction.payee.getByTestId('schedule-icon');
    await icon.hover();
    await expect(page).toMatchThemeScreenshots();

    const icon2 = transaction2.payee.getByTestId('schedule-icon');
    await icon2.hover();
    await expect(page).toMatchThemeScreenshots();
  });

  test('creates a "full" list of schedules', async () => {
    // Schedules search shouldn't shrink with many schedules
    for (let i = 0; i < 10; i++) {
      const scheduleEditModal = await schedulesPage.addNewSchedule();
      await scheduleEditModal.fill({
        payee: 'Home Depot',
        account: 'HSBC',
        amount: 0,
      });
      await scheduleEditModal.add();
    }
    await expect(page).toMatchThemeScreenshots();
  });

  test('right clicking a schedule opens context menu', async () => {
    const scheduleEditModal = await schedulesPage.addNewSchedule();
    await scheduleEditModal.fill({
      payee: 'Home Depot',
      account: 'HSBC',
      amount: 25,
    });
    await scheduleEditModal.add();

    await schedulesPage.rightClickNthSchedule(2);
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Complete' })).toBeVisible();
  });

  test('hides skip on a one-off schedule and offers it on a recurring one', async () => {
    const { messages } = watchReactInputWarnings(page);

    // A one-off has no next occurrence, so skipping it moved the date nowhere.
    const oneOffModal = await schedulesPage.addNewSchedule();
    await oneOffModal.fill({
      scheduleName: 'Home Depot once',
      payee: 'Home Depot',
      account: 'HSBC',
      amount: 25,
    });
    await oneOffModal.uncheckRepeats();
    await oneOffModal.add();

    const recurringModal = await schedulesPage.addNewSchedule();
    await recurringModal.fill({
      scheduleName: 'Apple monthly',
      payee: 'Apple',
      account: 'HSBC',
      amount: 5,
    });
    await recurringModal.add();

    // The one input where "is this recurring?" and "can this be skipped?"
    // disagree: an `after_n_occurrences` recurrence whose count is already
    // spent. A one-off's date condition is a plain date, so `is recurring` was
    // already false for it, and a never-ending monthly has a next date under
    // both predicates — which is why neither of the two fixtures above can tell
    // the predicates apart.
    //
    // Repeats is already on for a new schedule: the form seeds a monthly
    // recurrence starting today, so the picker is the only date control here.
    // Left without a name, so the edit path below reaches the nameless seed.
    const exhaustedModal = await schedulesPage.addNewSchedule();
    await exhaustedModal.fill({
      payee: 'IKEA',
      account: 'HSBC',
      amount: 40,
    });

    // The trigger names the recurrence's start day as an ordinal, and the day
    // is whatever the run date makes it — Playwright pins the app's "today" to
    // 2017-01-01, a real browser does not. So the pre-Apply text is captured
    // and compared against itself rather than against a literal of ours.
    const preApplyText = await exhaustedModal.recurrenceDescription();
    expect(preApplyText).not.toContain(', once');

    await exhaustedModal.setRecurrenceEndAfterOccurrences();
    await page.getByRole('button', { name: 'Apply' }).click();

    // Only Apply writes the config back, so this is the moment the end mode
    // reaches the description — and the pre-Apply text is the expectation, so a
    // fixture that applied early fails here instead of silently satisfying a
    // looser regex.
    await expect(exhaustedModal.recurrenceDescriptionButton).toHaveText(
      `${preApplyText}, once`,
    );

    await exhaustedModal.add();

    // Located by payee rather than by index, so neither assertion can drift onto
    // the wrong row if the fixture's schedule count changes.
    const oneOffRow = schedulesPage.schedulesTableRow.filter({
      hasText: 'Home Depot',
    });
    const recurringRow = schedulesPage.schedulesTableRow.filter({
      hasText: 'Apple',
    });
    const exhaustedRow = schedulesPage.schedulesTableRow.filter({
      hasText: 'IKEA',
    });
    await expect(oneOffRow).toHaveCount(1);
    await expect(recurringRow).toHaveCount(1);
    await expect(exhaustedRow).toHaveCount(1);

    // The rest of its menu is untouched: a one-off is handled by completing it,
    // not by the item that silently does nothing. Asserted by name rather than
    // by counting the menu, which a due recurring row legitimately fills to five.
    expect(await schedulesPage.scheduleMenuItemNames(oneOffRow)).toEqual([
      'Post transaction',
      'Post transaction today',
      'Complete',
      'Delete',
    ]);

    // Same list as the one-off's, and the contrast that carries the assertion:
    // an exhausted recurrence is still a recurrence, but there is no next
    // occurrence to skip to, and `setNextDate` would drop the write.
    expect(await schedulesPage.scheduleMenuItemNames(exhaustedRow)).toEqual([
      'Post transaction',
      'Post transaction today',
      'Complete',
      'Delete',
    ]);

    // The recurring schedule still offers it, and still offers Complete
    // alongside it — the two are not mutually exclusive on this menu.
    expect(
      await schedulesPage.scheduleMenuHasItem(
        recurringRow,
        'Skip next scheduled date',
      ),
    ).toBe(true);
    expect(
      await schedulesPage.scheduleMenuHasItem(
        exhaustedRow,
        'Skip next scheduled date',
      ),
    ).toBe(false);

    const nextDateBefore = await readScheduleNextDate(page, 'Apple monthly');
    await recurringRow.getByTestId('actions').getByRole('button').click();
    await page
      .getByRole('menu')
      .getByRole('button', { name: 'Skip next scheduled date' })
      .click();

    // "Later", never a fixed date: a monthly rule started on the 31st lands on
    // a different day depending on when the suite runs.
    await expect
      .poll(() => readScheduleNextDate(page, 'Apple monthly'))
      .toBeGreaterThan(nextDateBefore);

    // The edit path too, while the collector is still installed: opening a
    // nameless schedule for editing is the half that seeds `fields.name` from
    // a null, which is what the modal's guarded name input exists for.
    const exhaustedEditModal = await schedulesPage.editSchedule(exhaustedRow);
    await expect(exhaustedEditModal.scheduleNameInput).toHaveValue('');
    await exhaustedEditModal.cancel();

    // Console events arrive out of band over CDP, so nothing above waits for
    // the channel itself. The drain is unconditional — the channel, not the DOM,
    // is what carries these events.
    await page.waitForTimeout(CONSOLE_SETTLE_MS);

    // Assert the console before anything that could fail after it: this is the
    // regression the modal's guarded name input exists to prevent, and a later
    // failure would otherwise mask it.
    expect(messages).toEqual([]);
  });

  test('double clicking a schedule row opens a single edit modal', async () => {
    const scheduleEditModal = await schedulesPage.addNewSchedule();
    await scheduleEditModal.fill({
      payee: 'Home Depot',
      account: 'HSBC',
      amount: 25,
    });
    await scheduleEditModal.add();

    // The row body, not the actions cell: the actions button opens the menu
    // and does not reach the row's own onClick.
    const row = schedulesPage.schedulesTableRow.filter({
      hasText: 'Home Depot',
    });
    await expect(row).toHaveCount(1);
    await row.dblclick();

    // Two clicks on one row must not stack two copies of the form, or a single
    // Cancel leaves the other on screen.
    const modals = page.getByTestId('schedule-edit-modal');
    await expect(modals).toHaveCount(1);
    await expect(
      modals.getByRole('textbox', { name: 'Schedule name' }),
    ).toHaveCount(1);

    await page
      .getByTestId('schedule-edit-modal')
      .getByRole('button', { name: 'Cancel' })
      .click();
    await expect(page.getByTestId('schedule-edit-modal')).toHaveCount(0);
    await expect(schedulesPage.addNewScheduleButton).toBeVisible();
  });
});
