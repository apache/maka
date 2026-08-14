import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type SettingsTasksCopy = {
  listAria: string;
  noProject: string;
  searchLabel: string;
  searchPlaceholder: string;
  purge: string;
  purgeConfirmTitle(count: number): string;
  purgeConfirmBody: string;
  purgedToast(count: number): string;
  purgeFailedTitle: string;
  partialFailure(count: number): string;
  noMatchTitle: string;
  noMatchBody: string;
  moreActions(name: string): string;
  open: string;
  restore: string;
  delete: string;
  retry: string;
  loadingLabel: string;
  loadFailed: string;
  emptyTitle: string;
  emptyBody: string;
  restoredToast: string;
  restoreFailedTitle: string;
  deleteConfirmTitle(name: string): string;
  deleteConfirmBody: string;
  deleteConfirmAction: string;
  cancel: string;
  deletedToast: string;
  deleteFailedTitle: string;
};

const SETTINGS_TASKS_COPY_BY_LOCALE = {
  zh: {
    listAria: '已归档任务',
    noProject: '无项目',
    searchLabel: '搜索已归档任务',
    searchPlaceholder: '搜索已归档任务',
    purge: '清空全部',
    purgeConfirmTitle: (count: number) => `清空全部 ${count} 条已归档任务？`,
    purgeConfirmBody: '这些任务及其全部消息会被永久删除，无法撤销。',
    purgedToast: (count: number) => `已清空 ${count} 条任务`,
    purgeFailedTitle: '清空任务失败',
    partialFailure: (count: number) => `${count} 条未能完成`,
    noMatchTitle: '没有匹配的任务',
    noMatchBody: '换个关键词试试。',
    moreActions: (name: string) => `「${name}」的更多操作`,
    open: '打开',
    restore: '恢复',
    delete: '彻底删除',
    retry: '重试',
    loadingLabel: '正在载入已归档任务',
    loadFailed: '已归档任务载入失败。',
    emptyTitle: '没有已归档的任务',
    emptyBody: '在侧栏里归档一个任务后，可以在这里恢复或彻底删除它。',
    restoredToast: '任务已恢复',
    restoreFailedTitle: '恢复任务失败',
    deleteConfirmTitle: (name: string) => `彻底删除「${name}」？`,
    deleteConfirmBody: '任务及其全部消息会被永久删除，无法撤销。',
    deleteConfirmAction: '永久删除',
    cancel: '取消',
    deletedToast: '任务已删除',
    deleteFailedTitle: '删除任务失败',
  },
  en: {
    listAria: 'Archived tasks',
    noProject: 'No project',
    searchLabel: 'Search archived tasks',
    searchPlaceholder: 'Search archived tasks',
    purge: 'Clear all',
    purgeConfirmTitle: (count: number) =>
      count === 1 ? 'Clear the 1 archived task?' : `Clear all ${count} archived tasks?`,
    purgeConfirmBody:
      'The tasks and all of their messages are removed permanently. This cannot be undone.',
    purgedToast: (count: number) => (count === 1 ? 'Cleared 1 task' : `Cleared ${count} tasks`),
    purgeFailedTitle: 'Could not clear the tasks',
    partialFailure: (count: number) =>
      count === 1 ? '1 task did not finish' : `${count} tasks did not finish`,
    noMatchTitle: 'No matching tasks',
    noMatchBody: 'Try a different search.',
    moreActions: (name: string) => `More actions for ${name}`,
    open: 'Open',
    restore: 'Restore',
    delete: 'Delete',
    retry: 'Try again',
    loadingLabel: 'Loading archived tasks',
    loadFailed: 'Could not load the archived tasks.',
    emptyTitle: 'Nothing archived',
    emptyBody: 'Archive a task from the rail to restore or permanently delete it here.',
    restoredToast: 'Task restored',
    restoreFailedTitle: 'Could not restore the task',
    deleteConfirmTitle: (name: string) => `Permanently delete ${name}?`,
    deleteConfirmBody:
      'The task and all of its messages are removed permanently. This cannot be undone.',
    deleteConfirmAction: 'Delete permanently',
    cancel: 'Cancel',
    deletedToast: 'Task deleted',
    deleteFailedTitle: 'Could not delete the task',
  },
} satisfies UiCatalog<SettingsTasksCopy>;

export function getSettingsTasksCopy(locale: UiLocale): SettingsTasksCopy {
  return SETTINGS_TASKS_COPY_BY_LOCALE[locale];
}
