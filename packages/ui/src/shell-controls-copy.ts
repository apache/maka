import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

type ShellControlsCopy = {
  shared: {
    close: string;
  };
  navigation: {
    mainLabel: string;
    newTask: string;
    importSession: string;
    conversations: string;
    archivedConversations: string;
    /**
     * Accessible name of the session-group header's new-task trigger
     * (session-history-list.tsx). Deliberately NOT `newTask`: that copy is
     * the rail's top-level SideNavItem's name, and two controls sharing one
     * accessible name collide for `getByRole('button', { name })` and screen
     * readers alike. The two entries share the handler, not the name.
     */
    groupNewTask: string;
    automations: string;
    extensions: string;
    settings: string;
    updateDownloaded(version: string): string;
    updateFailed(version: string): string;
    pendingTasks(count: number): string;
  };
  search: {
    title: string;
    conversationsLabel: string;
    placeholder: string;
    clearLabel: string;
    statusRegionLabel: string;
    unavailable: string;
    privacyTitle: string;
    privacyDetail: string;
    errorTitle: string;
    errorFallback: string;
    introduction: string;
    searching: string;
    empty: string;
    results(count: number): string;
    truncatedResults(count: number): string;
    resultsLabel: string;
  };
};

const SHELL_CONTROLS_COPY_BY_LOCALE = {
  zh: {
    shared: { close: '关闭' },
    navigation: {
      mainLabel: '主导航',
      newTask: '新任务',
      importSession: '导入会话',
      conversations: '会话',
      archivedConversations: '已归档',
      groupNewTask: '新建任务',
      automations: '定时任务',
      extensions: '扩展',
      settings: '设置',
      updateDownloaded: (version: string) => `新版本 ${version} 已下载，重启后安装`,
      updateFailed: (version: string) => `新版本 ${version} 更新失败，点击重试或手动下载`,
      pendingTasks: (count: number) => `定时任务，${count} 个未完成任务`,
    },
    search: {
      title: '搜索',
      conversationsLabel: '搜索会话',
      placeholder: '搜索会话标题和内容…',
      clearLabel: '清空搜索',
      statusRegionLabel: '搜索状态和结果',
      unavailable: '当前环境无法连接搜索后端，请稍后重试。',
      privacyTitle: '隐私模式已关闭搜索。',
      privacyDetail: '关闭隐私模式后可以继续按关键词查找历史对话。',
      errorTitle: '搜索暂时无法完成。',
      errorFallback: '搜索服务需要刷新，请重试。',
      introduction: '开始输入以按关键词查找历史对话。结果只包含会话标题和内容文本，不进入网络。',
      searching: '正在搜索…',
      empty: '没有匹配的会话标题或内容。换个关键词试试。',
      results: (count: number) => `找到 ${count} 条匹配`,
      truncatedResults: (count: number) => `结果较多，已显示前 ${count} 条`,
      resultsLabel: '搜索结果',
    },
  },
  en: {
    shared: { close: 'Close' },
    navigation: {
      mainLabel: 'Main navigation',
      newTask: 'New task',
      importSession: 'Import conversation',
      conversations: 'Conversations',
      archivedConversations: 'Archived',
      groupNewTask: 'New task in group',
      automations: 'Scheduled tasks',
      extensions: 'Extensions',
      settings: 'Settings',
      updateDownloaded: (version: string) => `Update ${version} downloaded. Restart to install.`,
      updateFailed: (version: string) => `Update ${version} failed. Click to retry or download manually.`,
      pendingTasks: (count: number) => `Scheduled tasks, ${count} unfinished ${count === 1 ? 'task' : 'tasks'}`,
    },
    search: {
      title: 'Search',
      conversationsLabel: 'Search conversations',
      placeholder: 'Search conversation titles and content…',
      clearLabel: 'Clear search',
      statusRegionLabel: 'Search status and results',
      unavailable: 'Search is unavailable in the current environment. Try again later.',
      privacyTitle: 'Search is disabled in privacy mode.',
      privacyDetail: 'Turn off privacy mode to search previous conversations by keyword.',
      errorTitle: 'Search could not be completed.',
      errorFallback: 'Search needs to be refreshed. Try again.',
      introduction:
        'Start typing to search previous conversations by keyword. Results include local conversation titles and content only and are not sent over the network.',
      searching: 'Searching…',
      empty: 'No matching conversation titles or content. Try another keyword.',
      results: (count: number) => `${count} ${count === 1 ? 'match' : 'matches'}`,
      truncatedResults: (count: number) => `Many results; showing the first ${count}`,
      resultsLabel: 'Search results',
    },
  },
} satisfies UiCatalog<ShellControlsCopy>;

export function getShellControlsCopy(locale: UiLocale): ShellControlsCopy {
  return SHELL_CONTROLS_COPY_BY_LOCALE[locale];
}
