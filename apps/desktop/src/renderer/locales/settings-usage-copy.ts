import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type UsageSettingsCopy = {
  saveFailed: string; toolbarAria: string; rangeAria: string; ranges: readonly [string, string, string, string];
  refreshingAria: string; refreshAria: string; summaryAria: string; totalRequests: string; totalCost: string; costHelp: string;
  totalTokens: string; tokenDetail(input: number, output: number): string; cacheTokens: string; cacheDetail(miss: number, read: number, creation: number): string;
  coverage: {
    incompleteTitle: string; legacyTitle: string; token(partial: number, missing: number): string; cost(partial: number, unpriced: number): string;
    legacy(count: number): string; projection(unreadable: number, pending: number): string;
    knownValuesOnly: string; projectionMayOmit: string; description(parts: string[]): string;
  };
  viewAria: string; tabs: readonly [string, string, string, string, string]; filtersAria: string; filterPlaceholder: string; filterAria: string;
  statusAria: string; statuses: readonly [string, string, string, string]; details: string; detailsAria: string; recordCount(count: number): string; recordCountTruncated(shown: number, total: number): string; clearFilters: string;
  summaryOnly: string; showDetails: string; filteredEmpty: string; filteredEmptyHelp: string; requestEmpty: string;
  tables: {
    providersAria: string; modelsAria: string; toolsAria: string; pricingAria: string; requestsAria: string;
    providerHeaders: string[]; modelHeaders: string[]; toolHeaders: string[]; pricingHeaders: string[]; requestHeaders: string[];
    noPricing: string; modelKind: string; toolKind: string; openSession(label: string): string; success: string; error: string; aborted: string;
    notReported: string; unpriced: string; notRecorded: string; notApplicable: string; partial(value: string | number): string;
    providerEmptyTitle: string; providerEmptyBody: string; modelEmptyTitle: string; modelEmptyBody: string;
    toolEmptyTitle: string; toolEmptyBody: string; pricingEmptyBody: string;
  };
};

const SETTINGS_USAGE_COPY = {
  zh: {
    saveFailed: '保存使用统计设置失败', toolbarAria: '使用统计范围与刷新', rangeAria: '使用统计时间范围', ranges: ['24h', '7天', '30天', '全部'],
    refreshingAria: '正在刷新使用统计', refreshAria: '刷新使用统计', summaryAria: '使用统计汇总指标', totalRequests: '总请求', totalCost: '总费用', costHelp: '以模型供应商最终结算为准',
    totalTokens: '总 Token', tokenDetail: (input, output) => `输入 ${input} / 输出 ${output}`, cacheTokens: '缓存 Token',
    cacheDetail: (miss, read, creation) => `新 ${miss} / 命中 ${read} / 创建 ${creation}`, viewAria: '使用统计视图', tabs: ['请求日志', '供应商统计', '模型统计', '工具统计', '定价配置'],
    coverage: {
      incompleteTitle: '部分用量数据不完整', legacyTitle: '部分历史用量缺少详细依据',
      token: (partial, missing) => `Token：${[
        ...(partial > 0 ? [`${partial} 个部分上报`] : []),
        ...(missing > 0 ? [`${missing} 个未上报`] : []),
      ].join(' / ')}`,
      cost: (partial, unpriced) => `费用：${[
        ...(partial > 0 ? [`${partial} 个部分金额`] : []),
        ...(unpriced > 0 ? [`${unpriced} 个未定价`] : []),
      ].join(' / ')}`,
      legacy: (count) => `历史：${count} 条记录缺少依据，仍按存储值计入`,
      projection: (unreadable, pending) => `投影：${[
        ...(unreadable > 0 ? [`${unreadable} 条无法读取`] : []),
        ...(pending > 0 ? [`${pending} 个运行待修复`] : []),
      ].join(' / ')}`,
      knownValuesOnly: 'Token 与费用仅显示可计算的值', projectionMayOmit: '请求数和汇总可能漏计',
      description: (parts) => `${parts.join('；')}。`,
    },
    filtersAria: '请求记录筛选', filterPlaceholder: '按模型或工具筛选…', filterAria: '按模型或工具筛选请求记录', statusAria: '请求状态筛选',
    statuses: ['全部状态', '成功', '错误', '已中断'], details: '详情记录', detailsAria: '显示使用统计详情记录', recordCount: (count) => `共 ${count} 条记录`, recordCountTruncated: (shown, total) => `显示最新 ${shown} 条，共 ${total} 条；缩小时间范围可查看更早记录`, clearFilters: '清除筛选',
    summaryOnly: '当前仅显示汇总指标。打开详情记录后，可以查看逐条模型请求和工具调用，按模型、工具或状态筛选，并用于排查费用与失败请求。',
    showDetails: '显示明细', filteredEmpty: '没有符合筛选条件的请求记录', filteredEmptyHelp: '调整或清除筛选条件后可查看全部请求记录。', requestEmpty: '暂无请求记录',
    tables: {
      providersAria: '使用统计供应商统计表', modelsAria: '使用统计模型统计表', toolsAria: '使用统计工具统计表', pricingAria: '使用统计定价配置表', requestsAria: '使用统计请求日志表',
      providerHeaders: ['供应商', '请求', 'Token', '费用'], modelHeaders: ['模型', '请求', 'Token', '费用'], toolHeaders: ['工具', '调用', '成功', '错误', '已中断', '平均耗时'],
      pricingHeaders: ['供应商', '模型', '输入 / 1M', '输出 / 1M'], requestHeaders: ['时间', '类型', '对象', '会话', 'Token', '费用', '延迟', '状态'],
      noPricing: '暂无定价覆盖配置', modelKind: '模型', toolKind: '工具', openSession: (label) => `打开 ${label}`, success: '成功', error: '错误', aborted: '已中断',
      notReported: '未上报', unpriced: '未定价', notRecorded: '未记录', notApplicable: '—', partial: (value) => `${value}（部分）`,
      providerEmptyTitle: '暂无供应商用量', providerEmptyBody: '完成一次模型请求后，这里会按供应商聚合请求数、Token 与费用。',
      modelEmptyTitle: '暂无模型用量', modelEmptyBody: '完成一次模型请求后，这里会按模型聚合请求数、Token 与费用。',
      toolEmptyTitle: '暂无工具调用', toolEmptyBody: '智能体调用工具后，这里会按工具聚合调用次数、成功、错误、已中断与平均耗时。',
      pricingEmptyBody: '未配置定价覆盖时，费用按内置模型定价表结算；在此可为特定模型登记自定义价格。',
    },
  },
  en: {
    saveFailed: 'Failed to save usage settings', toolbarAria: 'Usage range and refresh', rangeAria: 'Usage time range', ranges: ['24h', '7 days', '30 days', 'All'],
    refreshingAria: 'Refreshing usage', refreshAria: 'Refresh usage', summaryAria: 'Usage summary metrics', totalRequests: 'Total requests', totalCost: 'Total cost', costHelp: 'Final billing is determined by the model provider',
    totalTokens: 'Total tokens', tokenDetail: (input, output) => `Input ${input} / output ${output}`, cacheTokens: 'Cache tokens',
    cacheDetail: (miss, read, creation) => `New ${miss} / hit ${read} / created ${creation}`, viewAria: 'Usage view', tabs: ['Request log', 'Providers', 'Models', 'Tools', 'Pricing'],
    coverage: {
      incompleteTitle: 'Some usage data is incomplete', legacyTitle: 'Some historical usage lacks detailed records',
      token: (partial, missing) => `Tokens: ${[
        ...(partial > 0 ? [`${partial} partial`] : []),
        ...(missing > 0 ? [`${missing} not reported`] : []),
      ].join(' / ')}`,
      cost: (partial, unpriced) => `Cost: ${[
        ...(partial > 0 ? [`${partial} partial`] : []),
        ...(unpriced > 0 ? [`${unpriced} unpriced`] : []),
      ].join(' / ')}`,
      legacy: (count) => `History: ${count} ${count === 1 ? 'record lacks' : 'records lack'} basis and still use stored values`,
      projection: (unreadable, pending) => `Projection: ${[
        ...(unreadable > 0 ? [`${unreadable} unreadable`] : []),
        ...(pending > 0 ? [`${pending} pending ${pending === 1 ? 'run' : 'runs'}`] : []),
      ].join(' / ')}`,
      knownValuesOnly: 'Token and cost totals show calculable values only', projectionMayOmit: 'Request counts and totals may omit records',
      description: (parts) => `${parts.join('. ')}.`,
    },
    filtersAria: 'Request filters', filterPlaceholder: 'Filter by model or tool…', filterAria: 'Filter requests by model or tool', statusAria: 'Filter by request status',
    statuses: ['All statuses', 'Success', 'Error', 'Aborted'], details: 'Detailed records', detailsAria: 'Show detailed usage records', recordCount: (count) => `${count} ${count === 1 ? 'record' : 'records'}`, recordCountTruncated: (shown, total) => `Showing newest ${shown} of ${total} records; narrow the range for older ones`, clearFilters: 'Clear filters',
    summaryOnly: 'Only summary metrics are shown. Enable detailed records to inspect individual model requests and tool calls, filter by model, tool, or status, and investigate costs or failures.',
    showDetails: 'Show details', filteredEmpty: 'No requests match these filters', filteredEmptyHelp: 'Adjust or clear the filters to see all request records.', requestEmpty: 'No request records',
    tables: {
      providersAria: 'Usage by provider', modelsAria: 'Usage by model', toolsAria: 'Usage by tool', pricingAria: 'Usage pricing configuration', requestsAria: 'Usage request log',
      providerHeaders: ['Provider', 'Requests', 'Tokens', 'Cost'], modelHeaders: ['Model', 'Requests', 'Tokens', 'Cost'], toolHeaders: ['Tool', 'Calls', 'Success', 'Errors', 'Aborted', 'Average duration'],
      pricingHeaders: ['Provider', 'Model', 'Input / 1M', 'Output / 1M'], requestHeaders: ['Time', 'Type', 'Target', 'Session', 'Tokens', 'Cost', 'Latency', 'Status'],
      noPricing: 'No pricing overrides', modelKind: 'Model', toolKind: 'Tool', openSession: (label) => `Open ${label}`, success: 'Success', error: 'Error', aborted: 'Aborted',
      notReported: 'Not reported', unpriced: 'Unpriced', notRecorded: 'Not recorded', notApplicable: '—', partial: (value) => `${value} (partial)`,
      providerEmptyTitle: 'No provider usage', providerEmptyBody: 'After a model request, provider request counts, tokens, and costs appear here.',
      modelEmptyTitle: 'No model usage', modelEmptyBody: 'After a model request, request counts, tokens, and costs appear here by model.',
      toolEmptyTitle: 'No tool calls', toolEmptyBody: 'After an agent calls a tool, calls, successes, errors, aborts, and average duration appear here by tool.',
      pricingEmptyBody: 'Without pricing overrides, costs use the built-in model pricing table. Add custom prices here for specific models.',
    },
  },
} satisfies UiCatalog<UsageSettingsCopy>;

export function getUsageSettingsCopy(locale: UiLocale): UsageSettingsCopy {
  return SETTINGS_USAGE_COPY[locale];
}
