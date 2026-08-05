import type { UiCatalog, UiLocale } from '@maka/core';
import type { PricingDraftError, PricingDraftField } from '../settings/pricing-settings-model';

export type PricingSettingsCopy = {
  heading: string;
  description: string;
  disclaimer: string;
  refresh: string;
  refreshing: string;
  addPrice: string;
  loading: string;
  tableAria: string;
  headers: readonly [string, string, string, string, string, string, string];
  emptyTitle: string;
  emptyBody: string;
  notSet: string;
  sourceBuiltin: string;
  sourceCustomWithFallback: string;
  sourceCustomOnly: string;
  customize: string;
  edit: string;
  reset: string;
  delete: string;
  editor: {
    addTitle: string;
    editTitle: string;
    modelKey: string;
    modelKeyDescription: string;
    inputRate: string;
    outputRate: string;
    cacheReadRate: string;
    cacheWriteRate: string;
    rateDescription: string;
    cacheDescription: string;
    draftValues: string;
    latestValues: string;
    latestMissing: string;
    cancel: string;
    save: string;
    saveAgain: string;
    saving: string;
  };
  validation(field: PricingDraftField, error: PricingDraftError): string;
  confirm: {
    resetTitle: string;
    deleteTitle: string;
    resetDescription(modelKey: string): string;
    deleteDescription(modelKey: string): string;
    reviewDescription(modelKey: string, action: 'reset' | 'delete'): string;
    cancel: string;
    confirmAgain: string;
  };
  notice: {
    loadFailed: string;
    loadFailedDescription(detail: string): string;
    saved: string;
    unchanged: string;
    savedRefreshFailed: string;
    savedRefreshFailedDescription: string;
    synchronizedConflict: string;
    synchronizedUnknown: string;
    reviewConflict: string;
    reviewUnknown: string;
    reconciliationUnavailable: string;
    reconciliationUnavailableDescription: string;
    staleSnapshot: string;
    staleSnapshotDescription: string;
    mutationFailed: string;
    mutationFailedDescription(detail: string): string;
    refreshed: string;
    refreshedForReview: string;
    deleteNoLongerApplies: string;
    reviewDelete: string;
    pending: string;
  };
};

const SETTINGS_PRICING_COPY = {
  zh: {
    heading: '定价配置',
    description: '单位为 USD / 百万 Token。修改适用于之后新激活的模型工作；正在运行的 Run 保持启动时的价格。',
    disclaimer: '历史费用不会重算；最终账单以模型供应商为准。',
    refresh: '刷新定价',
    refreshing: '正在刷新定价',
    addPrice: '添加价格',
    loading: '正在加载生效价格…',
    tableAria: '生效模型定价',
    headers: ['模型 Key', '来源', '输入', '输出', '缓存读取', '缓存写入', '操作'],
    emptyTitle: '暂无生效价格',
    emptyBody: '添加精确的 Runtime 模型 Key，为之后新激活的模型工作设置价格。',
    notSet: '未设置 · Maka 估算不计缓存费用',
    sourceBuiltin: '内置',
    sourceCustomWithFallback: '自定义 · 有内置回退',
    sourceCustomOnly: '仅自定义',
    customize: '自定义',
    edit: '编辑',
    reset: '恢复',
    delete: '删除',
    editor: {
      addTitle: '添加模型价格',
      editTitle: '编辑模型价格',
      modelKey: '模型 Key',
      modelKeyDescription: '填写 Runtime 精确查找 Key，例如 openai:gpt-4o。Key 区分大小写，不要填写连接 slug。',
      inputRate: '输入 / 1M Token',
      outputRate: '输出 / 1M Token',
      cacheReadRate: '缓存读取 / 1M Token',
      cacheWriteRate: '缓存写入 / 1M Token',
      rateDescription: '必填，有限且不小于 0。',
      cacheDescription: '可选；留空表示未设置，填写 0 表示显式零费率。',
      draftValues: '草稿',
      latestValues: '当前权威值',
      latestMissing: '当前没有这个 Key',
      cancel: '取消',
      save: '保存',
      saveAgain: '复核后保存',
      saving: '正在保存定价',
    },
    validation: (field, error) => {
      if (error === 'required') return '此费率为必填项';
      if (error === 'invalid_rate') return '请输入有限且不小于 0 的数字';
      if (error === 'model_key_empty') return '模型 Key 不能为空';
      if (error === 'model_key_too_long') return '模型 Key 最多 128 个字符';
      if (error === 'duplicate_model_key') return '这个 Key 已存在，请从列表中编辑或自定义';
      return field === 'modelKey' ? '模型 Key 无效' : '费率无效';
    },
    confirm: {
      resetTitle: '恢复内置价格？',
      deleteTitle: '删除自定义价格？',
      resetDescription: (modelKey) => `将删除 ${modelKey} 的 override。之后新激活的模型工作会恢复内置价格；正在运行的工作保持启动时的价格。`,
      deleteDescription: (modelKey) => `将删除 ${modelKey} 的 override。之后新激活的模型工作会变为未定价，而不是 $0；正在运行的工作保持启动时的价格。`,
      reviewDescription: (modelKey, action) => `${modelKey} 的当前权威状态已经变化。请核对最新列表，再次确认${action === 'reset' ? '恢复' : '删除'}。`,
      cancel: '取消',
      confirmAgain: '再次确认',
    },
    notice: {
      loadFailed: '无法加载定价',
      loadFailedDescription: (detail) => `Runtime Host 没有返回生效价格。${detail}`,
      saved: '定价已保存并重新加载',
      unchanged: '定价未发生变化，当前列表已重新加载',
      savedRefreshFailed: '保存已完成，但最新定价未能加载',
      savedRefreshFailedDescription: '草稿已保留，旧列表已隐藏。刷新成功前不会发送新的写入。',
      synchronizedConflict: '其他更改已经产生了相同结果，未重复写入',
      synchronizedUnknown: '当前权威状态与草稿一致；无法判断是哪次命令完成了写入',
      reviewConflict: '定价已被其他更改更新，请对照最新值后再次保存',
      reviewUnknown: '写入结果无法确定，最新权威状态与草稿不同；请复核后再决定是否保存',
      reconciliationUnavailable: '暂时无法核对写入结果',
      reconciliationUnavailableDescription: '草稿已保留，旧列表已隐藏。请先刷新权威状态，不会自动重发写入。',
      staleSnapshot: 'Runtime Host 连接已经变化',
      staleSnapshotDescription: '草稿已保留。请刷新并核对新连接返回的价格后再保存。',
      mutationFailed: '定价未保存',
      mutationFailedDescription: (detail) => `Runtime Host 拒绝了这次操作。${detail}`,
      refreshed: '已加载最新生效价格',
      refreshedForReview: '已加载最新价格，草稿仍保留，请复核后保存',
      deleteNoLongerApplies: '该 override 已不存在；已显示最新生效价格，不会发送无效删除',
      reviewDelete: '复核待处理操作',
      pending: '正在提交定价更改',
    },
  },
  en: {
    heading: 'Pricing',
    description: 'USD per 1M tokens. Changes apply to newly activated model work; an active run keeps its starting prices.',
    disclaimer: 'Historical costs are not recalculated. Provider billing is authoritative.',
    refresh: 'Refresh pricing',
    refreshing: 'Refreshing pricing',
    addPrice: 'Add price',
    loading: 'Loading effective prices…',
    tableAria: 'Effective model pricing',
    headers: ['Model key', 'Source', 'Input', 'Output', 'Cache read', 'Cache write', 'Actions'],
    emptyTitle: 'No effective prices',
    emptyBody: 'Add an exact Runtime model key to price newly activated model work.',
    notSet: 'Not set · no cache charge in Maka estimates',
    sourceBuiltin: 'Built-in',
    sourceCustomWithFallback: 'Custom · built-in fallback',
    sourceCustomOnly: 'Custom-only',
    customize: 'Customize',
    edit: 'Edit',
    reset: 'Reset',
    delete: 'Delete',
    editor: {
      addTitle: 'Add model price',
      editTitle: 'Edit model price',
      modelKey: 'Model key',
      modelKeyDescription: 'Enter the exact Runtime lookup key, such as openai:gpt-4o. Keys are case-sensitive; do not use a connection slug.',
      inputRate: 'Input / 1M tokens',
      outputRate: 'Output / 1M tokens',
      cacheReadRate: 'Cache read / 1M tokens',
      cacheWriteRate: 'Cache write / 1M tokens',
      rateDescription: 'Required, finite, and at least 0.',
      cacheDescription: 'Optional. Blank means not set; 0 is an explicit zero rate.',
      draftValues: 'Draft',
      latestValues: 'Current authority',
      latestMissing: 'This key is not currently priced',
      cancel: 'Cancel',
      save: 'Save',
      saveAgain: 'Save after review',
      saving: 'Saving pricing',
    },
    validation: (field, error) => {
      if (error === 'required') return 'This rate is required';
      if (error === 'invalid_rate') return 'Enter a finite number that is at least 0';
      if (error === 'model_key_empty') return 'Model key cannot be empty';
      if (error === 'model_key_too_long') return 'Model key must be 128 characters or fewer';
      if (error === 'duplicate_model_key') return 'This key already exists; edit or customize it from the list';
      return field === 'modelKey' ? 'Invalid model key' : 'Invalid rate';
    },
    confirm: {
      resetTitle: 'Restore built-in pricing?',
      deleteTitle: 'Delete custom pricing?',
      resetDescription: (modelKey) => `This deletes the override for ${modelKey}. Newly activated work will use built-in pricing; active work keeps its starting prices.`,
      deleteDescription: (modelKey) => `This deletes the override for ${modelKey}. Newly activated work becomes unpriced, not $0; active work keeps its starting prices.`,
      reviewDescription: (modelKey, action) => `Current authority for ${modelKey} changed. Review the latest list, then confirm ${action === 'reset' ? 'reset' : 'delete'} again.`,
      cancel: 'Cancel',
      confirmAgain: 'Confirm again',
    },
    notice: {
      loadFailed: 'Pricing could not be loaded',
      loadFailedDescription: (detail) => `The Runtime Host did not return effective prices. ${detail}`,
      saved: 'Pricing saved and reloaded',
      unchanged: 'Pricing was unchanged and the current list was reloaded',
      savedRefreshFailed: 'The save completed, but current pricing could not be loaded',
      savedRefreshFailedDescription: 'The draft is preserved and the old list is hidden. No new write will be sent until refresh succeeds.',
      synchronizedConflict: 'Another change already produced the same result; no write was replayed',
      synchronizedUnknown: 'Current authority matches the draft; Maka cannot tell which command completed the write',
      reviewConflict: 'Pricing changed elsewhere. Compare the latest value before saving again',
      reviewUnknown: 'The write outcome is unknown and current authority differs from the draft. Review before deciding whether to save again',
      reconciliationUnavailable: 'The write outcome cannot be reconciled yet',
      reconciliationUnavailableDescription: 'The draft is preserved and the old list is hidden. Refresh authority first; the write will not be replayed automatically.',
      staleSnapshot: 'The Runtime Host connection changed',
      staleSnapshotDescription: 'The draft is preserved. Refresh and review pricing from the new connection before saving.',
      mutationFailed: 'Pricing was not saved',
      mutationFailedDescription: (detail) => `The Runtime Host rejected this operation. ${detail}`,
      refreshed: 'Latest effective pricing loaded',
      refreshedForReview: 'Latest pricing loaded. The draft is preserved for review',
      deleteNoLongerApplies: 'The override no longer exists. Current effective pricing is shown; no invalid delete will be sent',
      reviewDelete: 'Review pending action',
      pending: 'Submitting pricing changes',
    },
  },
} satisfies UiCatalog<PricingSettingsCopy>;

export function getPricingSettingsCopy(locale: UiLocale): PricingSettingsCopy {
  return SETTINGS_PRICING_COPY[locale];
}
