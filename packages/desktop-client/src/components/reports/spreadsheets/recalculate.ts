import * as monthUtils from '@actual-app/core/shared/months';
import type {
  GroupedEntity,
  IntervalEntity,
} from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';

import type {
  QueryDataEntity,
  UncategorizedEntity,
} from '#components/reports/ReportOptions';

import { filterHiddenItems } from './filterHiddenItems';

type recalculateProps = {
  item: UncategorizedEntity;
  intervals: Array<string>;
  assets: QueryDataEntity[];
  debts: QueryDataEntity[];
  groupByLabel: 'category' | 'categoryGroup' | 'payee' | 'account';
  showOffBudget?: boolean;
  showHiddenCategories?: boolean;
  showUncategorized?: boolean;
  startDate: string;
  endDate: string;
  interval: string;
  firstDayOfWeekIdx?: SyncedPrefs['firstDayOfWeekIdx'];
};

export function recalculate({
  item,
  intervals,
  assets,
  debts,
  groupByLabel,
  showOffBudget,
  showHiddenCategories,
  showUncategorized,
  startDate,
  endDate,
  interval,
  firstDayOfWeekIdx,
}: recalculateProps): GroupedEntity {
  let totalAssets = 0;
  let totalDebts = 0;
  const intervalData = intervals.reduce(
    (arr: IntervalEntity[], intervalItem, index) => {
      const last = arr.length === 0 ? null : arr[arr.length - 1];

      const groupsByCategory =
        groupByLabel === 'category' || groupByLabel === 'categoryGroup';
      const intervalAssets = filterHiddenItems(
        item,
        assets,
        showOffBudget,
        showHiddenCategories,
        showUncategorized,
        groupsByCategory,
      )
        .filter(
          asset =>
            asset.date === intervalItem &&
            (asset[groupByLabel] === (item.id ?? null) ||
              (item.uncategorized_id && groupsByCategory)),
        )
        .reduce((a, v) => a + v.amount, 0);
      totalAssets += intervalAssets;

      const intervalDebts = filterHiddenItems(
        item,
        debts,
        showOffBudget,
        showHiddenCategories,
        showUncategorized,
        groupsByCategory,
      )
        .filter(
          debt =>
            debt.date === intervalItem &&
            (debt[groupByLabel] === (item.id ?? null) ||
              (item.uncategorized_id && groupsByCategory)),
        )
        .reduce((a, v) => a + v.amount, 0);
      totalDebts += intervalDebts;

      const intervalTotals = intervalAssets + intervalDebts;

      const change = last ? intervalTotals - last.totalTotals : 0;

      // The last weekly bucket covers its whole week, not just the week-start
      // the From/To pickers can offer, and never projects past today. Same rule
      // as the query bound in the spreadsheet factories, so the bucket and the
      // data behind it agree.
      let intervalEndDate: string;
      if (index + 1 === intervals.length) {
        if (interval === 'Weekly') {
          const weekEnd = monthUtils.getWeekEnd(
            intervalItem,
            firstDayOfWeekIdx,
          );
          const today = monthUtils.currentDay();
          intervalEndDate = today < weekEnd ? today : weekEnd;
        } else {
          intervalEndDate = endDate;
        }
      } else {
        intervalEndDate = monthUtils.subDays(intervals[index + 1], 1);
      }

      arr.push({
        date: intervalItem,
        totalAssets: intervalAssets,
        totalDebts: intervalDebts,
        netAssets: intervalTotals > 0 ? intervalTotals : 0,
        netDebts: intervalTotals < 0 ? intervalTotals : 0,
        totalTotals: intervalTotals,
        totalBudgeted: intervalTotals,
        change,
        intervalStartDate: index === 0 ? startDate : intervalItem,
        intervalEndDate,
      });

      return arr;
    },
    [],
  );

  const totalTotals = totalAssets + totalDebts;

  return {
    id: item.id || '',
    name: item.name,
    uncategorizedId: item.uncategorized_id,
    totalAssets,
    totalDebts,
    netAssets: totalTotals > 0 ? totalTotals : 0,
    netDebts: totalTotals < 0 ? totalTotals : 0,
    totalTotals,
    totalBudgeted: totalTotals,
    intervalData,
  };
}
