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

export type PricingSettingsCopy = {
  title: string;
  subtitle: string;
  refresh: string;
  add: string;
  loading: string;
  loadFailedTitle: string;
  loadFailedBody: string;
  retry: string;
  emptyTitle: string;
  emptyBody: string;
  tableAria: string;
  // catalog picker (Add flow)
  catalogPickerLabel: string;
  catalogPickerPlaceholder: string;
  catalogEmptyResults: string;
  manualEntryToggle: string;
  catalogToggle: string;
  builtinPrefillHint: string;
  headers: readonly [string, string, string, string, string, string];
  actionsHeader: string;
  sourceBuiltin: string;
  sourceCustomFallback: string;
  sourceCustomOnly: string;
  cacheNotSet: string;
  edit: string;
  reset: string;
  delete: string;
  editAria(modelKey: string): string;
  resetAria(modelKey: string): string;
  deleteAria(modelKey: string): string;
  // editor
  addTitle: string;
  editTitle: string;
  providerLabel: string;
  providerPlaceholder: string;
  modelLabel: string;
  modelPlaceholder: string;
  keyHelp: string;
  inputLabel: string;
  outputLabel: string;
  rateHelp: string;
  cacheSection: string;
  cacheReadLabel: string;
  cacheWriteLabel: string;
  cacheHelp: string;
  cancel: string;
  save: string;
  // field errors
  errorRequired: string;
  errorInvalidRate: string;
  errorKeyTooLong: string;
  errorDuplicate: string;
  // outcomes
  saved: string;
  synchronized: string;
  conflictTitle: string;
  conflictTitleUnknown: string;
  conflictBody: string;
  conflictBodyUnknown: string;
  conflictLatest(input: string, output: string): string;
  reviewSave: string;
  refreshFailedTitle: string;
  refreshFailedBody: string;
  reconcileTitle: string;
  reconcileBody: string;
  writeBlockedReason: string;
  saveFailed: string;
  // reset / delete confirm
  resetTitle: string;
  resetBody(modelKey: string): string;
  deleteTitle: string;
  deleteBody(modelKey: string): string;
  confirmReset: string;
  confirmDelete: string;
  resetFailed: string;
  resetDone: string;
};

const SETTINGS_PRICING_COPY = {
  zh: {
    title: '定价配置',
    subtitle:
      '美元 / 每百万 token。用于新激活的模型调用；进行中的运行沿用其开始时的价格。历史费用不会重算，最终以供应商结算为准。',
    refresh: '刷新',
    add: '添加定价',
    loading: '正在加载定价…',
    loadFailedTitle: '无法加载定价',
    loadFailedBody: '读取运行时主机的定价快照失败，请重试。',
    retry: '重试',
    emptyTitle: '暂无自定义定价',
    emptyBody: '尚未覆盖任何模型价格。点击「添加定价」，从内置目录中选择一个模型。',
    tableAria: '自定义模型定价表',
    catalogPickerLabel: '选择模型',
    catalogPickerPlaceholder: '搜索模型名…',
    catalogEmptyResults: '无匹配的内置模型',
    manualEntryToggle: '模型不在列表中？手动输入',
    catalogToggle: '从目录选择',
    builtinPrefillHint: '已按内置价预填，可按需修改。',
    headers: ['模型', '来源', '输入 / 1M', '输出 / 1M', '缓存读 / 1M', '缓存写 / 1M'],
    actionsHeader: '操作',
    sourceBuiltin: '内置',
    sourceCustomFallback: '自定义 · 可回退',
    sourceCustomOnly: '仅自定义',
    cacheNotSet: '未设置（Maka 估算不计缓存费用）',
    edit: '编辑',
    reset: '重置',
    delete: '删除',
    editAria: (modelKey: string) => `编辑「${modelKey}」定价`,
    resetAria: (modelKey: string) => `重置「${modelKey}」定价`,
    deleteAria: (modelKey: string) => `删除「${modelKey}」定价`,
    addTitle: '添加定价',
    editTitle: '编辑定价',
    providerLabel: '供应商',
    providerPlaceholder: '例如 anthropic',
    modelLabel: '模型',
    modelPlaceholder: '例如 claude-sonnet-4-5',
    keyHelp: '这是运行时的精确查找键，需与用量记录中的供应商与模型 ID 完全一致（区分大小写，不要用连接别名）。',
    inputLabel: '输入价格',
    outputLabel: '输出价格',
    rateHelp: '美元 / 每百万 token；0 表示免费（如本地模型）。',
    cacheSection: '缓存价格（可选）',
    cacheReadLabel: '缓存读取',
    cacheWriteLabel: '缓存写入',
    cacheHelp: '留空表示未设置（不计缓存费用），与显式填 0 不同。',
    cancel: '取消',
    save: '保存',
    errorRequired: '必填',
    errorInvalidRate: '请输入有效价格（≥ 0）',
    errorKeyTooLong: '模型键过长（上限 128 字符）',
    errorDuplicate: '该模型已在列表中，请直接编辑对应行',
    saved: '定价已保存',
    synchronized: '当前定价已与你的修改一致',
    conflictTitle: '定价已被其他修改更新',
    conflictTitleUnknown: '无法确认上次修改的结果',
    conflictBody: '该模型的价格已被其他修改更新。请核对最新值后，基于最新版本再次保存。',
    conflictBodyUnknown: '上次修改可能已生效、也可能未生效。请核对最新值后，再决定是否基于最新版本重新保存。',
    conflictLatest: (input: string, output: string) => `当前最新：输入 ${input} / 输出 ${output}`,
    reviewSave: '核对并保存',
    refreshFailedTitle: '已保存，但无法加载最新定价',
    refreshFailedBody: '保存已完成，但未能读取最新定价。请刷新后再进行修改。',
    reconcileTitle: '无法确认结果',
    reconcileBody: '未能确认这次修改的结果。请刷新定价后再进行修改。',
    writeBlockedReason: '需先刷新最新定价后才能修改。',
    saveFailed: '保存定价失败',
    resetTitle: '重置定价',
    resetBody: (modelKey: string) => `将删除「${modelKey}」的自定义价格，恢复为内置定价。`,
    deleteTitle: '删除定价',
    deleteBody: (modelKey: string) =>
      `将删除「${modelKey}」的定价；新激活的调用将变为未定价（不计入 Maka 的费用估算，与显式填 0 不同），进行中的运行沿用其开始时的快照。`,
    confirmReset: '重置',
    confirmDelete: '删除',
    resetFailed: '操作失败',
    resetDone: '已更新定价',
  },
  en: {
    title: 'Pricing',
    subtitle:
      'USD per 1M tokens. Applies to newly activated model work; an active run keeps its starting prices. Historical costs are not recalculated. Provider billing is authoritative.',
    refresh: 'Refresh',
    add: 'Add price',
    loading: 'Loading pricing…',
    loadFailedTitle: 'Could not load pricing',
    loadFailedBody: 'Reading the Runtime Host pricing snapshot failed. Try again.',
    retry: 'Retry',
    emptyTitle: 'No custom pricing',
    emptyBody:
      'You haven’t overridden any model prices yet. Click "Add price" and pick a model from the built-in catalog.',
    tableAria: 'Custom model pricing table',
    catalogPickerLabel: 'Select model',
    catalogPickerPlaceholder: 'Search models…',
    catalogEmptyResults: 'No matching built-in models',
    manualEntryToggle: 'Model not listed? Enter it manually',
    catalogToggle: 'Choose from catalog',
    builtinPrefillHint: 'Pre-filled with the built-in price; adjust as needed.',
    headers: ['Model', 'Source', 'Input / 1M', 'Output / 1M', 'Cache read / 1M', 'Cache write / 1M'],
    actionsHeader: 'Actions',
    sourceBuiltin: 'Built-in',
    sourceCustomFallback: 'Custom · has fallback',
    sourceCustomOnly: 'Custom-only',
    cacheNotSet: 'Not set (no cache charge in Maka estimates)',
    edit: 'Edit',
    reset: 'Reset',
    delete: 'Delete',
    editAria: (modelKey: string) => `Edit pricing for ${modelKey}`,
    resetAria: (modelKey: string) => `Reset pricing for ${modelKey}`,
    deleteAria: (modelKey: string) => `Delete pricing for ${modelKey}`,
    addTitle: 'Add price',
    editTitle: 'Edit price',
    providerLabel: 'Provider',
    providerPlaceholder: 'e.g. anthropic',
    modelLabel: 'Model',
    modelPlaceholder: 'e.g. claude-sonnet-4-5',
    keyHelp:
      'This is the exact Runtime lookup key. Match the provider and model IDs from your usage records exactly (case-sensitive; not the connection slug).',
    inputLabel: 'Input price',
    outputLabel: 'Output price',
    rateHelp: 'USD per 1M tokens; 0 means free (e.g. local models).',
    cacheSection: 'Cache prices (optional)',
    cacheReadLabel: 'Cache read',
    cacheWriteLabel: 'Cache write',
    cacheHelp: 'Leave blank for "Not set" (no cache charge) — distinct from an explicit 0.',
    cancel: 'Cancel',
    save: 'Save',
    errorRequired: 'Required',
    errorInvalidRate: 'Enter a valid price (≥ 0)',
    errorKeyTooLong: 'Model key is too long (128 characters max)',
    errorDuplicate: 'This model is already listed — edit its row instead',
    saved: 'Pricing saved',
    synchronized: 'Pricing already matches your change',
    conflictTitle: 'Pricing changed elsewhere',
    conflictTitleUnknown: "Couldn't confirm the last change",
    conflictBody: "This model's price was changed elsewhere. Review the latest value, then save again against the latest revision.",
    conflictBodyUnknown: 'The last change may or may not have applied. Review the latest value, then decide whether to save again against the latest revision.',
    conflictLatest: (input: string, output: string) => `Latest: input ${input} / output ${output}`,
    reviewSave: 'Review & save',
    refreshFailedTitle: 'Saved, but the latest pricing could not be loaded',
    refreshFailedBody: 'The save completed but the latest prices could not be loaded. Refresh before changing pricing again.',
    reconcileTitle: "Couldn't confirm the result",
    reconcileBody: "The result of this change could not be confirmed. Reload pricing before changing it again.",
    writeBlockedReason: 'Refresh the latest pricing before making changes.',
    saveFailed: 'Failed to save pricing',
    resetTitle: 'Reset pricing',
    resetBody: (modelKey: string) => `This removes the custom price for ${modelKey} and restores its built-in pricing.`,
    deleteTitle: 'Delete pricing',
    deleteBody: (modelKey: string) =>
      `This deletes pricing for ${modelKey}; newly activated work becomes unpriced (excluded from Maka's cost estimates — distinct from an explicit $0), while an active run keeps its starting snapshot.`,
    confirmReset: 'Reset',
    confirmDelete: 'Delete',
    resetFailed: 'Action failed',
    resetDone: 'Pricing updated',
  },
} satisfies UiCatalog<PricingSettingsCopy>;

export function getPricingSettingsCopy(locale: UiLocale): PricingSettingsCopy {
  return SETTINGS_PRICING_COPY[locale];
}
