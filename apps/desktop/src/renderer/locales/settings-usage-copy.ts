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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type UsageSettingsCopy = {
  saveFailed: string; toolbarAria: string; rangeAria: string; ranges: readonly [string, string, string, string];
  refreshingAria: string; refreshAria: string; summaryAria: string; totalRequests: string; totalCost: string; costHelp: string;
  totalTokens: string; tokenDetail(input: number, output: number): string; cacheTokens: string; cacheDetail(miss: number, read: number, creation: number): string;
  viewAria: string; tabs: readonly [string, string, string, string, string]; filtersAria: string; filterPlaceholder: string; filterAria: string;
  statusAria: string; statuses: readonly [string, string, string, string]; details: string; detailsAria: string; recordCount(count: number): string; clearFilters: string;
  summaryOnly: string; showDetails: string; filteredEmpty: string; filteredEmptyHelp: string; requestEmpty: string;
  costUnavailable: string; incompleteTitle: string; incompleteBody: string;
  tables: {
    providersAria: string; modelsAria: string; toolsAria: string; pricingAria: string; requestsAria: string;
    providerHeaders: string[]; modelHeaders: string[]; toolHeaders: string[]; pricingHeaders: string[]; requestHeaders: string[];
    noPricing: string; modelKind: string; toolKind: string; unknown: string; untitledSession: string; openSession(label: string): string; success: string; error: string; aborted: string;
    providerEmptyTitle: string; providerEmptyBody: string; modelEmptyTitle: string; modelEmptyBody: string;
    toolEmptyTitle: string; toolEmptyBody: string; pricingEmptyBody: string;
  };
};

const SETTINGS_USAGE_COPY = {
  zh: {
    saveFailed: '保存使用统计设置失败', toolbarAria: '使用统计范围与刷新', rangeAria: '使用统计时间范围', ranges: ['24h', '7天', '30天', '全部'],
    refreshingAria: '正在刷新使用统计', refreshAria: '刷新使用统计', summaryAria: '使用统计汇总指标', totalRequests: '模型调用', totalCost: '总费用', costHelp: '以模型供应商最终结算为准',
    totalTokens: '总 Token', tokenDetail: (input, output) => `输入 ${input} / 输出 ${output}`, cacheTokens: '缓存 Token',
    cacheDetail: (miss, read, creation) => `新 ${miss} / 命中 ${read} / 创建 ${creation}`, viewAria: '使用统计视图', tabs: ['活动记录', '供应商统计', '模型统计', '工具统计', '定价配置'],
    filtersAria: '活动记录筛选', filterPlaceholder: '按模型或工具筛选…', filterAria: '按模型或工具筛选活动记录', statusAria: '活动状态筛选',
    statuses: ['全部状态', '成功', '错误', '已中止'], details: '详情记录', detailsAria: '显示使用统计详情记录', recordCount: (count) => `共 ${count} 条记录`, clearFilters: '清除筛选',
    summaryOnly: '当前仅显示汇总指标。打开详情记录后，可以查看逐条模型调用和工具调用，按模型、工具或状态筛选，并用于排查费用与失败调用。',
    showDetails: '显示明细', filteredEmpty: '没有符合筛选条件的活动记录', filteredEmptyHelp: '调整或清除筛选条件后可查看全部活动记录。', requestEmpty: '暂无活动记录',
    costUnavailable: '费用未知', incompleteTitle: '统计可能不完整',
    incompleteBody: '部分记录未能读取、尚未纳入统计或超出展示上限，实际用量可能高于此处显示。',
    tables: {
      providersAria: '使用统计供应商统计表', modelsAria: '使用统计模型统计表', toolsAria: '使用统计工具统计表', pricingAria: '使用统计定价配置表', requestsAria: '使用统计活动记录表',
      providerHeaders: ['供应商', '调用', 'Token', '费用'], modelHeaders: ['模型', '调用', 'Token', '费用'], toolHeaders: ['工具', '调用', '成功', '错误', '平均耗时'],
      pricingHeaders: ['供应商', '模型', '输入 / 1M', '输出 / 1M'], requestHeaders: ['时间', '类型', '对象', '任务', 'Token', '费用', '延迟', '状态'],
      noPricing: '暂无定价覆盖配置', modelKind: '模型', toolKind: '工具', unknown: '未知', untitledSession: '未命名会话', openSession: (label) => `打开会话「${label}」`, success: '成功', error: '错误', aborted: '已中止',
      providerEmptyTitle: '暂无供应商用量', providerEmptyBody: '完成一次模型调用后，这里会按供应商聚合调用数、Token 与费用。',
      modelEmptyTitle: '暂无模型用量', modelEmptyBody: '完成一次模型调用后，这里会按模型聚合调用数、Token 与费用。',
      toolEmptyTitle: '暂无工具调用', toolEmptyBody: '智能体调用工具后，这里会按工具聚合调用次数、成功、错误与平均耗时。',
      pricingEmptyBody: '未配置定价覆盖时，费用按内置模型定价表结算；在此可为特定模型登记自定义价格。',
    },
  },
  en: {
    saveFailed: 'Failed to save usage settings', toolbarAria: 'Usage range and refresh', rangeAria: 'Usage time range', ranges: ['24h', '7 days', '30 days', 'All'],
    refreshingAria: 'Refreshing usage', refreshAria: 'Refresh usage', summaryAria: 'Usage summary metrics', totalRequests: 'Model calls', totalCost: 'Total cost', costHelp: 'Final billing is determined by the model provider',
    totalTokens: 'Total tokens', tokenDetail: (input, output) => `Input ${input} / output ${output}`, cacheTokens: 'Cache tokens',
    cacheDetail: (miss, read, creation) => `New ${miss} / hit ${read} / created ${creation}`, viewAria: 'Usage view', tabs: ['Activity log', 'Providers', 'Models', 'Tools', 'Pricing'],
    filtersAria: 'Activity filters', filterPlaceholder: 'Filter by model or tool…', filterAria: 'Filter activity by model or tool', statusAria: 'Filter by activity status',
    statuses: ['All statuses', 'Success', 'Error', 'Aborted'], details: 'Detailed records', detailsAria: 'Show detailed usage records', recordCount: (count) => `${count} ${count === 1 ? 'record' : 'records'}`, clearFilters: 'Clear filters',
    summaryOnly: 'Only summary metrics are shown. Enable detailed records to inspect individual model calls and tool calls, filter by model, tool, or status, and investigate costs or failures.',
    showDetails: 'Show details', filteredEmpty: 'No activity matches these filters', filteredEmptyHelp: 'Adjust or clear the filters to see all activity records.', requestEmpty: 'No activity records',
    costUnavailable: 'Cost unavailable', incompleteTitle: 'These numbers may be incomplete',
    incompleteBody: 'Some records could not be read, are not folded in yet, or exceed the display limit, so real usage may be higher than shown.',
    tables: {
      providersAria: 'Usage by provider', modelsAria: 'Usage by model', toolsAria: 'Usage by tool', pricingAria: 'Usage pricing configuration', requestsAria: 'Usage activity log',
      providerHeaders: ['Provider', 'Calls', 'Tokens', 'Cost'], modelHeaders: ['Model', 'Calls', 'Tokens', 'Cost'], toolHeaders: ['Tool', 'Calls', 'Success', 'Errors', 'Average duration'],
      pricingHeaders: ['Provider', 'Model', 'Input / 1M', 'Output / 1M'], requestHeaders: ['Time', 'Type', 'Target', 'Task', 'Tokens', 'Cost', 'Latency', 'Status'],
      noPricing: 'No pricing overrides', modelKind: 'Model', toolKind: 'Tool', unknown: 'Unknown', untitledSession: 'Untitled session', openSession: (label) => `Open session "${label}"`, success: 'Success', error: 'Error', aborted: 'Aborted',
      providerEmptyTitle: 'No provider usage', providerEmptyBody: 'After a model call, provider call counts, tokens, and costs appear here.',
      modelEmptyTitle: 'No model usage', modelEmptyBody: 'After a model call, call counts, tokens, and costs appear here by model.',
      toolEmptyTitle: 'No tool calls', toolEmptyBody: 'After an agent calls a tool, calls, successes, errors, and average duration appear here by tool.',
      pricingEmptyBody: 'Without pricing overrides, costs use the built-in model pricing table. Add custom prices here for specific models.',
    },
  },
} satisfies UiCatalog<UsageSettingsCopy>;

export function getUsageSettingsCopy(locale: UiLocale): UsageSettingsCopy {
  return SETTINGS_USAGE_COPY[locale];
}
