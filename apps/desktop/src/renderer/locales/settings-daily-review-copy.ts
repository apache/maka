import type { DailyReviewMode, UiCatalog, UiLocale } from '@maka/core';

type DailyReviewSection = 'summary' | 'gaps' | 'usage' | 'code';

export type DailyReviewSettingsCopy = {
  defaultModel: string;
  saveFailed: string;
  runSuccess: Record<DailyReviewMode, string>;
  runSuccessDetail: string;
  runFailed: string;
  aria: string;
  unavailable: string;
  loadFailed(error: string): string;
  enabled: string;
  enabledHelp: string;
  executeTime: string;
  executeTimeHelp: string;
  executeTimeAria: string;
  sections: Record<DailyReviewSection, { title: string; detail: string }>;
  deep: string;
  deepHelp: string;
  model: string;
  modelHelp: string;
  modelAria: string;
  includeCli: string;
  includeCliHelp: string;
  notify: string;
  notifyHelp: string;
  actionsAria: string;
  generating: string;
  generateDeep: string;
  generateDaily: string;
  open: string;
};

const SETTINGS_DAILY_REVIEW_COPY = {
  zh: {
    defaultModel: '跟随对话默认', saveFailed: '保存每日回顾设置失败', runSuccess: { daily: '已生成每日回顾', deep: '已生成深度分析' }, runSuccessDetail: '可在「每日回顾」面板查看。', runFailed: '生成回顾失败',
    aria: '每日回顾', unavailable: '当前版本仅本地数字聚合，定时生成 / LLM 摘要尚未连接到后端。', loadFailed: (error) => `读取每日回顾设置失败：${error}`,
    enabled: '启用每日回顾', enabledHelp: '每天自动分析前一天的工作内容，提供摘要与建议。', executeTime: '执行时间', executeTimeHelp: '默认 08:00 本地时间触发。', executeTimeAria: '每日回顾执行时间',
    sections: { summary: { title: '对话摘要', detail: '昨天聊了什么，关键结论是什么。' }, gaps: { title: '遗漏提醒', detail: '开始但未完成的讨论、可能忽略的要点。' }, usage: { title: '使用洞察', detail: '模型选择、Token 消耗、工具使用效率。' }, code: { title: '代码建议', detail: '基于对话中的代码讨论，给出优化建议。' } },
    deep: '深度分析', deepHelp: '消耗更多资源，对更长时间周期进行深入调研。', model: '分析模型', modelHelp: '用于生成回顾和分析的模型连接；默认跟随当前对话默认模型。', modelAria: '分析模型连接',
    includeCli: '包含 Claude Code CLI 会话', includeCliHelp: '将已同步的 Claude Code 对话纳入分析范围。', notify: '生成后发送外部通知', notifyHelp: '当前运行时尚未接入报告自动推送。机器人通道可以在「机器人对话」里配置，但每日回顾不会假装已发送。',
    actionsAria: '每日回顾操作', generating: '生成中…', generateDeep: '生成深度分析', generateDaily: '生成每日回顾', open: '打开每日回顾',
  },
  en: {
    defaultModel: 'Follow conversation default', saveFailed: 'Failed to save Daily Review settings', runSuccess: { daily: 'Daily Review generated', deep: 'Deep analysis generated' }, runSuccessDetail: 'View it in the Daily Review panel.', runFailed: 'Failed to generate review',
    aria: 'Daily Review', unavailable: 'This version supports local numeric aggregation only. Scheduled generation and LLM summaries are not connected to the backend.', loadFailed: (error) => `Failed to load Daily Review settings: ${error}`,
    enabled: 'Enable Daily Review', enabledHelp: 'Automatically analyze the previous day’s work and provide summaries and suggestions.', executeTime: 'Run time', executeTimeHelp: 'Runs at 08:00 local time by default.', executeTimeAria: 'Daily Review run time',
    sections: { summary: { title: 'Conversation summary', detail: 'What you discussed yesterday and the key conclusions.' }, gaps: { title: 'Missed items', detail: 'Discussions that started but did not finish and points that may have been overlooked.' }, usage: { title: 'Usage insights', detail: 'Model choices, token consumption, and tool-use efficiency.' }, code: { title: 'Code suggestions', detail: 'Optimization suggestions based on code discussed in conversations.' } },
    deep: 'Deep analysis', deepHelp: 'Use more resources to investigate a longer time period.', model: 'Analysis model', modelHelp: 'The model connection used for reviews and analysis; follows the current conversation default unless changed.', modelAria: 'Analysis model connection',
    includeCli: 'Include Claude Code CLI sessions', includeCliHelp: 'Include synced Claude Code conversations in the analysis.', notify: 'Send an external notification after generation', notifyHelp: 'Automatic report delivery is not connected yet. Bot channels can be configured under Bot chat, but Daily Review will not claim a report was sent.',
    actionsAria: 'Daily Review actions', generating: 'Generating…', generateDeep: 'Generate deep analysis', generateDaily: 'Generate Daily Review', open: 'Open Daily Review',
  },
} satisfies UiCatalog<DailyReviewSettingsCopy>;

export function getDailyReviewSettingsCopy(locale: UiLocale): DailyReviewSettingsCopy {
  return SETTINGS_DAILY_REVIEW_COPY[locale];
}
