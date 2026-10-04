import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { ConfigurationPage } from './page-models/configuration-page';
import { Navigation } from './page-models/navigation';
import type { SchedulesPage } from './page-models/schedules-page';

/**
 * A schedule's stored next date as a timestamp, rather than its rendered one:
 * the table formats dates for the current locale, so only the stored value
 * compares as a date. Throws when the schedule has no next date, which would
 * otherwise read as "not later" rather than as a broken fixture.
 */
async function readScheduleNextDate(page: Page, name: string) {
  const nextDate = await page.evaluate(async name => {
    const $send = (
      window as unknown as {
        $send: <T>(type: string, args?: unknown) => Promise<T>;
      }
    ).$send;

    const {
      data: [schedule],
    } = await $send<{ data: [{ next_date: string }] }>('query', {
      table: 'schedules',
      tableOptions: {},
      filterExpressions: [{ name }],
      selectExpressions: ['next_date'],
      groupExpressions: [],
      orderExpressions: [],
      calculation: false,
      rawMode: false,
      withDead: false,
      validateRefs: true,
      limit: null,
      offset: null,
    });

    return schedule?.next_date ?? null;
  }, name);

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
    await page.evaluate(async () => {
      const $send = (
        window as unknown as {
          $send: <T>(type: string, args?: unknown) => Promise<T>;
        }
      ).$send;
      const query = <T>(
        table: string,
        filterExpressions: unknown[],
        selectExpressions: string[],
      ) =>
        $send<{ data: T[] }>('query', {
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

      const {
        data: [destinationAccount],
      } = await query<{ id: string }>(
        'accounts',
        [{ name: 'Ally Savings' }],
        ['id'],
      );
      const {
        data: [destinationPayee],
      } = await query<{ id: string }>(
        'payees',
        [{ transfer_acct: destinationAccount.id }],
        ['id'],
      );
      const {
        data: [schedule],
      } = await query<{ rule: string }>(
        'schedules',
        [{ name: 'Phone bills' }],
        ['rule'],
      );
      const rule = await $send<{
        actions: unknown[];
        conditions: unknown[];
        conditionsOp: 'and' | 'or';
        id: string;
        stage: 'pre' | 'post' | null;
      }>('rule-get', { id: schedule.rule });

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
            value: destinationPayee.id,
            options: { splitIndex: 2 },
          },
        ],
      });
    });

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

    // Located by payee rather than by index, so neither assertion can drift onto
    // the wrong row if the fixture's schedule count changes.
    const oneOffRow = schedulesPage.schedulesTableRow.filter({
      hasText: 'Home Depot',
    });
    const recurringRow = schedulesPage.schedulesTableRow.filter({
      hasText: 'Apple',
    });
    await expect(oneOffRow).toHaveCount(1);
    await expect(recurringRow).toHaveCount(1);

    await oneOffRow.getByTestId('actions').getByRole('button').click();
    await expect(
      page
        .getByRole('menu')
        .getByRole('button', { name: 'Skip next scheduled date' }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The rest of its menu is untouched: a one-off is handled by completing it,
    // not by the item that silently does nothing. Asserted by name rather than
    // by counting the menu, which a due recurring row legitimately fills to five.
    expect(await schedulesPage.nthScheduleMenuItemNames(2)).toEqual([
      'Post transaction',
      'Post transaction today',
      'Complete',
      'Delete',
    ]);

    // The recurring schedule still offers it: index 3 is the second added.
    expect(
      await schedulesPage.nthScheduleMenuHasItem(3, 'Skip next scheduled date'),
    ).toBe(true);

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
  });
});
