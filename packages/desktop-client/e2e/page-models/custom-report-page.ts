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
   * Open the conditions picker. The report's filter button is icon-only, so it
   * carries an aria-label rather than a text node - which means it is addressed
   * by its accessible name rather than by its position among the topbar
   * buttons. `exact` keeps it distinct from the accounts page's sibling, which
   * is named 'Filter'.
   */
  async openConditionsMenu() {
    await this.pageContent
      .getByRole('button', { name: 'Filters', exact: true })
      .click();
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
