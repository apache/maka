import type { DailyReviewArchive, UiCatalog, UiLocale } from '@maka/core';

type ArchiveSectionKey = keyof DailyReviewArchive['sections'];

export interface DailyReviewCopy {
  archive: {
    section: Record<ArchiveSectionKey, string>;
    status: Record<DailyReviewArchive['status'], string>;
    trigger: Record<DailyReviewArchive['trigger'], string>;
    mode: { daily: string; deep: string };
    title: (date: string, mode: string) => string;
    generated: (trigger: string, time: string) => string;
    sessionCount: (count: number) => string;
    defaultModel: string;
    opening: string;
    noContent: string;
  };
  date: {
    today: string;
    yesterday: string;
    daysAgo: (count: number) => string;
    recent7Days: string;
    recent30Days: string;
    shiftedRange: (range: string, days: number) => string;
    unit: { day: string; week: string; month: string };
    earlier: (unit: string) => string;
    later: (unit: string) => string;
  };
  emptyOverview: {
    todayTitle: string;
    rangeTitle: (label: string) => string;
    todayBody: string;
    rangeBody: (label: string) => string;
  };
  export: {
    ariaLabel: string;
    copyTitle: string;
    copying: string;
    copy: string;
    appendTitle: string;
    appending: string;
    append: string;
    saveTitle: string;
    saving: string;
    save: string;
  };
  page: {
    title: string;
    subtitle: string;
    generateAriaLabel: string;
    analysisModel: string;
    generating: string;
    generateDaily: string;
    generateDeep: string;
    timeRange: string;
    rangeOptions: ReadonlyArray<readonly [string, string]>;
    rangeSwitch: string;
  };
  overview: {
    ariaLabel: (label: string) => string;
    title: string;
    refreshFailed: (error: string) => string;
    retry: string;
    readFailed: string;
    conversations: string;
    requests: string;
    tokens: string;
    cost: string;
    errors: string;
    activeConversations: string;
    activeConversationList: string;
    modelUsage: string;
    toolCalls: string;
  };
  reports: {
    title: string;
    count: (count: number) => string;
    readFailed: (error: string) => string;
    emptyTitle: string;
    emptyBody: string;
    historyAriaLabel: string;
  };
  list: {
    ariaLabel: (title: string) => string;
    requestCount: (count: number) => string;
  };
  errorFallback: string;
  markdown: {
    separator: ':' | '：';
    title: (dayLabel: string) => string;
    conversations: string;
    requests: string;
    tokens: string;
    cost: string;
    errors: string;
    activeConversations: string;
    modelUsage: string;
    toolCalls: string;
    requestCount: (count: number) => string;
  };
}

const DAILY_REVIEW_COPY = {
  zh: {
    archive: {
      section: { summary: '对话摘要', gaps: '遗漏提醒', usage: '使用洞察', code: '代码建议' },
      status: { ok: '已生成', no_model: '缺少模型', no_data: '无数据', failed: '生成失败', skipped: '已跳过' },
      trigger: { cron: '定时', manual: '手动' },
      mode: { daily: '每日回顾', deep: '深度分析' },
      title: (date, mode) => `${date} · ${mode}`,
      generated: (trigger, time) => `${trigger}生成 ${time}`,
      sessionCount: (count) => `${count} 对话`,
      defaultModel: '默认对话模型',
      opening: '正在打开这份报告…',
      noContent: '这份报告没有生成正文内容。',
    },
    date: {
      today: '今天', yesterday: '昨天', daysAgo: (count) => `${count} 天前`, recent7Days: '最近 7 天', recent30Days: '最近 30 天', shiftedRange: (range, days) => `${range}（往前 ${days} 天）`,
      unit: { day: '天', week: '周', month: '月' }, earlier: (unit) => `查看更早一${unit}`, later: (unit) => `查看更晚一${unit}`,
    },
    emptyOverview: {
      todayTitle: '等待记录今天活动', rangeTitle: (label) => `${label}无活动`, todayBody: '今天还没有发起对话，也没有调用模型。', rangeBody: (label) => `${label}范围内没有发起对话，也没有调用模型。`,
    },
    export: {
      ariaLabel: '回顾导出操作', copyTitle: '复制为 Markdown 摘要，方便分享 / 贴到笔记', copying: '复制中…', copy: '复制', appendTitle: '追加到当前输入框草稿', appending: '追加中…', append: '粘到输入框', saveTitle: '保存为 Markdown 文件', saving: '保存中…', save: '保存',
    },
    page: {
      title: '每日回顾', subtitle: '自动汇总本机对话，生成摘要、遗漏提醒与深度分析；可在设置中开启定时执行。', generateAriaLabel: '生成回顾', analysisModel: '分析模型', generating: '生成中…', generateDaily: '生成每日回顾', generateDeep: '生成深度分析', timeRange: '时间范围', rangeOptions: [['1', '今日'], ['7', '本周'], ['30', '本月']], rangeSwitch: '时间范围切换',
    },
    overview: {
      ariaLabel: (label) => `${label}概览`, title: '概览', refreshFailed: (error) => `每日回顾刷新失败：${error}`, retry: '重试', readFailed: '读取失败', conversations: '对话', requests: '请求', tokens: 'Token', cost: '费用', errors: '错误', activeConversations: '活跃对话', activeConversationList: '活跃对话列表', modelUsage: '模型使用', toolCalls: '工具调用',
    },
    reports: {
      title: '报告', count: (count) => `${count} 份`, readFailed: (error) => `回顾报告读取失败：${error}`, emptyTitle: '还没有生成报告', emptyBody: '点击「生成每日回顾」后，报告会保存到本机并显示在这里。', historyAriaLabel: '回顾报告历史',
    },
    list: { ariaLabel: (title) => `${title}列表`, requestCount: (count) => `${count} 次` },
    errorFallback: '每日回顾暂时不可用，请稍后重试。',
    markdown: {
      separator: '：', title: (dayLabel) => `# Maka · 每日回顾 · ${dayLabel}`, conversations: '对话', requests: '请求', tokens: 'Token', cost: '费用', errors: '错误', activeConversations: '活跃对话', modelUsage: '模型使用', toolCalls: '工具调用', requestCount: (count) => `${count} 次`,
    },
  },
  en: {
    archive: {
      section: { summary: 'Conversation summary', gaps: 'Missed items', usage: 'Usage insights', code: 'Code suggestions' },
      status: { ok: 'Generated', no_model: 'Model unavailable', no_data: 'No data', failed: 'Generation failed', skipped: 'Skipped' },
      trigger: { cron: 'Scheduled', manual: 'Manual' },
      mode: { daily: 'Daily review', deep: 'Deep analysis' },
      title: (date, mode) => `${date} · ${mode}`,
      generated: (trigger, time) => `${trigger} · ${time}`,
      sessionCount: (count) => `${count} ${count === 1 ? 'conversation' : 'conversations'}`,
      defaultModel: 'Default conversation model',
      opening: 'Opening this report…',
      noContent: 'This report has no generated content.',
    },
    date: {
      today: 'Today', yesterday: 'Yesterday', daysAgo: (count) => `${count} days ago`, recent7Days: 'Last 7 days', recent30Days: 'Last 30 days', shiftedRange: (range, days) => `${range} (${days} days earlier)`,
      unit: { day: 'day', week: 'week', month: 'month' }, earlier: (unit) => `View previous ${unit}`, later: (unit) => `View next ${unit}`,
    },
    emptyOverview: {
      todayTitle: "Waiting for today's activity", rangeTitle: (label) => `No activity for ${label.toLowerCase()}`, todayBody: 'No conversations or model requests have started today.', rangeBody: (label) => `No conversations or model requests were made during ${label.toLowerCase()}.`,
    },
    export: {
      ariaLabel: 'Review export actions', copyTitle: 'Copy a Markdown summary to share or add to notes', copying: 'Copying…', copy: 'Copy', appendTitle: 'Append to the current composer draft', appending: 'Appending…', append: 'Add to composer', saveTitle: 'Save as a Markdown file', saving: 'Saving…', save: 'Save',
    },
    page: {
      title: 'Daily review', subtitle: 'Summarize local conversations into highlights, missed items, and deeper analysis. Scheduled runs can be enabled in Settings.', generateAriaLabel: 'Generate review', analysisModel: 'Analysis model', generating: 'Generating…', generateDaily: 'Generate daily review', generateDeep: 'Generate deep analysis', timeRange: 'Time range', rangeOptions: [['1', 'Today'], ['7', 'This week'], ['30', 'This month']], rangeSwitch: 'Change time range',
    },
    overview: {
      ariaLabel: (label) => `${label} overview`, title: 'Overview', refreshFailed: (error) => `Failed to refresh daily review: ${error}`, retry: 'Retry', readFailed: 'Failed to load', conversations: 'Conversations', requests: 'Requests', tokens: 'Tokens', cost: 'Cost', errors: 'Errors', activeConversations: 'Active conversations', activeConversationList: 'Active conversation list', modelUsage: 'Model usage', toolCalls: 'Tool calls',
    },
    reports: {
      title: 'Reports', count: (count) => `${count} ${count === 1 ? 'report' : 'reports'}`, readFailed: (error) => `Failed to load review reports: ${error}`, emptyTitle: 'No reports yet', emptyBody: 'Generate a daily review to save a local report and show it here.', historyAriaLabel: 'Review report history',
    },
    list: { ariaLabel: (title) => `${title} list`, requestCount: (count) => `${count} ${count === 1 ? 'request' : 'requests'}` },
    errorFallback: 'Daily review is temporarily unavailable. Try again later.',
    markdown: {
      separator: ':', title: (dayLabel) => `# Maka · Daily review · ${dayLabel}`, conversations: 'Conversations', requests: 'Requests', tokens: 'Tokens', cost: 'Cost', errors: 'Errors', activeConversations: 'Active conversations', modelUsage: 'Model usage', toolCalls: 'Tool calls', requestCount: (count) => `${count} ${count === 1 ? 'request' : 'requests'}`,
    },
  },
} satisfies UiCatalog<DailyReviewCopy>;

export function getDailyReviewCopy(locale: UiLocale): DailyReviewCopy {
  return DAILY_REVIEW_COPY[locale];
}
