import React from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgFilter } from '@actual-app/components/icons/v1';

export function CompactFiltersButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();

  return (
    <Button
      variant="bare"
      onPress={onPress}
      aria-label={t('Filters')}
      style={{ minWidth: 20 }}
    >
      <SvgFilter
        width={15}
        height={15}
        style={{ width: 15, height: 15, flexShrink: 0 }}
      />
    </Button>
  );
}
