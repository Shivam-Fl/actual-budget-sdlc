import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { ConfigurationPage } from './page-models/configuration-page';
import type { CustomReportPage } from './page-models/custom-report-page';
import { Navigation } from './page-models/navigation';
import type { ReportsPage } from './page-models/reports-page';

test.describe('Reports', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let navigation: Navigation;
  let reportsPage: ReportsPage;
  let configurationPage: ConfigurationPage;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    navigation = new Navigation(page);
    configurationPage = new ConfigurationPage(page);

    await page.goto('/');
    await configurationPage.createTestFile();

    reportsPage = await navigation.goToReportsPage();
    await reportsPage.waitToLoad();
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('loads net worth and cash flow reports', async () => {
    const reports = await reportsPage.getAvailableReportList();

    expect(reports).toEqual([
      'Total Income (YTD)',
      'Total Expenses (YTD)',
      'Avg Per Month',
      'Avg Per Transaction',
      'Net Worth',
      'Cash Flow',
      'This Month',
      'Budget Overview',
      '3-Month Average',
    ]);
    await expect(page).toMatchThemeScreenshots();
  });

  test('right clicking a report card opens context menu', async () => {
    await reportsPage.rightClickReportCard('Net Worth');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Rename' })).toBeVisible();
  });

  test('loads net worth graph and checks visuals', async () => {
    await reportsPage.goToNetWorthPage();
    await expect(page).toMatchThemeScreenshots();
  });

  test('loads cash flow graph and checks visuals', async () => {
    await reportsPage.goToCashFlowPage();
    await expect(page).toMatchThemeScreenshots();
  });

  test('opens the date range picker and checks visuals', async () => {
    await reportsPage.goToNetWorthPage();

    await page.getByTestId('date-range-picker-trigger').click();
    const picker = page.locator('[data-popover]');
    await expect(picker).toMatchThemeScreenshots();

    // Switch to day granularity
    await picker.getByRole('button', { name: 'Day', exact: true }).click();
    await expect(picker).toMatchThemeScreenshots();
  });

  test.describe('balance forecast', () => {
    test.beforeEach(async () => {
      const settingsPage = await navigation.goToSettingsPage();
      await settingsPage.enableExperimentalFeature('Balance Forecast Report');

      reportsPage = await navigation.goToReportsPage();
      await reportsPage.waitToLoad();
      await reportsPage.addWidget('Balance forecast');
      await reportsPage.goToBalanceForecastPage();
    });

    test('loads balance forecast report with monthly granularity', async () => {
      await expect(page).toMatchThemeScreenshots();
    });

    test('switches to daily granularity', async () => {
      await reportsPage.selectForecastGranularity('Daily');

      await expect(page).toMatchThemeScreenshots();
    });

    test('loads tracking budget forecast report', async () => {
      const settingsPage = await navigation.goToSettingsPage();
      await settingsPage.useBudgetType('Tracking');

      const budgetPage = await navigation.goToBudgetPage();
      await budgetPage.goToNextMonth();
      await budgetPage.setBudgetedAmount('Food', '1200', 0);
      await budgetPage.goToNextMonth();
      await budgetPage.setBudgetedAmount('Food', '1200', 0);
      await budgetPage.goToNextMonth();
      await budgetPage.setBudgetedAmount('Food', '1200', 0);

      reportsPage = await navigation.goToReportsPage();
      await reportsPage.waitToLoad();
      await reportsPage.goToBalanceForecastPage();
      await reportsPage.selectForecastSource('Tracking budget');

      await expect(page).toMatchThemeScreenshots();
    });
  });

  test.describe('custom reports', () => {
    let customReportPage: CustomReportPage;

    test.beforeEach(async () => {
      customReportPage = await reportsPage.goToCustomReportPage();
      await page.addStyleTag({
        content: '[role="tooltip"] { display: none !important; }',
      });
    });

    test('Switches to Data Table and checks the visuals', async () => {
      await customReportPage.selectMode('time');
      await customReportPage.selectViz('Data Table');
      await expect(page).toMatchThemeScreenshots();
    });

    test('Switches to Bar Graph and checks the visuals', async () => {
      await customReportPage.selectMode('time');
      await customReportPage.selectViz('Bar Graph');
      await expect(page).toMatchThemeScreenshots();
    });

    test('Switches to Line Graph and checks the visuals', async () => {
      await customReportPage.selectMode('time');
      await customReportPage.selectViz('Line Graph');
      await expect(page).toMatchThemeScreenshots();
    });

    test('Switches to Area Graph and checks the visuals', async () => {
      await customReportPage.selectMode('total');
      await customReportPage.selectViz('Area Graph');
      await expect(page).toMatchThemeScreenshots();
    });

    test('Switches to Donut Graph and checks the visuals', async () => {
      await customReportPage.selectMode('total');
      await customReportPage.selectViz('Donut Graph');
      await expect(page).toMatchThemeScreenshots();
    });

    test('Validates that "show legend" button shows the legend side-bar', async () => {
      await customReportPage.selectViz('Bar Graph');
      await customReportPage.showLegendButton.click();
      await expect(page).toMatchThemeScreenshots();

      await customReportPage.showLegendButton.click();
    });

    ['Bar Graph', 'Line Graph'].forEach(graph => {
      test(`${graph} keeps its height when the legend needs scrolling`, async () => {
        await page.setViewportSize({ width: 1280, height: 700 });
        await customReportPage.selectMode('time');
        await customReportPage.selectViz(graph);
        await page
          .getByRole('button', { name: 'Options', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Show empty rows', exact: true })
          .click();
        await page.keyboard.press('Escape');

        const content = page.locator('#custom-report-content');
        const chart = content.locator('.recharts-wrapper');
        await expect(chart).toBeVisible();
        const originalHeight = await chart.evaluate(el => el.clientHeight);

        await customReportPage.showSummaryButton.click();
        await customReportPage.showLegendButton.click();

        await expect
          .poll(() => chart.evaluate(el => el.clientHeight))
          .toBe(originalHeight);
        const legend = content
          .getByText('Category', { exact: true })
          .locator('..');
        await expect
          .poll(() => legend.evaluate(el => el.scrollHeight > el.clientHeight))
          .toBe(true);
        await legend.hover();
        await page.mouse.wheel(0, 500);
        await expect
          .poll(() => legend.evaluate(el => el.scrollTop))
          .toBeGreaterThan(0);
        await expect
          .poll(() => chart.evaluate(el => el.clientHeight))
          .toBe(originalHeight);
      });
    });

    test('Rows follow the category selection when "show empty rows" is on', async () => {
      await customReportPage.selectMode('total');
      await customReportPage.selectViz('Data Table');

      const rows = page.locator('#list');

      // `Unselect All` then the Bills group checkbox leaves exactly the five
      // Bills categories selected. Clicking by checkbox id rather than by label
      // text: two elements are labelled "Income".
      await page.getByRole('button', { name: 'Unselect All' }).click();
      await page
        .locator(
          `input#${await page.getByText('Bills', { exact: true }).first().getAttribute('for')}`,
        )
        .check();

      await expect(
        page.getByRole('button', {
          name: 'category one of [Cell, Internet, Mortgage, 2 more items...]',
        }),
      ).toBeVisible();

      // Control: with "show empty rows" off, only the selected categories
      // render. The fix must not change this default.
      await expect(rows).toContainText('Cell');
      await expect(rows).not.toContainText('Food');
      await expect(rows).not.toContainText('Income');

      await page.getByRole('button', { name: 'Options', exact: true }).click();
      await page
        .getByRole('button', { name: 'Show empty rows', exact: true })
        .click();
      await page.keyboard.press('Escape');

      // "Show empty rows" must not resurrect the unselected categories as 0.00
      // rows. These all rendered before the category selection reached the row
      // axis.
      await expect(rows).toContainText('Cell');
      for (const unselected of [
        'Usual Expenses',
        'Food',
        'Restaurants',
        'Entertainment',
        'Clothing',
        'General',
        'Gift',
        'Medical',
        'Savings',
        'Income',
        'Starting Balances',
        'Misc',
      ]) {
        await expect(rows).not.toContainText(unselected);
      }

      // The synthetic block has no sidebar checkbox and is appended after the
      // narrowing, so it must still render.
      await expect(rows).toContainText('Uncategorized & Off budget');
      await expect(rows).toContainText('Uncategorized');
    });

    test.describe("'any of' keeps every row the query fetched", () => {
      // With 'any of', the query side unions every disjunct but the row axis
      // was narrowed as though the category condition were the only one. Rows
      // the query fetched were then deleted from the axis, taking their
      // amounts out of every total with nothing on screen to show for it.
      //
      // The demo budget's amounts are generated per run, so nothing here pins
      // a figure. What is stable is the set relation the fix guarantees, plus
      // 'Food' - a hard-coded demo category, and the guard that the notes
      // disjunct really does pull in spending outside the Bills selection.
      let notesOnlyRows: string[];
      let billsOnlyRows: string[];

      const applyNotesFilter = async () => {
        await customReportPage.openConditionsMenu();
        await page
          .getByTestId('filters-select-tooltip')
          .getByRole('button', { name: 'Notes' })
          .click();

        const editor = page.getByTestId('filters-menu-tooltip');
        await editor
          .getByRole('button', { name: 'contains', exact: true })
          .click();
        await page.keyboard.type('e');
        await editor.getByRole('button', { name: 'Apply' }).click();

        await expect(
          customReportPage.pageContent.getByRole('button', {
            name: 'notes contains e',
          }),
        ).toBeVisible();
      };

      const selectOnlyBillsGroup = async () => {
        await page.getByRole('button', { name: 'Unselect All' }).click();

        // Clicking by checkbox id rather than by label text: two elements are
        // labelled "Income".
        await page
          .locator(
            `input#${await page
              .getByText('Bills', { exact: true })
              .first()
              .getAttribute('for')}`,
          )
          .check();

        await expect(
          customReportPage.pageContent.getByRole('button', {
            name: /category one of \[Cell, Internet/,
          }),
        ).toBeVisible();
      };

      /** Wait until the table has re-rendered carrying all of these rows. */
      const waitForRows = async (...names: string[]) => {
        await expect
          .poll(async () => {
            const rows = await customReportPage.rowNames();
            return names.every(name => rows.includes(name));
          })
          .toBe(true);
      };

      /** Flip the operator toggle from 'all of' to 'any of'. */
      const switchToAnyOf = async () => {
        // The toggle only renders once two or more conditions exist, and its
        // options live in a menu that opens on click.
        const toggle = customReportPage.pageContent.getByTestId('field-select');
        await expect(toggle).toContainText('all');
        await toggle.click();

        await page.getByRole('button', { name: 'any', exact: true }).click();
      };

      test.beforeEach(async () => {
        await customReportPage.selectMode('total');
        await customReportPage.selectViz('Data Table');
        await customReportPage.showSummaryButton.click();

        await applyNotesFilter();
        await waitForRows('Food', 'Cell');
        notesOnlyRows = await customReportPage.rowNames();

        // Guard: without a row outside Bills in the notes-only run, the
        // 'any of' case below has nothing to discriminate and would pass
        // whatever the axis did.
        expect(notesOnlyRows).toContain('Food');
        expect(notesOnlyRows).toContain('Cell');

        await selectOnlyBillsGroup();
        await waitForRows('Cell');
        billsOnlyRows = await customReportPage.rowNames();
      });

      test('renders the union of both branches, by row set and by name', async () => {
        await switchToAnyOf();

        // 'Food' is outside the Bills selection and the notes disjunct
        // populates it, so it must survive the switch; 'Cell' is the Bills
        // branch. Both present means the axis is the union of the two.
        await waitForRows('Food', 'Cell');
        const anyOfRows = await customReportPage.rowNames();

        // The relation the fix guarantees: 'any of' matches a superset of each
        // branch, so its rows must contain both branches' rows.
        expect(notesOnlyRows.every(row => anyOfRows.includes(row))).toBe(true);
        expect(billsOnlyRows.every(row => anyOfRows.includes(row))).toBe(true);

        // 'Food' is outside the Bills selection and the notes disjunct
        // populates it, so it must survive the switch.
        expect(anyOfRows).toContain('Food');
      });

      test("'any of' does not report the 'all of' total", async () => {
        // Settle first: reading the summary mid-re-render can return nothing.
        await expect
          .poll(() => customReportPage.totalSpending())
          .not.toBeNull();
        const allOfTotal = await customReportPage.totalSpending();

        await switchToAnyOf();

        // Settle on a real reading first: mid-re-render the summary can be
        // absent, and "absent" would satisfy a bare inequality.
        await expect
          .poll(() => customReportPage.totalSpending())
          .not.toBeNull();

        // Equality, not magnitude: 'any of' must not collapse onto 'all of'.
        // The demo budget's amounts differ per run, so the comparison is
        // between two readings taken inside this one run.
        expect(await customReportPage.totalSpending()).not.toBe(allOfTotal);
      });

      test("Split=Group keeps the notes-populated group under 'any of'", async () => {
        // The Split control is a Select: clicking its trigger opens the menu,
        // and the option lives in the menu's portal rather than in the
        // sidebar the trigger sits in.
        await customReportPage.pageContent
          .getByRole('button', { name: 'Category', exact: true })
          .click();
        await page.getByRole('button', { name: 'Group', exact: true }).click();

        await switchToAnyOf();

        // The Group split's axis comes from the same grouped half as the
        // table view, so the notes-populated group must be there too.
        await waitForRows('Usual Expenses', 'Bills');
      });

      test("'all of' with a category selection still hides the unchecked rows", async () => {
        // Negative control: the assertions above must not be satisfiable by
        // narrowing having been switched off entirely.
        await page
          .getByRole('button', { name: 'Options', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Show empty rows', exact: true })
          .click();
        await page.keyboard.press('Escape');

        await expect(customReportPage.rows).toContainText('Cell');
        for (const unselected of ['Food', 'Restaurants', 'Entertainment']) {
          await expect(customReportPage.rows).not.toContainText(unselected);
        }
      });
    });

    test('Validates that "show summary" button shows the summary', async () => {
      await customReportPage.selectViz('Bar Graph');
      await customReportPage.showSummaryButton.click();
      await expect(page).toMatchThemeScreenshots();

      await customReportPage.showSummaryButton.click();
    });

    test('Validates that "show labels" button shows the labels', async () => {
      await customReportPage.selectViz('Bar Graph');
      await customReportPage.showLabelsButton.click();
      await expect(page).toMatchThemeScreenshots();

      await customReportPage.showLabelsButton.click();
    });
  });
});

test.describe('Reports without transactions', () => {
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('creates a custom report in an empty budget', async () => {
    const pageErrors: Error[] = [];
    page.on('pageerror', error => pageErrors.push(error));

    const configurationPage = new ConfigurationPage(page);
    const navigation = new Navigation(page);

    await page.goto('/');
    await configurationPage.startFresh();

    const reportsPage = await navigation.goToReportsPage();
    await reportsPage.waitToLoad();
    const customReportPage = await reportsPage.goToCustomReportPage();

    await expect(page).toHaveURL(/\/reports\/custom/);
    await expect(
      customReportPage.pageContent.getByRole('button', {
        name: 'Total',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      customReportPage.pageContent.getByRole('button', {
        name: 'Time',
        exact: true,
      }),
    ).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
