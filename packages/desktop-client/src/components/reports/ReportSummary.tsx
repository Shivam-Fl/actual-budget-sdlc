import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import * as monthUtils from '@actual-app/core/shared/months';
import type {
  balanceTypeOpType,
  DataEntity,
} from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';
import { useLocale } from '#hooks/useLocale';

import { getIntervalFormat, ReportOptions } from './ReportOptions';
import { getEffectiveEndDate } from './reportRanges';

type ReportSummaryProps = {
  startDate: string;
  endDate: string;
  data: DataEntity;
  balanceTypeOp: balanceTypeOpType;
  interval: string;
  intervalsCount: number;
  firstDayOfWeekIdx?: SyncedPrefs['firstDayOfWeekIdx'];
};

export function ReportSummary({
  startDate,
  endDate,
  data,
  balanceTypeOp,
  interval,
  intervalsCount,
  firstDayOfWeekIdx,
}: ReportSummaryProps) {
  const locale = useLocale();
  const { t } = useTranslation();
  const format = useFormat();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const intervalFormat = getIntervalFormat(interval, dateFormat);

  // Deliberate: the header names the range the report actually covers, not the
  // raw end date the pickers were set to. A weekly report's final bucket covers
  // its whole week, and the spreadsheet factories already widen the query to
  // match, so formatting `endDate` here would label the data with a range it
  // does not fill. Same helper, so the two cannot drift apart again.
  const effectiveEndDate = getEffectiveEndDate(
    endDate,
    interval,
    firstDayOfWeekIdx,
  );

  const net =
    balanceTypeOp === 'netAssets'
      ? t('DEPOSIT')
      : balanceTypeOp === 'netDebts'
        ? t('PAYMENT')
        : Math.abs(data.totalDebts) > Math.abs(data.totalAssets)
          ? t('PAYMENT')
          : t('DEPOSIT');
  const average = Math.round(data[balanceTypeOp] / intervalsCount);
  return (
    <View
      style={{
        flexDirection: 'column',
        marginBottom: 10,
      }}
    >
      <View
        style={{
          backgroundColor: theme.pageBackground,
          padding: 15,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            ...styles.largeText,
            alignItems: 'center',
            marginBottom: 2,
            fontWeight: 600,
          }}
        >
          {monthUtils.format(startDate, intervalFormat, locale)}
          {monthUtils.format(startDate, intervalFormat, locale) !==
            monthUtils.format(effectiveEndDate, intervalFormat, locale) &&
            ` ${t('to')} ` +
              monthUtils.format(effectiveEndDate, intervalFormat, locale)}
        </Text>
      </View>
      <View
        style={{
          backgroundColor: theme.pageBackground,
          padding: 15,
          justifyContent: 'center',
          alignItems: 'center',
          marginTop: 10,
        }}
      >
        <Text
          style={{
            ...styles.mediumText,
            alignItems: 'center',
            marginBottom: 2,
            fontWeight: 400,
          }}
        >
          {balanceTypeOp === 'totalDebts'
            ? t('TOTAL SPENDING')
            : balanceTypeOp === 'totalAssets'
              ? t('TOTAL DEPOSITS')
              : balanceTypeOp === 'totalBudgeted'
                ? t('TOTAL BUDGETED')
                : t('NET {{net}}', { net })}
        </Text>
        <FinancialText
          style={{
            ...styles.veryLargeText,
            alignItems: 'center',
            marginBottom: 2,
            fontWeight: 800,
          }}
        >
          <PrivacyFilter>
            {format(data[balanceTypeOp], 'financial')}
          </PrivacyFilter>
        </FinancialText>
        <Text style={{ fontWeight: 600 }}>
          <Trans>For this time period</Trans>
        </Text>
      </View>
      <View
        style={{
          backgroundColor: theme.pageBackground,
          padding: 15,
          justifyContent: 'center',
          alignItems: 'center',
          marginTop: 10,
        }}
      >
        <Text
          style={{
            ...styles.mediumText,
            alignItems: 'center',
            marginBottom: 2,
            fontWeight: 400,
          }}
        >
          {balanceTypeOp === 'totalDebts'
            ? t('AVERAGE SPENDING')
            : balanceTypeOp === 'totalAssets'
              ? t('AVERAGE DEPOSIT')
              : balanceTypeOp === 'totalBudgeted'
                ? t('AVERAGE BUDGETED')
                : t('AVERAGE NET')}
        </Text>
        <FinancialText
          style={{
            ...styles.veryLargeText,
            alignItems: 'center',
            marginBottom: 2,
            fontWeight: 800,
          }}
        >
          <PrivacyFilter>
            {!isNaN(average) && format(average, 'financial')}
          </PrivacyFilter>
        </FinancialText>
        <Text style={{ fontWeight: 600 }}>
          <Trans>
            Per{' '}
            {{
              interval: (
                ReportOptions.intervalMap.get(interval) || ''
              ).toLowerCase(),
            }}
          </Trans>
        </Text>
      </View>
    </View>
  );
}
