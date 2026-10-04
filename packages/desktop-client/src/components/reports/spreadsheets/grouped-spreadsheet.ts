import { send } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import type { GroupedEntity } from '@actual-app/core/types/models';

import {
  categoryLists,
  ReportOptions,
} from '#components/reports/ReportOptions';
import type { QueryDataEntity } from '#components/reports/ReportOptions';
import { getEffectiveEndDate } from '#components/reports/reportRanges';
import type { useSpreadsheet } from '#hooks/useSpreadsheet';

import { narrowCategoriesByConditions } from './budgetDataQuery';
import type { createCustomSpreadsheetProps } from './custom-spreadsheet';
import { fetchSpreadsheetQueryData } from './fetchSpreadsheetQueryData';
import { filterEmptyRows } from './filterEmptyRows';
import { recalculate } from './recalculate';
import { sortData } from './sortData';
import {
  determineIntervalRange,
  trimGroupedDataIntervals,
} from './trimIntervals';

export function createGroupedSpreadsheet({
  startDate,
  endDate,
  interval,
  categories,
  budgetType = 'envelope',
  conditions = [],
  conditionsOp,
  showEmpty,
  showOffBudget,
  showHiddenCategories,
  showUncategorized,
  trimIntervals,
  balanceTypeOp,
  sortByOp,
  firstDayOfWeekIdx,
}: createCustomSpreadsheetProps) {
  // Both halves of the axis are narrowed: the table view renders `groupedData`,
  // built below from `categoryGroup`, so narrowing `categoryList` alone would
  // leave unselected categories on screen at 0.00 when `showEmpty` is on.
  const [categoryList, categoryGroup] = categoryLists(
    narrowCategoriesByConditions(
      categories,
      conditions,
      conditionsOp === 'or' ? 'or' : 'and',
    ),
  );

  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: GroupedEntity[]) => void,
  ) => {
    if (categoryList.length === 0) {
      setData([]);
      return;
    }

    const { filters } = await send('make-filters-from-conditions', {
      conditions: conditions.filter(cond => !cond.customName),
    });
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    // Same rule as custom-spreadsheet: a weekly bucket covers its whole week,
    // clamped to today. Without this the grouped/table view of the same weekly
    // report would disagree with its graph view.
    const effectiveEndDate = getEffectiveEndDate(
      endDate,
      interval,
      firstDayOfWeekIdx,
    );

    let assets: QueryDataEntity[];
    let debts: QueryDataEntity[];

    ({ assets, debts } = await fetchSpreadsheetQueryData({
      balanceTypeOp,
      startDate,
      endDate: effectiveEndDate,
      interval,
      categories: categories.list,
      categoryGroups: categories.grouped,
      conditions,
      conditionsOp,
      conditionsOpKey,
      filters,
      budgetType,
    }));

    // This guard remaps rows onto week starts; it is deliberately *not* applied
    // to the widening above, which applies to every balance type. Budget rows
    // arrive keyed by month while weekly bucket labels are week starts, so a
    // budget row can never match a bucket and the remap would only misattribute
    // one. Widening a budgeted weekly report is therefore free: it fetches one
    // more month of rows that are still discarded. Keep the two decisions as
    // they are — the widening is shared, this remap is budgeted-only.
    if (interval === 'Weekly' && balanceTypeOp !== 'totalBudgeted') {
      debts = debts.map(d => {
        return {
          ...d,
          date: monthUtils.weekFromDate(d.date, firstDayOfWeekIdx),
        };
      });
      assets = assets.map(d => {
        return {
          ...d,
          date: monthUtils.weekFromDate(d.date, firstDayOfWeekIdx),
        };
      });
    }

    const intervals =
      interval === 'Weekly'
        ? monthUtils.weekRangeInclusive(startDate, endDate, firstDayOfWeekIdx)
        : monthUtils[
            ReportOptions.intervalRange.get(interval) || 'rangeInclusive'
          ](startDate, endDate);

    const groupedData: GroupedEntity[] = categoryGroup.map(
      group => {
        const grouped = recalculate({
          item: group,
          intervals,
          assets,
          debts,
          groupByLabel: 'categoryGroup',
          showOffBudget,
          showHiddenCategories,
          showUncategorized,
          startDate,
          endDate,
          interval,
          firstDayOfWeekIdx,
        });

        const stackedCategories =
          group.categories &&
          group.categories.map(item => {
            const calc = recalculate({
              item,
              intervals,
              assets,
              debts,
              groupByLabel: 'category',
              showOffBudget,
              showHiddenCategories,
              showUncategorized,
              startDate,
              endDate,
              interval,
              firstDayOfWeekIdx,
            });
            return { ...calc };
          });

        return {
          ...grouped,
          categories:
            stackedCategories &&
            stackedCategories.filter(i =>
              filterEmptyRows({ showEmpty, data: i, balanceTypeOp }),
            ),
        };
      },
      [startDate, endDate],
    );

    const groupedDataFiltered = groupedData.filter(i =>
      filterEmptyRows({ showEmpty, data: i, balanceTypeOp }),
    );

    // Determine interval range across all groups and their nested categories
    const allGroupsForTrimming: GroupedEntity[] = [];
    groupedDataFiltered.forEach(group => {
      allGroupsForTrimming.push(group);
      if (group.categories) {
        allGroupsForTrimming.push(...group.categories);
      }
    });

    const { startIndex, endIndex } = determineIntervalRange(
      allGroupsForTrimming,
      groupedDataFiltered.length > 0 ? groupedDataFiltered[0].intervalData : [],
      trimIntervals,
      balanceTypeOp,
    );

    // Trim all groupedData intervals (including nested categories) based on the range
    trimGroupedDataIntervals(groupedDataFiltered, startIndex, endIndex);

    const sortedGroupedDataFiltered = [...groupedDataFiltered]
      .sort(sortData({ balanceTypeOp, sortByOp }))
      .map(g => {
        g.categories = [...(g.categories ?? [])].sort(
          sortData({ balanceTypeOp, sortByOp }),
        );
        return g;
      });

    setData(sortedGroupedDataFiltered);
  };
}
