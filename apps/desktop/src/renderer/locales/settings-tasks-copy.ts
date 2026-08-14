import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type SettingsTasksCopy = {
  filterAria: string;
  filterAll: string;
  filterArchived: string;
  noProject: string;
  selectAllAria: string;
  selectRowAria(name: string): string;
  selectedCount(count: number): string;
  totalCount(count: number): string;
  batchActionsAria: string;
  openTaskAria(name: string): string;
  restore: string;
  restoring: string;
  archive: string;
  archiving: string;
  delete: string;
  deleting: string;
  retry: string;
  loadingLabel: string;
  importAction: string;
  loadFailed: string;
  emptyAllTitle: string;
  emptyAllBody: string;
  emptyArchivedTitle: string;
  emptyArchivedBody: string;
  archivedBadge: string;
  restoredToast(count: number): string;
  restoreFailedTitle: string;
  archivedToast(count: number): string;
  archiveFailedTitle: string;
  partialFailure(count: number): string;
  deleteConfirmTitle(count: number): string;
  deleteConfirmBody: string;
  deleteConfirmAction: string;
  cancel: string;
  deletedToast(count: number): string;
  deleteFailedTitle: string;
  importedToast(name: string): string;
};

const SETTINGS_TASKS_COPY_BY_LOCALE = {
  zh: {
    filterAria: '任务范围',
    filterAll: '全部',
    filterArchived: '已归档',
    noProject: '无项目',
    selectAllAria: '全选当前列表',
    selectRowAria: (name: string) => `选择「${name}」`,
    selectedCount: (count: number) => `已选 ${count} 条`,
    totalCount: (count: number) => `共 ${count} 条`,
    batchActionsAria: '批量操作',
    openTaskAria: (name: string) => `打开「${name}」`,
    restore: '恢复',
    restoring: '恢复中…',
    archive: '归档',
    archiving: '归档中…',
    delete: '删除',
    deleting: '删除中…',
    retry: '重试',
    loadingLabel: '正在载入任务',
    importAction: '导入任务',
    loadFailed: '任务列表载入失败，请重试。',
    emptyAllTitle: '还没有任务',
    emptyAllBody: '新建一个任务后，它会出现在这里。',
    emptyArchivedTitle: '没有已归档的任务',
    emptyArchivedBody: '在侧栏里归档一个任务后，可以在这里恢复或彻底删除它。',
    archivedBadge: '已归档',
    restoredToast: (count: number) => `已恢复 ${count} 条任务`,
    restoreFailedTitle: '恢复任务失败',
    archivedToast: (count: number) => `已归档 ${count} 条任务`,
    archiveFailedTitle: '归档任务失败',
    partialFailure: (count: number) => `${count} 条未能完成`,
    deleteConfirmTitle: (count: number) => `删除 ${count} 条任务？`,
    deleteConfirmBody: '任务及其全部消息会被永久删除，无法撤销。',
    deleteConfirmAction: '永久删除',
    cancel: '取消',
    deletedToast: (count: number) => `已删除 ${count} 条任务`,
    deleteFailedTitle: '删除任务失败',
    importedToast: (name: string) => `已导入「${name}」`,
  },
  en: {
    filterAria: 'Task scope',
    filterAll: 'All',
    filterArchived: 'Archived',
    noProject: 'No project',
    selectAllAria: 'Select every task in this list',
    selectRowAria: (name: string) => `Select ${name}`,
    selectedCount: (count: number) => `${count} selected`,
    totalCount: (count: number) => (count === 1 ? '1 task' : `${count} tasks`),
    batchActionsAria: 'Bulk actions',
    openTaskAria: (name: string) => `Open ${name}`,
    restore: 'Restore',
    restoring: 'Restoring…',
    archive: 'Archive',
    archiving: 'Archiving…',
    delete: 'Delete',
    deleting: 'Deleting…',
    retry: 'Try again',
    loadingLabel: 'Loading tasks',
    importAction: 'Import tasks',
    loadFailed: 'Could not load the task list. Try again.',
    emptyAllTitle: 'No tasks yet',
    emptyAllBody: 'Start a task and it will show up here.',
    emptyArchivedTitle: 'Nothing archived',
    emptyArchivedBody: 'Archive a task from the rail to restore or permanently delete it here.',
    archivedBadge: 'Archived',
    restoredToast: (count: number) => (count === 1 ? 'Restored 1 task' : `Restored ${count} tasks`),
    restoreFailedTitle: 'Could not restore the tasks',
    archivedToast: (count: number) => (count === 1 ? 'Archived 1 task' : `Archived ${count} tasks`),
    archiveFailedTitle: 'Could not archive the tasks',
    partialFailure: (count: number) => (count === 1 ? '1 task did not finish' : `${count} tasks did not finish`),
    deleteConfirmTitle: (count: number) => (count === 1 ? 'Delete 1 task?' : `Delete ${count} tasks?`),
    deleteConfirmBody: 'The tasks and all of their messages are removed permanently. This cannot be undone.',
    deleteConfirmAction: 'Delete permanently',
    cancel: 'Cancel',
    deletedToast: (count: number) => (count === 1 ? 'Deleted 1 task' : `Deleted ${count} tasks`),
    deleteFailedTitle: 'Could not delete the tasks',
    importedToast: (name: string) => `Imported ${name}`,
  },
} satisfies UiCatalog<SettingsTasksCopy>;

export function getSettingsTasksCopy(locale: UiLocale): SettingsTasksCopy {
  return SETTINGS_TASKS_COPY_BY_LOCALE[locale];
}
