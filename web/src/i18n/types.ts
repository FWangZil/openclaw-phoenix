// i18n 类型定义

export type I18nNamespace = 'common' | 'setup' | 'archives' | 'configuration';

// Watch 状态的翻译键
export type WatchStatusKey =
  | 'statusStopped'
  | 'statusStarting'
  | 'statusRunning'
  | 'statusStopping'
  | 'statusError';

// 状态值到翻译键的映射
export const statusToKey: Record<string, WatchStatusKey> = {
  stopped: 'statusStopped',
  starting: 'statusStarting',
  running: 'statusRunning',
  stopping: 'statusStopping',
  error: 'statusError',
};
