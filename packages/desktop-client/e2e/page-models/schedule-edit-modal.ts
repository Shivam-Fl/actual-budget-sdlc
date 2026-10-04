import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

type ScheduleEntry = {
  scheduleName?: string;
  payee?: string;
  account?: string;
  amount?: number;
};

export class ScheduleEditModal {
  readonly page: Page;
  readonly locator: Locator;
  readonly heading: Locator;
  readonly scheduleNameInput: Locator;
  readonly payeeInput: Locator;
  readonly accountInput: Locator;
  readonly amountInput: Locator;
  readonly repeatsCheckbox: Locator;
  readonly recurrenceDescriptionButton: Locator;
  readonly addButton: Locator;
  readonly saveButton: Locator;
  readonly cancelButton: Locator;

  constructor(locator: Locator) {
    this.locator = locator;
    this.page = locator.page();

    this.heading = locator.getByRole('heading');
    this.scheduleNameInput = locator.getByRole('textbox', {
      name: 'Schedule name',
    });
    this.payeeInput = locator.getByRole('textbox', { name: 'Payee' });
    this.accountInput = locator.getByRole('textbox', { name: 'Account' });
    this.amountInput = locator.getByLabel('Amount');
    this.repeatsCheckbox = locator.locator('#form_repeats');
    this.recurrenceDescriptionButton = locator.getByTestId(
      'recurrence-description',
    );
    this.addButton = locator.getByRole('button', { name: 'Add' });
    this.saveButton = locator.getByRole('button', { name: 'Save' });
    this.cancelButton = locator.getByRole('button', { name: 'Cancel' });
  }

  async fill(data: ScheduleEntry) {
    // Using pressSequentially on autocomplete fields here to simulate user typing.
    // When using .fill(...), playwright just "pastes" the entire word onto the input
    // and for some reason this breaks the autocomplete highlighting logic
    // e.g. "Create payee" option is not being highlighted.

    if (data.scheduleName) {
      await this.scheduleNameInput.fill(data.scheduleName);
    }

    if (data.payee) {
      await this.#typeAndSelectOption(this.payeeInput, data.payee);
    }

    if (data.account) {
      await this.#typeAndSelectOption(this.accountInput, data.account);
    }

    if (data.amount) {
      await this.amountInput.fill(String(data.amount));
    }
  }

  /**
   * Make the schedule a one-off by clearing Repeats.
   *
   * `useScheduleEdit` replaces the RecurConfig with `monthUtils.currentDay()`
   * as a plain string when Repeats is cleared, `ScheduleEditModal` then derives
   * `repeats` as false from it, and saving writes that string back as an
   * `isapprox date` condition — which is what makes the saved schedule a
   * one-off rather than a recurring one.
   */
  async uncheckRepeats() {
    await this.repeatsCheckbox.uncheck();
  }

  /**
   * The recurring-date trigger's text, read as the app rendered it.
   *
   * Callers assert against this rather than a literal of their own: the text
   * names the recurrence's start day as an ordinal, and the day is a property
   * of the environment the run happens in, not of the code under test.
   */
  async recurrenceDescription() {
    const text = await this.recurrenceDescriptionButton.innerText();

    return text.trim();
  }

  /**
   * End the recurrence after a fixed number of occurrences, leaving the popover
   * open.
   *
   * Apply is the caller's to click, because the trigger only picks up the new
   * end mode once the popover writes the config back. Leaving the seeded 1
   * untouched when no count is given keeps callers off the occurrences input,
   * which the picker seeds as an uncontrolled field.
   */
  async setRecurrenceEndAfterOccurrences(occurrences?: number) {
    await this.recurrenceDescriptionButton.click();
    await this.page.locator('#repeat_end_dropdown').click();
    await this.page
      .getByRole('menu')
      .getByRole('button', { name: 'for', exact: true })
      .click();

    const endOccurrencesInput = this.page.locator('#end_occurrences');

    if (occurrences === undefined) {
      await expect(endOccurrencesInput).toHaveValue('1');
    } else {
      await endOccurrencesInput.fill(String(occurrences));
    }
  }

  async #typeAndSelectOption(input: Locator, content: string) {
    await input.pressSequentially(content);
    // Click the option: Enter on a not-yet-highlighted list saves "None".
    await this.page
      .getByRole('option')
      .filter({ hasText: content })
      .first()
      .click();
  }

  async save() {
    await this.saveButton.click();
  }

  async add() {
    await this.addButton.click();
  }

  async cancel() {
    await this.cancelButton.click();
  }

  async close() {
    await this.heading.getByRole('button', { name: 'Close' }).click();
  }
}
