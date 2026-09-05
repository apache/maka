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

export type SettingsSharedCopy = {
  modalLabel: string;
  contentLabel: string;
  sidebarLabel: string;
  navigationLabel: string;
  backToApp: string;
  close: string;
  loading: string;
  retry: string;
  save: string;
  cancel: string;
  copy: string;
  copied: string;
  failed: string;
  settingsLoadFailed: string;
  usageLoadFailed: string;
  runtimeHost: string;
  runtimeHostUnavailable: string;
  unknownError: string;
  unavailablePage: string;
  ready: string;
  showDetails: string;
  hideDetails: string;
  /**
   * SettingsSection group titles for pages whose own copy module has no
   * suitable label. Group titles live together (here, and in
   * settings-preferences-copy's `sections`) rather than beside each control's
   * copy: a group names a SET of settings, and keeping the set names adjacent
   * is what makes an inconsistent grouping visible when someone edits one.
   */
  groups: {
    memorySources: string;
    memorySourcesHelp: string;
    searchProvider: string;
    searchProviderHelp: string;
    searchBehavior: string;
    searchBehaviorHelp: string;
    dataLocation: string;
    dataLocationHelp: string;
    memoryDocument: string;
    memoryDocumentHelp: string;
    memoryEntries: string;
    memoryEntriesHelp: string;
    reviewSchedule: string;
    reviewScheduleHelp: string;
  };
};

const SETTINGS_SHARED_COPY_BY_LOCALE = {
  'zh-CN': {
    modalLabel: '设置',
    contentLabel: '设置内容',
    sidebarLabel: '设置侧栏',
    navigationLabel: '设置分组',
    backToApp: '返回应用',
    close: '关闭',
    loading: '正在加载设置',
    retry: '重试',
    save: '保存',
    cancel: '取消',
    copy: '复制',
    copied: '已复制',
    failed: '失败',
    settingsLoadFailed: '载入设置失败',
    usageLoadFailed: '载入使用统计失败',
    runtimeHost: 'Runtime Host',
    runtimeHostUnavailable: '这个 Runtime Host 当前不可用。请选择其他 Host，或在“项目”中重试连接。',
    unknownError: '出现错误，请稍后重试。',
    unavailablePage: '该设置页已纳入 Maka 设置树，会随对应 runtime 能力一起工作。',
    showDetails: '展开详情',
    hideDetails: '收起详情',
    ready: '就绪',
    groups: {
      memorySources: '记忆',
      memorySourcesHelp: 'Maka 会在任务中记住你确认过的信息，用于之后的回答。',
      memoryDocument: '记忆文件与备份',
      memoryDocumentHelp: '记忆保存在本机 MEMORY.md 里；这里可以直接编辑原文或恢复备份。',
      memoryEntries: '已记住的内容',
      memoryEntriesHelp: '可以筛选、手动添加，或把不再需要的条目归档。',
      searchProvider: '搜索服务商',
      searchProviderHelp: '联网搜索使用的服务商与凭据。',
      searchBehavior: '搜索行为',
      searchBehaviorHelp: '什么时候发起搜索，以及每次取回多少结果。',
      dataLocation: '数据位置',
      dataLocationHelp: '任务、设置、使用统计与凭据都以文件形式存放在本机的这个位置。',
      reviewSchedule: '回顾计划',
      reviewScheduleHelp: '每日回顾的生成时间与使用的模型。',
    },
  },
  'zh-TW': {
    modalLabel: '設定',
    contentLabel: '設定內容',
    sidebarLabel: '設定側欄',
    navigationLabel: '設定分組',
    backToApp: '返回應用',
    close: '關閉',
    loading: '正在載入設定',
    retry: '重試',
    save: '儲存',
    cancel: '取消',
    copy: '複製',
    copied: '已複製',
    failed: '失敗',
    settingsLoadFailed: '載入設定失敗',
    usageLoadFailed: '載入使用統計失敗',
    runtimeHost: 'Runtime Host',
    runtimeHostUnavailable: '這個 Runtime Host 目前不可用。請選擇其他 Host，或在“專案”中重試連線。',
    unknownError: '出現錯誤，請稍後重試。',
    unavailablePage: '該設定頁已納入 Maka 設定樹，會隨對應 runtime 能力一起工作。',
    showDetails: '展開詳情',
    hideDetails: '收起詳情',
    ready: '就緒',
    groups: {
      memorySources: '記憶',
      memorySourcesHelp: 'Maka 會在任務中記住你確認過的資訊，用於之後的回答。',
      memoryDocument: '記憶檔案與備份',
      memoryDocumentHelp: '記憶儲存在本機 MEMORY.md 裡；這裡可以直接編輯原文或恢復備份。',
      memoryEntries: '已記住的內容',
      memoryEntriesHelp: '可以篩選、手動新增，或把不再需要的條目歸檔。',
      searchProvider: '搜尋服務商',
      searchProviderHelp: '聯網搜尋使用的服務商與憑據。',
      searchBehavior: '搜尋行為',
      searchBehaviorHelp: '什麼時候發起搜尋，以及每次取回多少結果。',
      dataLocation: '資料位置',
      dataLocationHelp: '任務、設定、使用統計與憑據都以檔案形式存放在本機的這個位置。',
      reviewSchedule: '回顧計劃',
      reviewScheduleHelp: '每日回顧的生成時間與使用的模型。',
    },
  },
  en: {
    modalLabel: 'Settings',
    contentLabel: 'Settings content',
    sidebarLabel: 'Settings sidebar',
    navigationLabel: 'Settings sections',
    backToApp: 'Back to app',
    close: 'Close',
    loading: 'Loading settings',
    retry: 'Try again',
    save: 'Save',
    cancel: 'Cancel',
    copy: 'Copy',
    copied: 'Copied',
    failed: 'Failed',
    settingsLoadFailed: 'Could not load settings',
    usageLoadFailed: 'Could not load usage statistics',
    runtimeHost: 'Runtime Host',
    runtimeHostUnavailable: 'This Runtime Host is unavailable. Choose another Host or retry the connection under Projects.',
    unknownError: 'Something went wrong. Try again.',
    unavailablePage: 'This page is part of the Maka settings tree and will activate with its runtime capability.',
    showDetails: 'Show details',
    hideDetails: 'Hide details',
    ready: 'Ready',
    groups: {
      memorySources: 'Memory',
      memorySourcesHelp: 'Maka remembers information you confirm in chat and uses it in later answers.',
      memoryDocument: 'Memory file and backups',
      memoryDocumentHelp: 'Memory lives in a local MEMORY.md; edit the raw file or restore a backup here.',
      memoryEntries: 'What Maka remembers',
      memoryEntriesHelp: 'Filter entries, add one manually, or archive what is no longer needed.',
      searchProvider: 'Search provider',
      searchProviderHelp: 'The provider and credentials web search uses.',
      searchBehavior: 'Search behavior',
      searchBehaviorHelp: 'When a search runs, and how many results it returns.',
      dataLocation: 'Data location',
      dataLocationHelp: 'Tasks, settings, usage statistics, and credentials are stored as files in this location on your machine.',
      reviewSchedule: 'Review schedule',
      reviewScheduleHelp: 'When the daily review runs, and which model writes it.',
    },
  },
} satisfies UiCatalog<SettingsSharedCopy>;

export function getSettingsSharedCopy(locale: UiLocale): SettingsSharedCopy {
  return SETTINGS_SHARED_COPY_BY_LOCALE[locale];
}
