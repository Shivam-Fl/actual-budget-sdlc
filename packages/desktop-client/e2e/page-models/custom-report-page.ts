import type { Locator, Page } from '@playwright/test';

export class CustomReportPage {
  readonly page: Page;
  readonly pageContent: Locator;
  readonly showLegendButton: Locator;
  readonly showSummaryButton: Locator;
  readonly showLabelsButton: Locator;
  /** The row list the Data Table view renders. */
  readonly rows: Locator;

  constructor(page: Page) {
    this.page = page;
    this.pageContent = page.getByTestId('reports-page');

    this.showLegendButton = this.pageContent.getByRole('button', {
      name: 'Show Legend',
    });
    this.showSummaryButton = this.pageContent.getByRole('button', {
      name: 'Show Summary',
    });
    this.showLabelsButton = this.pageContent.getByRole('button', {
      name: 'Show Labels',
    });

    this.rows = this.page.locator('#list');
  }

  async selectViz(vizName: string | RegExp) {
    await this.pageContent.getByRole('button', { name: vizName }).click();
  }

  async selectMode(mode: 'total' | 'time') {
    switch (mode) {
      case 'total':
        await this.pageContent
          .getByRole('button', { name: 'Total', exact: true })
          .click();
        break;
      case 'time':
        await this.pageContent
          .getByRole('button', { name: 'Time', exact: true })
          .click();
        break;
      default:
        throw new Error(`Unrecognized mode: ${String(mode)}`);
    }
  }

  /**
   * Open the conditions picker. The report's filter button is the icon-only
   * button in the topbar - it carries no accessible name - so it is found by
   * its position among the topbar buttons rather than by role name.
   */
  async openConditionsMenu() {
    const buttons = this.pageContent.getByRole('button');
    const count = await buttons.count();

    for (let index = 0; index < count; index++) {
      const button = buttons.nth(index);
      const hasName =
        (await button.getAttribute('aria-label')) ||
        (await button.innerText()).trim();
      if (hasName) {
        continue;
      }

      const box = await button.boundingBox();
      // Top-right of the topbar, left of the report-name button.
      if (box && box.x > 850) {
        await button.click();
        return;
      }
    }

    throw new Error('Could not find the report conditions button');
  }

  /** The row NAMES the table renders, with the amounts filtered out. */
  async rowNames(): Promise<string[]> {
    return (await this.rows.innerText())
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !/^-?[\d.,]+$/.test(line));
  }

  /**
   * The report summary's TOTAL SPENDING figure, or null when the summary is
   * hidden. Read from the live DOM rather than pinned to a literal: the demo
   * budget is generated, so its amounts differ from run to run.
   */
  async totalSpending(): Promise<string | null> {
    return this.pageContent.evaluate(node => {
      const match = node.textContent?.match(/TOTAL SPENDING\s*(-?[\d.,]+)/);
      return match ? match[1] : null;
    });
  }
}
