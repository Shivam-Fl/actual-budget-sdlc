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
  const [categoryList, categoryGroup] = categoryLists(categories);

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

    // Same rule as the rest of the report — see getEffectiveEndDate in
    // reportRanges.ts. Without it the grouped/table view of the same weekly
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

    // Budget rows are keyed by month and weekly buckets by week start, so no
    // budget row can match a bucket and the widening above is free; this remap
    // stays budgeted-only because it would misattribute one.
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
          effectiveEndDate,
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
              effectiveEndDate,
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
