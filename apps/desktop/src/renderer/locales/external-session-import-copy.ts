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

/**
 * 设置 › 活动 › 导入任务.
 *
 * The source items are another agent's conversations, so they stay 对话 /
 * conversation; what lands in Maka is a 任务 / task. The page's own title and
 * one-line description live in the settings navigation copy, like every other
 * settings page's.
 */
type ExternalSessionImportCopy = {
  sourceLabel: string;
  /** Display names by adapter id. An id with no entry falls back to the id
   *  itself, which is legible enough to ship and obvious enough to fix. */
  sourceNames: Readonly<Record<string, string>>;
  includeArchived: string;
  searchLabel: string;
  searchHelp: string;
  searchPlaceholder: string;
  searchEmpty: (term: string) => string;
  loading: string;
  listAria: string;
  emptyTitle: string;
  emptyDescription: string;
  unavailableTitle: string;
  unavailableDescription: string;
  loadFailedTitle: string;
  loadFailedFallback: string;
  retry: string;
  archived: string;
  loadMore: string;
  loadingMore: string;
  duplicateNote: string;
  importedCount: (count: number) => string;
  openLatestImportedTask: string;
  openLatestImportedTaskFor: (name: string) => string;
  import: string;
  importAgain: string;
  importTask: (name: string) => string;
  importTaskAgain: (name: string) => string;
  importing: string;
  importingTask: (name: string) => string;
  importInProgressTitle: string;
  /**
   * Named, for the same reason the unconfirmed banner names its conversations:
   * the catalog is free to change while an import runs, so the row this started
   * from may already be filtered or paged away.
   */
  importInProgressDescription: (name: string) => string;
  importFailedTitle: string;
  importFailedFallback: string;
  importRecoveredTitle: string;
  importRecoveredDescription: (name: string) => string;
  importNotRecordedTitle: string;
  importNotRecordedDescription: string;
  importOutcomeUnknownTitle: string;
  /**
   * Takes the conversation names because this is the only place that can say
   * which ones to go look for — the rows they came from may have been filtered
   * or paged away by the time it renders.
   */
  importOutcomeUnknownDescription: (names: readonly string[]) => string;
  selectAllAriaLabel: string;
  /** Marked out of listed — the source's own total is not a number this page knows. */
  selectedCount: (selected: number, listed: number) => string;
  selectRowAriaLabel: (name: string) => string;
  importSelected: string;
  /** Which one of how many the batch is on, so the count means something. */
  batchProgress: (done: number, total: number) => string;
  batchDoneTitle: (imported: number) => string;
  /** Counted apart from the total: these conversations now exist twice. */
  batchDuplicated: (count: number) => string;
  batchFailed: (count: number) => string;
  batchNothingImported: string;
};

const COPY = {
  zh: {
    sourceLabel: '来源',
    sourceNames: { codex: 'Codex', 'claude-code': 'Claude Code' },
    includeArchived: '包含已归档的对话',
    searchLabel: '搜索',
    searchHelp: '匹配对话标题与项目路径。留空显示全部。',
    searchPlaceholder: '标题或路径的一部分',
    searchEmpty: (term) => `没有标题或路径包含「${term}」的对话。`,
    loading: '正在读取外部对话…',
    listAria: '可导入的对话',
    emptyTitle: '没有可导入的对话',
    emptyDescription: '当前来源中没有找到符合条件的根对话。',
    unavailableTitle: '没有检测到支持的 Agent',
    // The title already says nothing was detected, so this says what to do
    // about it instead of saying it again. It names Codex because the renderer
    // only ever learns which sources *were* detected — nothing but a copy
    // string can tell someone with none what to go install. The second half is
    // the promise that earns the permission to read another app's files.
    unavailableDescription: '在本机使用过 Codex 后，它的对话会出现在这里。Maka 只读取这些文件，不会修改。',
    loadFailedTitle: '无法读取外部对话',
    loadFailedFallback: '外部对话目录暂时无法读取，请重试。',
    retry: '重试',
    archived: '已归档',
    loadMore: '加载更多',
    loadingMore: '正在加载…',
    duplicateNote: '再次导入同一个对话会创建一个独立的任务。',
    importedCount: (count) => `已导入 ${count} 次`,
    openLatestImportedTask: '打开最近导入的任务',
    openLatestImportedTaskFor: (name) => `打开「${name}」最近导入的任务`,
    import: '导入',
    importAgain: '再次导入',
    importTask: (name) => `导入「${name}」`,
    importTaskAgain: (name) => `再次导入「${name}」`,
    importing: '正在导入…',
    importingTask: (name) => `正在导入「${name}」`,
    importInProgressTitle: '正在导入',
    importInProgressDescription: (name) => `正在导入「${name}」，完成后会直接打开这个任务。`,
    importFailedTitle: '导入失败',
    importFailedFallback: '该对话无法转换或保存。请检查来源后重试。',
    importRecoveredTitle: '已确认导入',
    importRecoveredDescription: (name) => `「${name}」导入的任务现已可用。`,
    importNotRecordedTitle: '没有发现新任务',
    importNotRecordedDescription: '没有记录到新的任务，可以安全重试。',
    importOutcomeUnknownTitle: '需要确认导入结果',
    selectAllAriaLabel: '全选或全不选',
    selectedCount: (selected, listed) => `已选 ${selected} / ${listed}`,
    selectRowAriaLabel: (name) => `选择 ${name}`,
    importSelected: '导入所选',
    batchProgress: (done, total) => `正在导入 ${done} / ${total}`,
    batchDoneTitle: (imported) => `已导入 ${imported} 个对话`,
    batchDuplicated: (count) => `其中 ${count} 个之前已导入过，现在各有两份。`,
    batchFailed: (count) => `另有 ${count} 个没能导入。`,
    batchNothingImported: '没有对话被导入。',
    importOutcomeUnknownDescription: (names) =>
      `以下对话的导入结果无法确认：${names.map((name) => `「${name}」`).join('、')}。请先在任务列表中查找，已经出现的不要再次导入。`,
  },
  en: {
    sourceLabel: 'Source',
    sourceNames: { codex: 'Codex', 'claude-code': 'Claude Code' },
    includeArchived: 'Include archived conversations',
    searchLabel: 'Search',
    searchHelp: 'Matches the conversation title and the project path. Empty shows everything.',
    searchPlaceholder: 'Part of a title or path',
    searchEmpty: (term) => `No conversation has "${term}" in its title or path.`,
    loading: 'Reading external conversations…',
    listAria: 'Conversations available to import',
    emptyTitle: 'No conversations to import',
    emptyDescription: 'No matching root conversations were found in this source.',
    unavailableTitle: 'No supported Agent detected',
    unavailableDescription:
      'Once Codex has been used on this machine, its conversations appear here. Maka only reads those files and never modifies them.',
    loadFailedTitle: 'Could not read external conversations',
    loadFailedFallback: 'The external session directory is temporarily unavailable. Try again.',
    retry: 'Retry',
    archived: 'Archived',
    loadMore: 'Load more',
    loadingMore: 'Loading…',
    duplicateNote: 'Importing the same conversation again creates an independent task.',
    importedCount: (count) => (count === 1 ? 'Imported once' : `Imported ${count} times`),
    openLatestImportedTask: 'Open latest imported task',
    openLatestImportedTaskFor: (name) => `Open the latest task imported from ${name}`,
    import: 'Import',
    importAgain: 'Import again',
    importTask: (name) => `Import ${name}`,
    importTaskAgain: (name) => `Import ${name} again`,
    importing: 'Importing…',
    importingTask: (name) => `Importing ${name}`,
    importInProgressTitle: 'Import in progress',
    importInProgressDescription: (name) =>
      `Importing “${name}”. Maka opens the task as soon as it lands.`,
    importFailedTitle: 'Import failed',
    importFailedFallback: 'This conversation could not be converted or saved. Check the source and try again.',
    importRecoveredTitle: 'Import confirmed',
    importRecoveredDescription: (name) =>
      `The imported task is available now for “${name}”.`,
    importNotRecordedTitle: 'No new task found',
    importNotRecordedDescription: 'No new task was recorded, so it is safe to retry.',
    importOutcomeUnknownTitle: 'Check the import result',
    selectAllAriaLabel: 'Select all or none',
    selectedCount: (selected, listed) => `${selected} / ${listed} selected`,
    selectRowAriaLabel: (name) => `Select ${name}`,
    importSelected: 'Import selected',
    batchProgress: (done, total) => `Importing ${done} / ${total}`,
    batchDoneTitle: (imported) => `Imported ${imported} conversations`,
    batchDuplicated: (count) =>
      `${count} of them had been imported before and now exist twice.`,
    batchFailed: (count) => `${count} more could not be imported.`,
    batchNothingImported: 'No conversation was imported.',
    importOutcomeUnknownDescription: (names) =>
      `Maka could not confirm the outcome of these imports: ${names.map((name) => `“${name}”`).join(', ')}. Look in the task list first, and do not import again anything that is already there.`,
  },
} satisfies UiCatalog<ExternalSessionImportCopy>;

export function getExternalSessionImportCopy(locale: UiLocale): ExternalSessionImportCopy {
  return COPY[locale];
}
