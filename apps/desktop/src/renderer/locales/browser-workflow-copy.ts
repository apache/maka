import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type BrowserWorkflowCopy = {
  title: string;
  subtitle: string;
  empty: string;
  reload: string;
  run: string;
  running: string;
  rename: string;
  save: string;
  delete: string;
  confirmDelete: string;
  confirmDeletePrompt: (name: string) => string;
  preview: string;
  navigateAction: (url: string) => string;
  clickAction: (locator: string) => string;
  checkAction: (locator: string, checked: boolean) => string;
  typeAction: (locator: string, sensitive: boolean) => string;
  waitAction: (condition: string) => string;
  waitNavigationAction: string;
  sensitiveValue: (step: number, locator: string) => string;
  cancel: string;
  noSession: string;
  runFailed: string;
  deleteFailed: string;
  renameFailed: string;
  savedAt: (date: string, count: number) => string;
};

const COPY = {
  zh: {
    title: '操作流程',
    subtitle: '保存真实浏览器操作，之后可以在当前页面按固定步骤重放。',
    empty: '还没有保存的操作流程。打开浏览器后，在会话工作栏中录制一个流程。',
    reload: '重新载入操作流程',
    run: '运行',
    running: '运行中…',
    rename: '重命名',
    save: '保存',
    delete: '删除',
    confirmDelete: '确认删除',
    confirmDeletePrompt: (name) => `删除“${name}”？此操作无法撤销。`,
    preview: '查看步骤',
    navigateAction: (url) => `打开 ${url}`,
    clickAction: (locator) => `点击 ${locator}`,
    checkAction: (locator, checked) => `${checked ? '选中' : '取消选中'} ${locator}`,
    typeAction: (locator, sensitive) => `${sensitive ? '运行时输入敏感值' : '输入文本'}：${locator}`,
    waitAction: (condition) => `等待 ${condition}`,
    waitNavigationAction: '等待页面跳转',
    cancel: '取消',
    sensitiveValue: (step, locator) => `第 ${step} 步的敏感值：${locator}`,
    noSession: '请先打开一个带浏览器页面的会话。',
    runFailed: '操作流程运行失败',
    deleteFailed: '删除操作流程失败',
    renameFailed: '重命名操作流程失败',
    savedAt: (date, count) => `更新于 ${date} · ${count} 个动作`,
  },
  en: {
    title: 'Browser workflows',
    subtitle: 'Save real browser actions and replay them deterministically in the current page.',
    empty: 'No saved workflows yet. Open a browser page and record one from the session workbar.',
    reload: 'Reload workflows',
    run: 'Run',
    running: 'Running…',
    rename: 'Rename',
    save: 'Save',
    delete: 'Delete',
    confirmDelete: 'Confirm delete',
    confirmDeletePrompt: (name) => `Delete “${name}”? This cannot be undone.`,
    preview: 'View steps',
    navigateAction: (url) => `Navigate to ${url}`,
    clickAction: (locator) => `Click ${locator}`,
    checkAction: (locator, checked) => `${checked ? 'Check' : 'Uncheck'} ${locator}`,
    typeAction: (locator, sensitive) => `${sensitive ? 'Enter a runtime value' : 'Enter text'} in ${locator}`,
    waitAction: (condition) => `Wait for ${condition}`,
    waitNavigationAction: 'Wait for page navigation',
    cancel: 'Cancel',
    sensitiveValue: (step, locator) => `Sensitive value for step ${step}: ${locator}`,
    noSession: 'Open a conversation with a browser page first.',
    runFailed: 'Browser workflow failed',
    deleteFailed: 'Could not delete browser workflow',
    renameFailed: 'Could not rename browser workflow',
    savedAt: (date, count) => `Updated ${date} · ${count} actions`,
  },
} satisfies UiCatalog<BrowserWorkflowCopy>;

export function getBrowserWorkflowCopy(locale: UiLocale): BrowserWorkflowCopy {
  return COPY[locale];
}
