import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { ConfigurationPage } from './page-models/configuration-page';

/**
 * Console output Radix emits when `Dialog.Content` has no title/description
 * backing its `aria-labelledby` / `aria-describedby`. Both alternatives are
 * transcribed from `@radix-ui/react-dialog@1.1.15` — the version is pinned but
 * the line numbers into its published dist are not, since they rot on any patch
 * release — and each `.` below stands for a backtick, so unrelated app output
 * that merely mentions an attribute name does not fail the test:
 *
 *   `DialogContent` requires a `DialogTitle` for the component to be accessible
 *   for screen reader users. […]
 *
 *   Warning: Missing `Description` or `aria-describedby={undefined}` for
 *   {DialogContent}.
 */
const dialogAccessibilityWarning =
  /DialogContent. requires a .DialogTitle|Missing .Description. or .aria-describedby/;

/** How long to let the console channel drain when no dialog warning arrives. */
const CONSOLE_SETTLE_MS = 1000;

type DialogWarningProbe = { channel: 'error' | 'warn'; message: string };

/**
 * The verbatim strings `dialogAccessibilityWarning` matches its alternatives
 * against — one per alternative, transcribed from `@radix-ui/react-dialog@1.1.15`.
 * The title message is the first line of Radix's three-paragraph title warning;
 * the rest of that warning is developer-facing prose the filter never reaches.
 * `channel` records the console method Radix emits each on — the title warning
 * goes to `console.error`, the description warning to `console.warn` — because
 * `watchDialogWarnings` only collects console types `error` and `warning`, and
 * driving both through one method would leave the other's channel untested.
 *
 * These are held as literals rather than read out of the installed package, so
 * they can rot if a patch release rewords either message. They are emitted from
 * the page by the probe below so every run re-proves that both channels deliver
 * and the filter still matches the transcribed wording.
 */
const DIALOG_WARNING_PROBES: DialogWarningProbe[] = [
  {
    channel: 'error',
    message:
      '`DialogContent` requires a `DialogTitle` for the component to be accessible for screen reader users.',
  },
  {
    channel: 'warn',
    message:
      'Warning: Missing `Description` or `aria-describedby={undefined}` for {DialogContent}.',
  },
];

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

/**
 * Collect dialog accessibility warnings off the page's console channel. Console
 * events are delivered over CDP out of band, so awaiting anything that
 * synchronises on the DOM does not wait for them — the caller has to give the
 * channel its own time.
 */
function watchDialogWarnings(page: Page): { messages: string[] } {
  const messages: string[] = [];
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = message.text();
    if (!dialogAccessibilityWarning.test(text)) return;
    messages.push(text);
  });
  return { messages };
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
    const { messages } = watchDialogWarnings(page);

    await page.keyboard.press('ControlOrMeta+k');
    await expect(
      page.getByRole('combobox', { name: 'Command Bar' }),
    ).toBeVisible();

    // Console events arrive out of band over CDP, so nothing above waits for
    // the channel itself. The drain is unconditional — the channel, not the DOM,
    // is what carries these events, and a warning that lands during the palette
    // open is as much a regression as one that lands before the read.
    await page.waitForTimeout(CONSOLE_SETTLE_MS);

    // Assert the console first: it is the regression this test exists for, and
    // the failure below would otherwise mask it. The drain above makes this
    // position correct rather than merely lucky.
    expect(messages).toEqual([]);

    // Every alternative in the filter needs its own probe, or the arm nobody
    // probes is a blind spot: an edit that breaks it leaves this test green
    // while the doc comment above claims otherwise. The naive split is correct
    // for this flat alternation and would need revisiting if the pattern ever
    // gained a group or an escaped `|`.
    for (const alternative of dialogAccessibilityWarning.source.split('|')) {
      expect(
        DIALOG_WARNING_PROBES.some(({ message }) =>
          new RegExp(alternative).test(message),
        ),
        `no DIALOG_WARNING_PROBES entry matches the dialogAccessibilityWarning alternative /${alternative}/`,
      ).toBe(true);
    }

    // The probe has to stay after the assertion above: it matches the same
    // pattern, so emitted first it would poison the buffer it is meant to be
    // independent of. It proves both console channels deliver into a collector
    // inside the timeout and that the filter still matches the transcribed Radix
    // wording — so a channel that stops delivering, or an edit that breaks the
    // match, turns this test red on every run. Both sides are sorted because CDP
    // does not guarantee the order of two console events, and equality rather
    // than `includes` so the collector is proven to hold each message once. It
    // does NOT prove Radix's current build emits these exact strings.
    const probe = watchDialogWarnings(page);
    await page.evaluate(probes => {
      for (const { channel, message } of probes) {
        if (channel === 'error') {
          console.error(message);
        } else {
          console.warn(message);
        }
      }
    }, DIALOG_WARNING_PROBES);
    await expect
      .poll(() => [...probe.messages].sort(), { timeout: CONSOLE_SETTLE_MS })
      .toEqual(DIALOG_WARNING_PROBES.map(({ message }) => message).sort());

    // The dialog keeps its accessible name, but assert the ids resolve to real
    // elements too: Playwright falls back to `aria-label` when
    // `aria-labelledby` dangles, so the role query alone would pass either way.
    const dialog = page.getByRole('dialog', { name: 'Command Bar' });
    await expect(dialog).toBeAttached();
    expect(await referredText(dialog, 'aria-labelledby')).toBe('Command Bar');
    expect(await referredText(dialog, 'aria-describedby')).toBe(
      'Search pages, accounts and reports',
    );

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
