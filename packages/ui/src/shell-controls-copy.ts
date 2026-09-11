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

import type { SearchErrorReason } from '@maka/core/search';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export type ThreadSearchErrorReason = Extract<
  SearchErrorReason,
  'incognito_active' | 'invalid_query' | 'aborted' | 'disabled' | 'provider_error'
>;

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
    unavailable: string;
    errorByReason: Record<ThreadSearchErrorReason, string>;
    errorFallback: string;
    introduction: string;
    empty: string;
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
      unavailable: '当前环境无法连接搜索后端，请稍后重试。',
      errorByReason: {
        incognito_active: '关闭隐私模式后可以继续按关键词查找历史任务。',
        invalid_query: '搜索词无效，请缩短内容或移除凭据后重试。',
        aborted: '搜索已取消。',
        disabled: '搜索当前不可用。',
        provider_error: '搜索服务出错，请重试。',
      },
      errorFallback: '搜索服务需要刷新，请重试。',
      introduction: '开始输入以按关键词查找历史任务。结果只包含任务标题和内容文本，不进入网络。',
      empty: '没有匹配的任务标题或内容。换个关键词试试。',
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
      unavailable: '目前環境無法連線搜尋後端，請稍後重試。',
      errorByReason: {
        incognito_active: '關閉隱私模式後可以繼續按關鍵詞查詢歷史任務。',
        invalid_query: '搜尋詞無效，請縮短內容或移除憑證後重試。',
        aborted: '搜尋已取消。',
        disabled: '搜尋目前無法使用。',
        provider_error: '搜尋服務發生錯誤，請重試。',
      },
      errorFallback: '搜尋服務需要重新整理，請重試。',
      introduction: '開始輸入以按關鍵詞查詢歷史任務。結果只包含任務標題和內容文本，不進入網路。',
      empty: '沒有符合的任務標題或內容。換個關鍵詞試試。',
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
      unavailable: 'Search is unavailable in the current environment. Try again later.',
      errorByReason: {
        incognito_active: 'Turn off privacy mode to search previous tasks by keyword.',
        invalid_query: 'Invalid search query. Shorten it or remove credential material and try again.',
        aborted: 'Search was canceled.',
        disabled: 'Search is unavailable right now.',
        provider_error: 'Search failed. Try again.',
      },
      errorFallback: 'Search needs to be refreshed. Try again.',
      introduction:
        'Start typing to search previous tasks by keyword. Results include local task titles and content only and are not sent over the network.',
      empty: 'No matching task titles or content. Try another keyword.',
      resultsLabel: 'Search results',
    },
  },
} satisfies UiCatalog<ShellControlsCopy>;

export function getShellControlsCopy(locale: UiLocale): ShellControlsCopy {
  return SHELL_CONTROLS_COPY_BY_LOCALE[locale];
}
