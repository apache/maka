import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type SettingsTasksCopy = {
  noProject: string;
  selectAllAria: string;
  selectRowAria(name: string): string;
  selectedCount(count: number): string;
  totalCount(count: number): string;
  batchActionsAria: string;
  searchLabel: string;
  searchPlaceholder: string;
  projectFilterLabel: string;
  allProjects: string;
  purge: string;
  purgeConfirmTitle(count: number): string;
  noMatchTitle: string;
  noMatchBody: string;
  openTaskAria(name: string): string;
  restore: string;
  restoring: string;
  delete: string;
  deleting: string;
  retry: string;
  loadingLabel: string;
  loadFailed: string;
  emptyTitle: string;
  emptyBody: string;
  restoredToast(count: number): string;
  restoreFailedTitle: string;
  partialFailure(count: number): string;
  deleteConfirmTitle(count: number): string;
  deleteConfirmBody: string;
  deleteConfirmAction: string;
  cancel: string;
  deletedToast(count: number): string;
  deleteFailedTitle: string;
};

const SETTINGS_TASKS_COPY_BY_LOCALE = {
  zh: {
    noProject: '无项目',
    selectAllAria: '全选当前列表',
    selectRowAria: (name: string) => `选择「${name}」`,
    selectedCount: (count: number) => `已选 ${count} 条`,
    totalCount: (count: number) => `共 ${count} 条`,
    batchActionsAria: '批量操作',
    searchLabel: '搜索已归档任务',
    searchPlaceholder: '搜索任务或项目',
    projectFilterLabel: '按项目筛选',
    allProjects: '所有项目',
    purge: '清空',
    purgeConfirmTitle: (count: number) => `清空这 ${count} 条已归档任务？`,
    noMatchTitle: '没有匹配的任务',
    noMatchBody: '换个关键词，或把项目筛选清空。',
    openTaskAria: (name: string) => `打开「${name}」`,
    restore: '恢复',
    restoring: '恢复中…',
    delete: '彻底删除',
    deleting: '删除中…',
    retry: '重试',
    loadingLabel: '正在载入已归档任务',
    loadFailed: '已归档任务载入失败。',
    emptyTitle: '没有已归档的任务',
    emptyBody: '在侧栏里归档一个任务后，可以在这里恢复或彻底删除它。',
    restoredToast: (count: number) => `已恢复 ${count} 条任务`,
    restoreFailedTitle: '恢复任务失败',
    partialFailure: (count: number) => `${count} 条未能完成`,
    deleteConfirmTitle: (count: number) => `彻底删除 ${count} 条任务？`,
    deleteConfirmBody: '任务及其全部消息会被永久删除，无法撤销。',
    deleteConfirmAction: '永久删除',
    cancel: '取消',
    deletedToast: (count: number) => `已删除 ${count} 条任务`,
    deleteFailedTitle: '删除任务失败',
  },
  en: {
    noProject: 'No project',
    selectAllAria: 'Select every archived task',
    selectRowAria: (name: string) => `Select ${name}`,
    selectedCount: (count: number) => `${count} selected`,
    totalCount: (count: number) => (count === 1 ? '1 task' : `${count} tasks`),
    batchActionsAria: 'Bulk actions',
    searchLabel: 'Search archived tasks',
    searchPlaceholder: 'Search tasks or projects',
    projectFilterLabel: 'Filter by project',
    allProjects: 'All projects',
    purge: 'Clear',
    purgeConfirmTitle: (count: number) =>
      count === 1 ? 'Clear this 1 archived task?' : `Clear these ${count} archived tasks?`,
    noMatchTitle: 'No matching tasks',
    noMatchBody: 'Try a different search, or clear the project filter.',
    openTaskAria: (name: string) => `Open ${name}`,
    restore: 'Restore',
    restoring: 'Restoring…',
    delete: 'Delete',
    deleting: 'Deleting…',
    retry: 'Try again',
    loadingLabel: 'Loading archived tasks',
    loadFailed: 'Could not load the archived tasks.',
    emptyTitle: 'Nothing archived',
    emptyBody: 'Archive a task from the rail to restore or permanently delete it here.',
    restoredToast: (count: number) => (count === 1 ? 'Restored 1 task' : `Restored ${count} tasks`),
    restoreFailedTitle: 'Could not restore the tasks',
    partialFailure: (count: number) =>
      count === 1 ? '1 task did not finish' : `${count} tasks did not finish`,
    deleteConfirmTitle: (count: number) =>
      count === 1 ? 'Permanently delete 1 task?' : `Permanently delete ${count} tasks?`,
    deleteConfirmBody:
      'The tasks and all of their messages are removed permanently. This cannot be undone.',
    deleteConfirmAction: 'Delete permanently',
    cancel: 'Cancel',
    deletedToast: (count: number) => (count === 1 ? 'Deleted 1 task' : `Deleted ${count} tasks`),
    deleteFailedTitle: 'Could not delete the tasks',
  },
} satisfies UiCatalog<SettingsTasksCopy>;

export function getSettingsTasksCopy(locale: UiLocale): SettingsTasksCopy {
  return SETTINGS_TASKS_COPY_BY_LOCALE[locale];
}
