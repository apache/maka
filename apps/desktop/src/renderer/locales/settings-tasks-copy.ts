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
 * Restoring and deleting a single task speak through the rail's own row
 * actions, so their confirms and toasts are not repeated here. What is left is
 * the page's own vocabulary: finding a task, and clearing a set of them.
 */
export type SettingsTasksCopy = {
  listAria: string;
  noProject: string;
  deletedParent: string;
  /** Row detail: when the task was archived, from a compact timestamp. */
  archivedAt(when: string): string;
  /** Row detail for a task archived before the time was recorded. */
  archiveTimeUnknown: string;
  searchLabel: string;
  ageFilterLabel: string;
  ageAny: string;
  /** Age filter entry: archived more than this many days ago. */
  ageOlderThan(days: number): string;
  projectFilterLabel: string;
  allProjects: string;
  /** Under an age filter: rows left out because their archive time is unknown. */
  unknownArchiveTimeExcluded(count: number): string;
  purgeAll: string;
  /** The bulk delete while a search or filter narrows the list. */
  purgeShown(count: number): string;
  purgeAllConfirmTitle(count: number): string;
  purgeShownConfirmTitle(count: number): string;
  purgeConfirmBody: string;
  /**
   * Appended to the purge confirm when the Host could not preview it: a bulk
   * delete keeps linked subtasks all the same.
   */
  purgeSubtaskNote: string;
  /** Preview: Agent Graph subtasks, which are deleted with their task. */
  purgeGraphSubtaskNote(count: number): string;
  /** Preview: subagent worktrees the delete removes. */
  purgeWorktreeNote(count: number): string;
  /** Preview: ordinary subtasks the delete keeps and moves to the archive. */
  purgeArchivableNote(count: number): string;
  /** Preview: an estimate of the task data the delete removes. */
  purgeSizeNote(size: string): string;
  purgeConfirmAction: string;
  purgedToast(count: number): string;
  /** Toast suffix after a purge that moved linked subtasks to the archive. */
  purgedSubtaskNote(count: number): string;
  /**
   * Tasks a sweep kept because they were restored while it ran. Reads after
   * either outcome, so a sweep never has to choose between reporting a failure
   * and reporting what it deliberately left alone.
   */
  purgeKeptRestored(count: number): string;
  /** Tasks the Host kept: by its clock, archived too recently for the age filter. */
  purgeKeptTooRecent(count: number): string;
  purgeFailedTitle: string;
  purgeFailedBody(count: number): string;
  purgeUnverified: string;
  noMatchTitle: string;
  noMatchBody: string;
  unarchive: string;
  unarchiveTask(name: string): string;
  delete: string;
  deleteTask(name: string): string;
  emptyTitle: string;
  emptyBody: string;
};

const SETTINGS_TASKS_COPY_BY_LOCALE = {
  'zh-CN': {
    listAria: '已归档任务',
    noProject: '无项目',
    deletedParent: '原父任务已删除',
    archivedAt: (when: string) => `${when}归档`,
    archiveTimeUnknown: '归档时间未知',
    searchLabel: '搜索已归档任务',
    ageFilterLabel: '归档时间',
    ageAny: '任何时间',
    ageOlderThan: (days: number) => `超过 ${days} 天`,
    projectFilterLabel: '项目',
    allProjects: '全部项目',
    unknownArchiveTimeExcluded: (count: number) =>
      `另有 ${count} 条任务归档时间未知，未包含在内。`,
    purgeAll: '清空全部',
    purgeShown: (count: number) => `删除显示的 ${count} 条`,
    purgeAllConfirmTitle: (count: number) => `清空全部 ${count} 条已归档任务？`,
    purgeShownConfirmTitle: (count: number) => `删除当前显示的 ${count} 条任务？`,
    purgeConfirmBody: '这些任务及其全部消息会被永久删除，无法撤销。',
    purgeSubtaskNote: '其中的普通子任务不会被删除，将保留并移入归档。',
    purgeGraphSubtaskNote: (count: number) => `${count} 个 Agent Graph 子任务将一并删除。`,
    purgeWorktreeNote: (count: number) => `${count} 个子代理工作树将被移除。`,
    purgeArchivableNote: (count: number) =>
      `${count} 个普通子任务不会被删除，将保留并移入归档。`,
    purgeSizeNote: (size: string) => `任务数据约 ${size}（估算值）。`,
    purgeConfirmAction: '永久删除',
    purgedToast: (count: number) => `已删除 ${count} 条任务`,
    purgedSubtaskNote: (count: number) => `${count} 个子任务已移入归档`,
    purgeKeptRestored: (count: number) => `另有 ${count} 条在此期间被恢复，已保留。`,
    purgeKeptTooRecent: (count: number) => `另有 ${count} 条归档时间未达所选期限，已保留。`,
    purgeFailedTitle: '删除任务失败',
    purgeFailedBody: (count: number) => `${count} 条仍在，请重试。`,
    purgeUnverified: '任务已删除，但无法读取列表确认结果。请重新打开本页查看。',
    noMatchTitle: '没有匹配的任务',
    noMatchBody: '换个关键词或筛选条件试试。',
    unarchive: '取消归档',
    unarchiveTask: (name: string) => `取消归档「${name}」`,
    delete: '彻底删除',
    deleteTask: (name: string) => `彻底删除「${name}」`,
    emptyTitle: '没有已归档的任务',
    emptyBody: '在侧栏里归档一个任务后，可以在这里恢复或彻底删除它。',
  },
  'zh-TW': {
    listAria: '已歸檔任務',
    noProject: '無專案',
    deletedParent: '原父任務已刪除',
    archivedAt: (when: string) => `${when}歸檔`,
    archiveTimeUnknown: '歸檔時間未知',
    searchLabel: '搜尋已歸檔任務',
    ageFilterLabel: '歸檔時間',
    ageAny: '任何時間',
    ageOlderThan: (days: number) => `超過 ${days} 天`,
    projectFilterLabel: '專案',
    allProjects: '全部專案',
    unknownArchiveTimeExcluded: (count: number) =>
      `另有 ${count} 條任務歸檔時間未知，未包含在內。`,
    purgeAll: '清空全部',
    purgeShown: (count: number) => `刪除顯示的 ${count} 條`,
    purgeAllConfirmTitle: (count: number) => `清空全部 ${count} 條已歸檔任務？`,
    purgeShownConfirmTitle: (count: number) => `刪除目前顯示的 ${count} 條任務？`,
    purgeConfirmBody: '這些任務及其全部訊息會被永久刪除，無法撤銷。',
    purgeSubtaskNote: '其中的普通子任務不會被刪除，將保留並移入歸檔。',
    purgeGraphSubtaskNote: (count: number) => `${count} 個 Agent Graph 子任務將一併刪除。`,
    purgeWorktreeNote: (count: number) => `${count} 個子代理工作樹將被移除。`,
    purgeArchivableNote: (count: number) =>
      `${count} 個普通子任務不會被刪除，將保留並移入歸檔。`,
    purgeSizeNote: (size: string) => `任務資料約 ${size}（估算值）。`,
    purgeConfirmAction: '永久刪除',
    purgedToast: (count: number) => `已刪除 ${count} 條任務`,
    purgedSubtaskNote: (count: number) => `${count} 個子任務已移入歸檔`,
    purgeKeptRestored: (count: number) => `另有 ${count} 條在此期間被恢復，已保留。`,
    purgeKeptTooRecent: (count: number) => `另有 ${count} 條歸檔時間未達所選期限，已保留。`,
    purgeFailedTitle: '刪除任務失敗',
    purgeFailedBody: (count: number) => `${count} 條仍在，請重試。`,
    purgeUnverified: '任務已刪除，但無法讀取列表確認結果。請重新開啟本頁檢視。',
    noMatchTitle: '沒有符合的任務',
    noMatchBody: '換個關鍵詞或篩選條件試試。',
    unarchive: '取消歸檔',
    unarchiveTask: (name: string) => `取消歸檔「${name}」`,
    delete: '徹底刪除',
    deleteTask: (name: string) => `徹底刪除「${name}」`,
    emptyTitle: '沒有已歸檔的任務',
    emptyBody: '在側欄裡歸檔一個任務後，可以在這裡恢復或徹底刪除它。',
  },
  en: {
    listAria: 'Archived tasks',
    noProject: 'No project',
    deletedParent: 'Parent task deleted',
    archivedAt: (when: string) => `Archived ${when}`,
    archiveTimeUnknown: 'Archive time unknown',
    searchLabel: 'Search archived tasks',
    ageFilterLabel: 'Archived',
    ageAny: 'Any time',
    ageOlderThan: (days: number) => `More than ${days} days`,
    projectFilterLabel: 'Project',
    allProjects: 'All projects',
    unknownArchiveTimeExcluded: (count: number) =>
      count === 1
        ? '1 task with an unknown archive time is not included.'
        : `${count} tasks with an unknown archive time are not included.`,
    purgeAll: 'Clear all',
    purgeShown: (count: number) => `Delete ${count} shown`,
    purgeAllConfirmTitle: (count: number) =>
      count === 1 ? 'Clear the 1 archived task?' : `Clear all ${count} archived tasks?`,
    purgeShownConfirmTitle: (count: number) =>
      count === 1 ? 'Delete the 1 task shown?' : `Delete the ${count} tasks shown?`,
    purgeConfirmBody:
      'The tasks and all of their messages are removed permanently. This cannot be undone.',
    purgeSubtaskNote: 'Any ordinary subtasks are kept and moved to Archived.',
    purgeGraphSubtaskNote: (count: number) =>
      count === 1
        ? '1 Agent Graph subtask is deleted with them.'
        : `${count} Agent Graph subtasks are deleted with them.`,
    purgeWorktreeNote: (count: number) =>
      count === 1 ? '1 subagent worktree is removed.' : `${count} subagent worktrees are removed.`,
    purgeArchivableNote: (count: number) =>
      count === 1
        ? '1 ordinary subtask is kept and moved to Archived.'
        : `${count} ordinary subtasks are kept and moved to Archived.`,
    purgeSizeNote: (size: string) => `About ${size} of task data (an estimate).`,
    purgeConfirmAction: 'Delete permanently',
    purgedToast: (count: number) => (count === 1 ? 'Deleted 1 task' : `Deleted ${count} tasks`),
    purgedSubtaskNote: (count: number) =>
      count === 1 ? '1 subtask moved to Archived' : `${count} subtasks moved to Archived`,
    purgeKeptTooRecent: (count: number) =>
      count === 1
        ? '1 more was archived too recently for the chosen age and kept.'
        : `${count} more were archived too recently for the chosen age and kept.`,
    purgeKeptRestored: (count: number) =>
      count === 1
        ? '1 more was restored meanwhile and kept.'
        : `${count} more were restored meanwhile and kept.`,
    purgeFailedTitle: 'Could not delete the tasks',
    purgeFailedBody: (count: number) =>
      count === 1 ? '1 task is still there. Try again.' : `${count} tasks are still there. Try again.`,
    purgeUnverified: 'The tasks were deleted, but the list could not be read back to confirm. Reopen this page to check.',
    noMatchTitle: 'No matching tasks',
    noMatchBody: 'Try a different search or filter.',
    unarchive: 'Unarchive',
    unarchiveTask: (name: string) => `Unarchive ${name}`,
    delete: 'Delete',
    deleteTask: (name: string) => `Delete ${name}`,
    emptyTitle: 'Nothing archived',
    emptyBody: 'Archive a task from the rail to restore or permanently delete it here.',
  },
} satisfies UiCatalog<SettingsTasksCopy>;

export function getSettingsTasksCopy(locale: UiLocale): SettingsTasksCopy {
  return SETTINGS_TASKS_COPY_BY_LOCALE[locale];
}
