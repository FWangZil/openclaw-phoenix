import { useTranslation } from 'react-i18next';
import { statusToKey, type WatchStatusKey } from './types';

/**
 * Hook for translating watch status values
 */
export function useStatusTranslation() {
  const { t } = useTranslation('common');

  const translateStatus = (status: string): string => {
    const key = statusToKey[status] as WatchStatusKey | undefined;
    return key ? t(key) : status;
  };

  return { translateStatus };
}
