import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { ConfigurationPage } from './page-models/configuration-page';

/**
 * Console output Radix emits when `Dialog.Content` has no title/description
 * backing its `aria-labelledby` / `aria-describedby`. Both alternatives are
 * anchored to Radix's own wording, so unrelated app output that merely mentions
 * an attribute name does not fail the test.
 */
const dialogAccessibilityWarning =
  /DialogContent requires a .DialogTitle|Missing .Description. or .aria-describedby/;

/** How long to let the console channel drain when no dialog warning arrives. */
const CONSOLE_SETTLE_MS = 1000;

/** Text of the element a dialog's `aria-labelledby` / `aria-describedby` points at. */
function referredText(
  dialog: Locator,
  attribute: 'aria-labelledby' | 'aria-describedby',
): Promise<string | null> {
  return dialog.evaluate((node, attr) => {
    const id = node.getAttribute(attr);
    return id ? (document.getElementById(id)?.textContent ?? null) : null;
  }, attribute);
}

test.describe('Command bar', () => {
  let page: Page;
  let configurationPage: ConfigurationPage;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    configurationPage = new ConfigurationPage(page);

    await page.goto('/');
    await configurationPage.createTestFile();

    // Move mouse to corner of the screen;
    // sometimes the mouse hovers on a budget element thus rendering an input box
    // and this breaks screenshot tests
    await page.mouse.move(0, 0);

    // ensure page is loaded
    await expect(page.getByTestId('budget-table')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add group' })).toBeVisible({
      timeout: 10000,
    });
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('Opening the command bar logs no dialog accessibility warnings', async () => {
    // Attach the listener after the budget has loaded so we only capture what
    // the palette open itself produces.
    const messages: string[] = [];
    let settleMatch: (() => void) | undefined;
    const firstDialogWarning = new Promise<void>(resolve => {
      settleMatch = resolve;
    });
    page.on('console', message => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      const text = message.text();
      if (!dialogAccessibilityWarning.test(text)) return;
      messages.push(text);
      settleMatch?.();
    });

    await page.keyboard.press('ControlOrMeta+k');
    await expect(
      page.getByRole('combobox', { name: 'Command Bar' }),
    ).toBeVisible();

    // Console events arrive out of band over CDP, so nothing above waits for
    // the channel itself. Wait until the first dialog warning lands, or until
    // the channel has had time to drain, then read the buffer.
    await Promise.race([
      firstDialogWarning,
      page.waitForTimeout(CONSOLE_SETTLE_MS),
    ]);

    // Assert the console first: it is the regression this test exists for, and
    // the failure below would otherwise mask it. The drain above makes this
    // position correct rather than merely lucky.
    expect(messages).toEqual([]);

    // The dialog keeps its accessible name, but assert the ids resolve to real
    // elements too: Playwright falls back to `aria-label` when
    // `aria-labelledby` dangles, so the role query alone would pass either way.
    const dialog = page.getByRole('dialog', { name: 'Command Bar' });
    await expect(dialog).toBeAttached();
    expect(await referredText(dialog, 'aria-labelledby')).toBe('Command Bar');
    const description = await referredText(dialog, 'aria-describedby');
    expect(description).toBeTruthy();
    expect(description).not.toBe('Command Bar');

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeAttached();
  });

  test('Check the command bar visuals', async () => {
    // Open the command bar
    await page.keyboard.press('ControlOrMeta+k');
    const commandBar = page.getByRole('combobox', {
      name: 'Command Bar',
    });

    await expect(commandBar).toBeVisible();
    await expect(page).toMatchThemeScreenshots();

    // Close the command bar
    await page.keyboard.press('Escape');
    await expect(commandBar).not.toBeVisible();
  });

  test('Check the command bar search works correctly', async () => {
    await page.keyboard.press('ControlOrMeta+k');

    const commandBar = page.getByRole('combobox', {
      name: 'Command Bar',
    });

    await expect(commandBar).toBeVisible();
    await expect(commandBar).toHaveValue('');

    // Search and navigate to reports
    await commandBar.fill('reports');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('reports-page')).toBeVisible();
    await expect(page.getByText('Loading reports...')).not.toBeVisible({
      timeout: 10000, // Wait for 10 seconds max for reports to load
    }); // wait for screen to load

    // Navigate to schedule page
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown'); // Select second suggestion - Schedules
    await expect(page).toMatchThemeScreenshots();

    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('button', {
        name: 'Add new schedule',
      }),
    ).toBeVisible();
  });
});
