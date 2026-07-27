import type { UiCatalog, UiLocale } from '@maka/core';

type ShellControlsCopy = {
  shared: {
    close: string;
  };
  navigation: {
    mainLabel: string;
    newTask: string;
    automations: string;
    extensions: string;
    settings: string;
    update: string;
    restartUpdate: string;
    downloadingUpdate(percent: number): string;
    updateAvailable(version: string): string;
    updateDownloaded(version: string): string;
    pendingReminders(count: number): string;
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
      automations: '定时任务',
      extensions: '扩展',
      settings: '设置',
      update: '更新',
      restartUpdate: '重启',
      downloadingUpdate: (percent: number) => `正在下载更新，${percent}%`,
      updateAvailable: (version: string) => `发现新版本 ${version}`,
      updateDownloaded: (version: string) => `新版本 ${version} 已下载，重启后安装`,
      pendingReminders: (count: number) => `定时任务，${count} 个未完成提醒`,
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
      automations: 'Scheduled tasks',
      extensions: 'Extensions',
      settings: 'Settings',
      update: 'Update',
      restartUpdate: 'Restart',
      downloadingUpdate: (percent: number) => `Downloading update, ${percent}%`,
      updateAvailable: (version: string) => `Update available: ${version}`,
      updateDownloaded: (version: string) => `Update ${version} downloaded. Restart to install.`,
      pendingReminders: (count: number) => `Scheduled tasks, ${count} unfinished ${count === 1 ? 'reminder' : 'reminders'}`,
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
