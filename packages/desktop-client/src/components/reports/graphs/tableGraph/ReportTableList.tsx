import React from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { DataEntity, GroupedEntity } from '@actual-app/core/types/models';

import { Row } from '#components/table';

import { RenderTableRow } from './RenderTableRow';
import type { renderRowProps } from './ReportTable';

type ReportTableListProps = {
  data: DataEntity;
  mode: string;
  groupBy: string;
  renderRow: (arg: renderRowProps) => ReactNode;
  style?: CSSProperties;
};

export function ReportTableList({
  data,
  mode,
  groupBy,
  renderRow,
  style,
}: ReportTableListProps) {
  const metadata: GroupedEntity[] | undefined =
    groupBy === 'Category'
      ? data.groupedData || []
      : groupBy === 'Interval'
        ? data.intervalData.map(interval => {
            return {
              id: '',
              name: '',
              date: interval.date,
              totalAssets: interval.totalAssets,
              totalDebts: interval.totalDebts,
              netAssets: interval.netAssets,
              netDebts: interval.netDebts,
              totalTotals: interval.totalTotals,
              totalBudgeted: interval.totalBudgeted,
              intervalData: [],
              categories: [],
            };
          })
        : data.data;

  return (
    <View>
      {metadata ? (
        <View>
          {metadata.map((item, index) => {
            return (
              <View key={index}>
                <RenderTableRow
                  index={index}
                  renderRow={renderRow}
                  mode={mode}
                  metadata={metadata}
                  style={{
                    ...(item.categories && {
                      color: theme.tableRowHeaderText,
                      backgroundColor: theme.tableRowHeaderBackground,
                      fontWeight: 600,
                    }),
                    ...style,
                  }}
                />
                {item.categories && (
                  <>
                    <View>
                      {item.categories.map(
                        (category: GroupedEntity, i: number) => {
                          return (
                            <RenderTableRow
                              // Uncategorized, Transfers and Off budget all
                              // carry `id: ''` on purpose — the query layer and
                              // the filters match on that empty id — so `id`
                              // collides for all three. `uncategorizedId` is
                              // the field that tells them apart. Real
                              // categories have no uncategorizedId and keep
                              // being keyed by their uuid.
                              key={category.uncategorizedId ?? category.id}
                              index={i}
                              renderRow={renderRow}
                              mode={mode}
                              metadata={metadata}
                              parent_index={index}
                              style={style}
                            />
                          );
                        },
                      )}
                    </View>
                    <Row height={20} />
                  </>
                )}
              </View>
            );
          })}
        </View>
      ) : (
        <View width="flex" />
      )}
    </View>
  );
}
