import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

/**
 * Restoring and deleting a single task speak through the rail's own row
 * actions, so their confirms and toasts are not repeated here. What is left is
 * the page's own vocabulary: finding a task, and clearing a set of them.
 */
export type SettingsTasksCopy = {
  listAria: string;
  noProject: string;
  searchLabel: string;
  purgeAll: string;
  purgeMatches(count: number): string;
  purgeAllConfirmTitle(count: number): string;
  purgeMatchesConfirmTitle(count: number): string;
  purgeConfirmBody: string;
  purgeConfirmAction: string;
  purgedToast(count: number): string;
  /** A sweep that left tasks alone because they were restored while it ran. */
  purgedWithRestoredToast(removed: number, restored: number): string;
  purgeFailedTitle: string;
  purgeFailedBody(count: number): string;
  purgeUnverified: string;
  noMatchTitle: string;
  noMatchBody: string;
  moreActions(name: string): string;
  restore: string;
  restoreTask(name: string): string;
  delete: string;
  emptyTitle: string;
  emptyBody: string;
};

const SETTINGS_TASKS_COPY_BY_LOCALE = {
  zh: {
    listAria: '已归档任务',
    noProject: '无项目',
    searchLabel: '搜索已归档任务',
    purgeAll: '清空全部',
    purgeMatches: (count: number) => `删除这 ${count} 条`,
    purgeAllConfirmTitle: (count: number) => `清空全部 ${count} 条已归档任务？`,
    purgeMatchesConfirmTitle: (count: number) => `删除搜索到的 ${count} 条任务？`,
    purgeConfirmBody: '这些任务及其全部消息会被永久删除，无法撤销。',
    purgeConfirmAction: '永久删除',
    purgedToast: (count: number) => `已删除 ${count} 条任务`,
    purgedWithRestoredToast: (removed: number, restored: number) =>
      `已删除 ${removed} 条任务，${restored} 条已被恢复，予以保留`,
    purgeFailedTitle: '删除任务失败',
    purgeFailedBody: (count: number) => `${count} 条仍在，请重试。`,
    purgeUnverified: '任务已删除，但无法读取列表确认结果。请重新打开本页查看。',
    noMatchTitle: '没有匹配的任务',
    noMatchBody: '换个关键词试试。',
    moreActions: (name: string) => `「${name}」的更多操作`,
    restore: '恢复',
    restoreTask: (name: string) => `恢复「${name}」`,
    delete: '彻底删除',
    emptyTitle: '没有已归档的任务',
    emptyBody: '在侧栏里归档一个任务后，可以在这里恢复或彻底删除它。',
  },
  en: {
    listAria: 'Archived tasks',
    noProject: 'No project',
    searchLabel: 'Search archived tasks',
    purgeAll: 'Clear all',
    purgeMatches: (count: number) => (count === 1 ? 'Delete this 1' : `Delete these ${count}`),
    purgeAllConfirmTitle: (count: number) =>
      count === 1 ? 'Clear the 1 archived task?' : `Clear all ${count} archived tasks?`,
    purgeMatchesConfirmTitle: (count: number) =>
      count === 1 ? 'Delete the 1 task you searched for?' : `Delete the ${count} tasks you searched for?`,
    purgeConfirmBody:
      'The tasks and all of their messages are removed permanently. This cannot be undone.',
    purgeConfirmAction: 'Delete permanently',
    purgedToast: (count: number) => (count === 1 ? 'Deleted 1 task' : `Deleted ${count} tasks`),
    purgedWithRestoredToast: (removed: number, restored: number) =>
      `${removed === 1 ? 'Deleted 1 task' : `Deleted ${removed} tasks`}; ${
        restored === 1 ? '1 was restored meanwhile and kept' : `${restored} were restored meanwhile and kept`
      }`,
    purgeFailedTitle: 'Could not delete the tasks',
    purgeFailedBody: (count: number) =>
      count === 1 ? '1 task is still there. Try again.' : `${count} tasks are still there. Try again.`,
    purgeUnverified: 'The tasks were deleted, but the list could not be read back to confirm. Reopen this page to check.',
    noMatchTitle: 'No matching tasks',
    noMatchBody: 'Try a different search.',
    moreActions: (name: string) => `More actions for ${name}`,
    restore: 'Restore',
    restoreTask: (name: string) => `Restore ${name}`,
    delete: 'Delete',
    emptyTitle: 'Nothing archived',
    emptyBody: 'Archive a task from the rail to restore or permanently delete it here.',
  },
} satisfies UiCatalog<SettingsTasksCopy>;

export function getSettingsTasksCopy(locale: UiLocale): SettingsTasksCopy {
  return SETTINGS_TASKS_COPY_BY_LOCALE[locale];
}
