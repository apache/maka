/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { DailyReviewArchive } from '@maka/core/daily-review';

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

type ArchiveSectionKey = keyof DailyReviewArchive['sections'];

export interface DailyReviewCopy {
  archive: {
    section: Record<ArchiveSectionKey, string>;
    status: Record<DailyReviewArchive['status'], string>;
    trigger: Record<DailyReviewArchive['trigger'], string>;
    title: (date: string, range: string) => string;
    range: Record<DailyReviewArchive['range'], string>;
    generated: (trigger: string, time: string) => string;
    sessionCount: (count: number) => string;
    defaultModel: string;
    opening: string;
    noContent: string;
    /** The panel-empty (tier 2) sentence under `noContent`. */
    noContentHelp: string;
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
    generateAnalysis: string;
    retryAnalysis: string;
    viewAnalysis: string;
    backToActivity: string;
    timeRange: string;
    rangeOptions: ReadonlyArray<readonly [string, string]>;
    rangeSwitch: string;
  };
  overview: {
    ariaLabel: (label: string) => string;
    refreshFailed: (error: string) => string;
    retry: string;
    conversations: string;
    requests: string;
    tokens: string;
    cost: string;
    activeConversations: string;
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
      section: { summary: '任务摘要', gaps: '遗漏提醒', usage: '使用洞察', code: '代码建议' },
      status: { ok: '已生成', no_model: '缺少模型', no_data: '无数据', failed: '生成失败', skipped: '已跳过' },
      trigger: { cron: '定时', manual: '手动' },
      title: (date, mode) => `${date} · ${mode}`,
      range: { 1: '单日', 7: '7 天', 30: '30 天' },
      generated: (trigger, time) => `${trigger}生成 ${time}`,
      sessionCount: (count) => `${count} 任务`,
      defaultModel: '默认任务模型',
      opening: '正在打开这份报告…',
      noContent: '这份报告没有生成正文内容。',
      noContentHelp: '这一天没有归档内容。',
    },
    date: {
      today: '今天', yesterday: '昨天', daysAgo: (count) => `${count} 天前`, recent7Days: '最近 7 天', recent30Days: '最近 30 天', shiftedRange: (range, days) => `${range}（往前 ${days} 天）`,
      unit: { day: '天', week: '周', month: '月' }, earlier: (unit) => `查看更早一${unit}`, later: (unit) => `查看更晚一${unit}`,
    },
    emptyOverview: {
      todayTitle: '等待记录今天活动', rangeTitle: (label) => `${label}无活动`, todayBody: '今天还没有发起任务，也没有调用模型。', rangeBody: (label) => `${label}范围内没有发起任务，也没有调用模型。`,
    },
    export: {
      ariaLabel: '回顾导出操作', copyTitle: '复制为 Markdown 摘要，方便分享 / 贴到笔记', copying: '复制中…', copy: '复制', appendTitle: '追加到当前输入框草稿', appending: '追加中…', append: '粘到输入框', saveTitle: '保存为 Markdown 文件', saving: '保存中…', save: '保存',
    },
    page: {
      title: '每日回顾', generateAnalysis: '生成分析', retryAnalysis: '重新生成', viewAnalysis: '查看分析', backToActivity: '返回活动', timeRange: '时间范围', rangeOptions: [['1', '今日'], ['7', '最近 7 天'], ['30', '最近 30 天']], rangeSwitch: '时间范围切换',
    },
    overview: {
      ariaLabel: (label) => `${label}概览`, refreshFailed: (error) => `每日回顾刷新失败：${error}`, retry: '重试', conversations: '任务', requests: '请求', tokens: 'Token', cost: '费用', activeConversations: '活跃任务',
    },
    errorFallback: '每日回顾暂时不可用，请稍后重试。',
    markdown: {
      separator: '：', title: (dayLabel) => `# Maka · 每日回顾 · ${dayLabel}`, conversations: '任务', requests: '请求', tokens: 'Token', cost: '费用', errors: '错误', activeConversations: '活跃任务', modelUsage: '模型使用', toolCalls: '工具调用', requestCount: (count) => `${count} 次`,
    },
  },
  en: {
    archive: {
      section: { summary: 'Task summary', gaps: 'Missed items', usage: 'Usage insights', code: 'Code suggestions' },
      status: { ok: 'Generated', no_model: 'Model unavailable', no_data: 'No data', failed: 'Generation failed', skipped: 'Skipped' },
      trigger: { cron: 'Scheduled', manual: 'Manual' },
      title: (date, mode) => `${date} · ${mode}`,
      range: { 1: '1 day', 7: '7 days', 30: '30 days' },
      generated: (trigger, time) => `${trigger} · ${time}`,
      sessionCount: (count) => `${count} ${count === 1 ? 'task' : 'tasks'}`,
      defaultModel: 'Default task model',
      opening: 'Opening this report…',
      noContent: 'This report has no generated content.',
      noContentHelp: 'Nothing archived for this day.',
    },
    date: {
      today: 'Today', yesterday: 'Yesterday', daysAgo: (count) => `${count} days ago`, recent7Days: 'Last 7 days', recent30Days: 'Last 30 days', shiftedRange: (range, days) => `${range} (${days} days earlier)`,
      unit: { day: 'day', week: 'week', month: 'month' }, earlier: (unit) => `View previous ${unit}`, later: (unit) => `View next ${unit}`,
    },
    emptyOverview: {
      todayTitle: "Waiting for today's activity", rangeTitle: (label) => `No activity for ${label.toLowerCase()}`, todayBody: 'No tasks or model requests have started today.', rangeBody: (label) => `No tasks or model requests were made during ${label.toLowerCase()}.`,
    },
    export: {
      ariaLabel: 'Review export actions', copyTitle: 'Copy a Markdown summary to share or add to notes', copying: 'Copying…', copy: 'Copy', appendTitle: 'Append to the current composer draft', appending: 'Appending…', append: 'Add to composer', saveTitle: 'Save as a Markdown file', saving: 'Saving…', save: 'Save',
    },
    page: {
      title: 'Daily review', generateAnalysis: 'Generate analysis', retryAnalysis: 'Generate again', viewAnalysis: 'View analysis', backToActivity: 'Back to activity', timeRange: 'Time range', rangeOptions: [['1', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days']], rangeSwitch: 'Change time range',
    },
    overview: {
      ariaLabel: (label) => `${label} overview`, refreshFailed: (error) => `Failed to refresh daily review: ${error}`, retry: 'Retry', conversations: 'Tasks', requests: 'Requests', tokens: 'Tokens', cost: 'Cost', activeConversations: 'Active tasks',
    },
    errorFallback: 'Daily review is temporarily unavailable. Try again later.',
    markdown: {
      separator: ':', title: (dayLabel) => `# Maka · Daily review · ${dayLabel}`, conversations: 'Tasks', requests: 'Requests', tokens: 'Tokens', cost: 'Cost', errors: 'Errors', activeConversations: 'Active tasks', modelUsage: 'Model usage', toolCalls: 'Tool calls', requestCount: (count) => `${count} ${count === 1 ? 'request' : 'requests'}`,
    },
  },
} satisfies UiCatalog<DailyReviewCopy>;

export function getDailyReviewCopy(locale: UiLocale): DailyReviewCopy {
  return DAILY_REVIEW_COPY[locale];
}
