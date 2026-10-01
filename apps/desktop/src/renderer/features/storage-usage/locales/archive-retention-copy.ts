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

export interface ArchiveRetentionCopy {
  readonly title: string;
  /** What the setting covers, when its clock starts, what it keeps, and that it is final. */
  readonly help: string;
  readonly enable: string;
  readonly enableHelp: string;
  readonly days: string;
  readonly daysHelp: string;
  dayOption(days: number): string;
  readonly loading: string;
  readonly loadFailed: string;
  readonly saveFailed: string;
  readonly conflict: string;
  /** Nothing archived would be deleted. */
  readonly previewNone: string;
  preview(count: number, date: string): string;
  lastCleanup(count: number, size: string | undefined, date: string): string;
  needsReview(count: number): string;
  readonly paused: string;
  readonly confirmEnableTitle: string;
  readonly confirmChangeTitle: string;
  confirmDescription(days: number, count: number, date: string | undefined): string;
  readonly confirmEnable: string;
  readonly confirmChange: string;
  readonly cancel: string;
}

const COPY_BY_LOCALE = {
  'zh-CN': {
    title: '自动清理',
    help: '开启后，此运行时主机会删除归档超过所选天数的任务。适用于所有已归档任务，无论是手动还是自动归档的。计时从开启或修改天数时开始，因此不会立即删除积压的任务。已置顶的任务会保留。删除后无法恢复。',
    enable: '自动删除已归档任务',
    enableHelp: '只作用于当前运行时主机。',
    days: '归档后保留',
    daysHelp: '修改天数会重新开始计时。',
    dayOption: (days: number) => `${days} 天`,
    loading: '正在读取…',
    loadFailed: '无法读取自动清理设置',
    saveFailed: '无法更改自动清理设置',
    conflict: '设置已在别处更改，已重新读取。',
    previewNone: '目前没有会被删除的已归档任务。',
    preview: (count: number, date: string) => `涵盖 ${count} 个已归档任务，最早在 ${date} 之后删除。`,
    lastCleanup: (count: number, size: string | undefined, date: string) =>
      `上次自动清理：${date} 删除了 ${count} 个任务${size ? `（约 ${size}）` : ''}`,
    needsReview: (count: number) =>
      `${count} 个任务需要你处理：它们使用子代理工作树，或仍有进行中的子任务，请手动删除。`,
    paused: '自动清理已暂停：本机时钟早于已记录的时间。时钟追上后会自动恢复。',
    confirmEnableTitle: '开启自动清理？',
    confirmChangeTitle: '修改保留天数？',
    confirmDescription: (days: number, count: number, date: string | undefined) =>
      `已归档任务将在归档 ${days} 天后删除，计时最早从现在开始。` +
      (count > 0 && date ? `目前涵盖 ${count} 个任务，最早在 ${date} 之后删除。` : '目前没有涵盖的任务。') +
      '已置顶的任务会保留。删除后无法恢复。',
    confirmEnable: '开启',
    confirmChange: '修改',
    cancel: '取消',
  },
  'zh-TW': {
    title: '自動清理',
    help: '開啟後，此執行階段主機會刪除歸檔超過所選天數的任務。適用於所有已歸檔任務，無論是手動或自動歸檔的。計時從開啟或修改天數時開始，因此不會立即刪除積壓的任務。已置頂的任務會保留。刪除後無法復原。',
    enable: '自動刪除已歸檔任務',
    enableHelp: '只作用於目前的執行階段主機。',
    days: '歸檔後保留',
    daysHelp: '修改天數會重新開始計時。',
    dayOption: (days: number) => `${days} 天`,
    loading: '正在讀取…',
    loadFailed: '無法讀取自動清理設定',
    saveFailed: '無法變更自動清理設定',
    conflict: '設定已在別處變更，已重新讀取。',
    previewNone: '目前沒有會被刪除的已歸檔任務。',
    preview: (count: number, date: string) => `涵蓋 ${count} 個已歸檔任務，最早在 ${date} 之後刪除。`,
    lastCleanup: (count: number, size: string | undefined, date: string) =>
      `上次自動清理：${date} 刪除了 ${count} 個任務${size ? `（約 ${size}）` : ''}`,
    needsReview: (count: number) =>
      `${count} 個任務需要你處理：它們使用子代理工作樹，或仍有進行中的子任務，請手動刪除。`,
    paused: '自動清理已暫停：本機時鐘早於已記錄的時間。時鐘追上後會自動恢復。',
    confirmEnableTitle: '開啟自動清理？',
    confirmChangeTitle: '修改保留天數？',
    confirmDescription: (days: number, count: number, date: string | undefined) =>
      `已歸檔任務將在歸檔 ${days} 天後刪除，計時最早從現在開始。` +
      (count > 0 && date ? `目前涵蓋 ${count} 個任務，最早在 ${date} 之後刪除。` : '目前沒有涵蓋的任務。') +
      '已置頂的任務會保留。刪除後無法復原。',
    confirmEnable: '開啟',
    confirmChange: '修改',
    cancel: '取消',
  },
  en: {
    title: 'Automatic cleanup',
    help: 'When on, this Runtime Host deletes tasks that have been archived for longer than the period you choose. It applies to every archived task, whether you archived it or it was archived automatically. The clock starts when you turn it on or change the period, so no backlog is deleted at once. Pinned tasks are kept. Deletion is permanent.',
    enable: 'Delete archived tasks automatically',
    enableHelp: 'Applies to this Runtime Host only.',
    days: 'Keep archived tasks for',
    daysHelp: 'Changing the period restarts the clock.',
    dayOption: (days: number) => `${days} days`,
    loading: 'Loading…',
    loadFailed: 'Could not load automatic cleanup',
    saveFailed: 'Could not change automatic cleanup',
    conflict: 'The setting changed elsewhere and has been reloaded.',
    previewNone: 'No archived tasks would be deleted yet.',
    preview: (count: number, date: string) =>
      `Covers ${count === 1 ? '1 archived task' : `${count} archived tasks`}; the first can be deleted after ${date}.`,
    lastCleanup: (count: number, size: string | undefined, date: string) =>
      `Last automatic cleanup: deleted ${count === 1 ? '1 task' : `${count} tasks`}${size ? ` (about ${size})` : ''} on ${date}`,
    needsReview: (count: number) =>
      `${count === 1 ? '1 task needs' : `${count} tasks need`} review: they use a subagent worktree or have active subtasks, so delete them by hand.`,
    paused:
      'Automatic cleanup is paused: this computer’s clock reads earlier than a time already recorded. It resumes once the clock catches up.',
    confirmEnableTitle: 'Turn on automatic cleanup?',
    confirmChangeTitle: 'Change the period?',
    confirmDescription: (days: number, count: number, date: string | undefined) =>
      `Archived tasks will be deleted ${days} days after they were archived, counting from now at the earliest. ` +
      (count > 0 && date
        ? `${count === 1 ? '1 task is' : `${count} tasks are`} covered now; the first can be deleted after ${date}. `
        : 'No tasks are covered yet. ') +
      'Pinned tasks are kept. Deleted tasks cannot be restored.',
    confirmEnable: 'Turn on',
    confirmChange: 'Change',
    cancel: 'Cancel',
  },
} satisfies UiCatalog<ArchiveRetentionCopy>;

export function getArchiveRetentionCopy(locale: UiLocale): ArchiveRetentionCopy {
  return COPY_BY_LOCALE[locale];
}
