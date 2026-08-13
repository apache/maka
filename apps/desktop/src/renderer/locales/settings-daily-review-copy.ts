import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type DailyReviewSettingsCopy = {
  defaultModel: string;
  saveFailed: string;
  aria: string;
  unavailable: string;
  loadFailed(error: string): string;
  scheduleTitle: string;
  scheduleDescription: string;
  enabled: string;
  enabledHelp: string;
  executeTime: string;
  executeTimeHelp: string;
  executeTimePlaceholder: string;
  executeTimeInvalid: string;
  analysisTitle: string;
  analysisDescription: string;
  model: string;
  modelHelp: string;
};

const SETTINGS_DAILY_REVIEW_COPY = {
  zh: {
    defaultModel: '跟随对话默认',
    saveFailed: '保存每日回顾设置失败',
    aria: '每日回顾',
    unavailable: '当前版本无法读取每日回顾设置。',
    loadFailed: (error) => `读取每日回顾设置失败：${error}`,
    scheduleTitle: '定时分析',
    scheduleDescription: '按本地时间自动分析前一个完整自然日的活动。',
    enabled: '启用定时分析',
    enabledHelp: '每天生成一份昨日活动分析。',
    executeTime: '执行时间',
    executeTimeHelp: '使用 24 小时制的本地时间。',
    executeTimePlaceholder: 'HH:mm',
    executeTimeInvalid: '请输入 24 小时制时间，例如 08:00。',
    analysisTitle: '分析',
    analysisDescription: '选择用于生成固定结构报告的模型。',
    model: '分析模型',
    modelHelp: '未指定时跟随当前对话的默认模型。',
  },
  en: {
    defaultModel: 'Follow conversation default',
    saveFailed: 'Failed to save Daily Review settings',
    aria: 'Daily Review',
    unavailable: 'Daily Review settings are unavailable in this build.',
    loadFailed: (error) => `Failed to load Daily Review settings: ${error}`,
    scheduleTitle: 'Schedule',
    scheduleDescription: 'Analyze the previous complete local day automatically.',
    enabled: 'Enable scheduled analysis',
    enabledHelp: 'Generate an analysis of yesterday’s activity each day.',
    executeTime: 'Run time',
    executeTimeHelp: 'Uses your local time in 24-hour format.',
    executeTimePlaceholder: 'HH:mm',
    executeTimeInvalid: 'Enter a 24-hour time, for example 08:00.',
    analysisTitle: 'Analysis',
    analysisDescription: 'Choose the model used to generate the fixed report structure.',
    model: 'Analysis model',
    modelHelp: 'Follows the current conversation default when unspecified.',
  },
} satisfies UiCatalog<DailyReviewSettingsCopy>;

export function getDailyReviewSettingsCopy(locale: UiLocale): DailyReviewSettingsCopy {
  return SETTINGS_DAILY_REVIEW_COPY[locale];
}
