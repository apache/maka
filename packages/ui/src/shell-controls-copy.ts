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
  'zh-CN': {
    shared: { close: '关闭' },
    navigation: {
      mainLabel: '主导航',
      newTask: '新任务',
      automations: '定时任务',
      extensions: '扩展',
      settings: '设置',
      updateDownloaded: (version: string) => `新版本 ${version} 已下载，重启后安装`,
      updateFailed: (version: string) => `新版本 ${version} 更新失败，点击重试或手动下载`,
      pendingTasks: (count: number) => `定时任务，${count} 条进行中`,
    },
    search: {
      title: '搜索',
      conversationsLabel: '搜索任务',
      placeholder: '搜索任务标题和内容…',
      clearLabel: '清空搜索',
      statusRegionLabel: '搜索状态和结果',
      unavailable: '当前环境无法连接搜索后端，请稍后重试。',
      privacyTitle: '隐私模式已关闭搜索。',
      privacyDetail: '关闭隐私模式后可以继续按关键词查找历史任务。',
      errorTitle: '搜索暂时无法完成。',
      errorFallback: '搜索服务需要刷新，请重试。',
      introduction: '开始输入以按关键词查找历史任务。结果只包含任务标题和内容文本，不进入网络。',
      searching: '正在搜索…',
      empty: '没有匹配的任务标题或内容。换个关键词试试。',
      results: (count: number) => `找到 ${count} 条匹配`,
      truncatedResults: (count: number) => `结果较多，已显示前 ${count} 条`,
      resultsLabel: '搜索结果',
    },
  },
  'zh-TW': {
    shared: { close: '關閉' },
    navigation: {
      mainLabel: '主導航',
      newTask: '新任務',
      automations: '定時任務',
      extensions: '擴充套件',
      settings: '設定',
      updateDownloaded: (version: string) => `新版本 ${version} 已下載，重啟後安裝`,
      updateFailed: (version: string) => `新版本 ${version} 更新失敗，點選重試或手動下載`,
      pendingTasks: (count: number) => `定時任務，${count} 條進行中`,
    },
    search: {
      title: '搜尋',
      conversationsLabel: '搜尋任務',
      placeholder: '搜尋任務標題和內容…',
      clearLabel: '清空搜尋',
      statusRegionLabel: '搜尋狀態和結果',
      unavailable: '目前環境無法連線搜尋後端，請稍後重試。',
      privacyTitle: '隱私模式已關閉搜尋。',
      privacyDetail: '關閉隱私模式後可以繼續按關鍵詞查詢歷史任務。',
      errorTitle: '搜尋暫時無法完成。',
      errorFallback: '搜尋服務需要重新整理，請重試。',
      introduction: '開始輸入以按關鍵詞查詢歷史任務。結果只包含任務標題和內容文本，不進入網路。',
      searching: '正在搜尋…',
      empty: '沒有符合的任務標題或內容。換個關鍵詞試試。',
      results: (count: number) => `找到 ${count} 條符合`,
      truncatedResults: (count: number) => `結果較多，已顯示前 ${count} 條`,
      resultsLabel: '搜尋結果',
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
      updateDownloaded: (version: string) => `Update ${version} downloaded. Restart to install.`,
      updateFailed: (version: string) => `Update ${version} failed. Click to retry or download manually.`,
      pendingTasks: (count: number) => `Scheduled tasks, ${count} active`,
    },
    search: {
      title: 'Search',
      conversationsLabel: 'Search tasks',
      placeholder: 'Search task titles and content…',
      clearLabel: 'Clear search',
      statusRegionLabel: 'Search status and results',
      unavailable: 'Search is unavailable in the current environment. Try again later.',
      privacyTitle: 'Search is disabled in privacy mode.',
      privacyDetail: 'Turn off privacy mode to search previous tasks by keyword.',
      errorTitle: 'Search could not be completed.',
      errorFallback: 'Search needs to be refreshed. Try again.',
      introduction:
        'Start typing to search previous tasks by keyword. Results include local task titles and content only and are not sent over the network.',
      searching: 'Searching…',
      empty: 'No matching task titles or content. Try another keyword.',
      results: (count: number) => `${count} ${count === 1 ? 'match' : 'matches'}`,
      truncatedResults: (count: number) => `Many results; showing the first ${count}`,
      resultsLabel: 'Search results',
    },
  },
} satisfies UiCatalog<ShellControlsCopy>;

export function getShellControlsCopy(locale: UiLocale): ShellControlsCopy {
  return SHELL_CONTROLS_COPY_BY_LOCALE[locale];
}
