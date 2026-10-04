import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { ScheduleEditModal } from './schedule-edit-modal';

export class SchedulesPage {
  readonly page: Page;
  readonly addNewScheduleButton: Locator;
  readonly schedulesTableRow: Locator;

  constructor(page: Page) {
    this.page = page;

    this.addNewScheduleButton = this.page.getByRole('button', {
      name: 'Add new schedule',
    });
    this.schedulesTableRow = this.page.getByTestId('table').getByTestId('row');
  }

  /**
   * Open the schedule edit modal.
   */
  async addNewSchedule() {
    await this.addNewScheduleButton.click();

    return new ScheduleEditModal(this.page.getByTestId('schedule-edit-modal'));
  }

  /**
   * Retrieve the row element for the nth-schedule.
   * 0-based index
   */
  getNthScheduleRow(index: number) {
    return this.schedulesTableRow.nth(index);
  }

  /**
   * Retrieve the data for the nth-schedule.
   * 0-based index
   */
  getNthSchedule(index: number) {
    const row = this.getNthScheduleRow(index);

    return {
      payee: row.getByTestId('payee'),
      account: row.getByTestId('account'),
      date: row.getByTestId('date'),
      status: row.getByTestId('status'),
      amount: row.getByTestId('amount'),
    };
  }

  /**
   * Create a transaction for the nth-schedule.
   * 0-based index
   */
  async postNthSchedule(index: number) {
    await this._performNthAction(index, 'Post transaction today');
  }

  /**
   * Complete the nth-schedule.
   * 0-based index
   */
  async completeNthSchedule(index: number) {
    await this._performNthAction(index, 'Complete');
  }

  /**
   * Does this schedule's actions menu offer an item with this name?
   */
  async nthScheduleMenuHasItem(row: number | Locator, name: string | RegExp) {
    const menu = await this._openNthScheduleMenu(row);
    const has = await menu.getByRole('button', { name }).count();

    await this.page.keyboard.press('Escape');

    return has > 0;
  }

  /**
   * The names of every item in this schedule's actions menu.
   */
  async nthScheduleMenuItemNames(row: number | Locator) {
    const menu = await this._openNthScheduleMenu(row);
    const names = await menu.getByRole('button').allTextContents();

    await this.page.keyboard.press('Escape');

    return names;
  }

  async _performNthAction(index: number, actionName: string | RegExp) {
    const menu = await this._openNthScheduleMenu(index);
    await menu.getByRole('button', { name: actionName }).click();
  }

  /**
   * Open a schedule's actions menu and return the menu itself, so callers read
   * items off it rather than off the row.
   *
   * A number selects by 0-based index; a Locator is taken as given, so a caller
   * that already located its row by payee does not have to convert that back
   * into an index. The returned Locator is lazy, and the reads callers make of
   * it (`count`, `allTextContents`) do not retry, so the wait for the menu to
   * render belongs here — every consumer inherits it.
   */
  async _openNthScheduleMenu(row: number | Locator) {
    const scheduleRow =
      typeof row === 'number' ? this.getNthScheduleRow(row) : row;

    await scheduleRow.getByTestId('actions').getByRole('button').click();

    const menu = this.page.getByRole('menu');
    await expect(menu).toBeVisible();

    return menu;
  }

  async rightClickNthSchedule(index: number) {
    await this.getNthScheduleRow(index).click({ button: 'right' });
  }
}
