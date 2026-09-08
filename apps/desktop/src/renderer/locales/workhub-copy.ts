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

import type { WorkHubWorkFilter, WorkHubAnchorSession } from '../features/workhub/index.js';

export interface WorkHubRailCopy {
  readonly work: string;
  readonly workNavigation: string;
  readonly filterWork: string;
  readonly focused: string;
  readonly archived: string;
  readonly states: Readonly<Record<
    WorkHubAnchorSession['state'],
    string
  >>;
  readonly anchorCount: (shown: number, matching: number, total: number) => string;
  readonly noFilteredWork: string;
  readonly filters: ReadonlyArray<{
    readonly id: WorkHubWorkFilter;
    readonly label: string;
  }>;
}

const COPY = {
  'zh-CN': {
    work: '工作', workNavigation: '工作导航', filterWork: '筛选工作', focused: '当前',
    archived: '已归档',
    states: { active: '活跃', running: '进行中', waiting_for_user: '等待你', blocked: '受阻', aborted: '已中止' },
    anchorCount: (shown, matching, total) => `${shown}/${matching} 个锚点 · 共 ${total} 项`,
    noFilteredWork: '此筛选下没有工作',
    filters: [
      { id: 'all', label: '全部' },
      { id: 'active', label: '进行中' },
      { id: 'attention', label: '待处理' },
      { id: 'stopped', label: '已停止' },
    ],
  },
  'zh-TW': {
    work: '工作', workNavigation: '工作導覽', filterWork: '篩選工作', focused: '目前',
    archived: '已封存',
    states: { active: '使用中', running: '進行中', waiting_for_user: '等待你', blocked: '受阻', aborted: '已中止' },
    anchorCount: (shown, matching, total) => `${shown}/${matching} 個錨點 · 共 ${total} 項`,
    noFilteredWork: '此篩選下沒有工作',
    filters: [
      { id: 'all', label: '全部' },
      { id: 'active', label: '進行中' },
      { id: 'attention', label: '待處理' },
      { id: 'stopped', label: '已停止' },
    ],
  },
  en: {
    work: 'Work', workNavigation: 'Work navigation', filterWork: 'Filter work', focused: 'Focused',
    archived: 'Archived',
    states: { active: 'Active', running: 'Running', waiting_for_user: 'Waiting for you', blocked: 'Blocked', aborted: 'Aborted' },
    anchorCount: (shown, matching, total) => `${shown}/${matching} anchors · ${total} total`,
    noFilteredWork: 'No work matches this filter',
    filters: [
      { id: 'all', label: 'All' },
      { id: 'active', label: 'Active' },
      { id: 'attention', label: 'Needs you' },
      { id: 'stopped', label: 'Stopped' },
    ],
  },
} satisfies UiCatalog<WorkHubRailCopy>;

export function getWorkHubRailCopy(locale: UiLocale): WorkHubRailCopy {
  return COPY[locale];
}

interface WorkHubComposerCopy {
  readonly settingsUpdateFailed: string;
  readonly sendTo: string;
  readonly currentWork: string;
  readonly routeAutomatically: string;
  readonly workUnavailable: string;
  readonly selectedWorkSettings: string;
  readonly newWorkSettings: string;
  readonly attachmentLimitExceeded: string;
  readonly attachmentPrompt: string;
  readonly sendFailed: string;
  readonly tryAgain: string;
  readonly settingsLocked: string;
}

const COMPOSER_COPY = {
  'zh-CN': {
    settingsUpdateFailed: '配置更新失败，请重试',
    sendTo: '发送到',
    currentWork: '当前 Work',
    routeAutomatically: '自动识别工作',
    workUnavailable: '工作不可用',
    selectedWorkSettings: '模型与权限用于此 Work',
    newWorkSettings: '模型与权限用于新 Work',
    attachmentLimitExceeded: '附件数量或大小超过限制',
    attachmentPrompt: '请查看附件。',
    sendFailed: '发送失败',
    tryAgain: '请重试',
    settingsLocked: '当前无法修改配置',
  },
  'zh-TW': {
    settingsUpdateFailed: '設定更新失敗，請重試',
    sendTo: '傳送至',
    currentWork: '目前 Work',
    routeAutomatically: '自動識別工作',
    workUnavailable: '工作無法使用',
    selectedWorkSettings: '模型與權限用於此 Work',
    newWorkSettings: '模型與權限用於新 Work',
    attachmentLimitExceeded: '附件數量或大小超過限制',
    attachmentPrompt: '請查看附件。',
    sendFailed: '傳送失敗',
    tryAgain: '請重試',
    settingsLocked: '目前無法修改設定',
  },
  'en': {
    settingsUpdateFailed: 'Could not update settings. Try again.',
    sendTo: 'Send to',
    currentWork: 'Current Work',
    routeAutomatically: 'Route automatically',
    workUnavailable: 'Work unavailable',
    selectedWorkSettings: 'Settings apply to this Work',
    newWorkSettings: 'Settings apply to new Work',
    attachmentLimitExceeded: 'Attachment count or size exceeds the limit',
    attachmentPrompt: 'Please review the attachments.',
    sendFailed: 'Could not send',
    tryAgain: 'Try again',
    settingsLocked: 'Settings are currently locked',
  },
} satisfies UiCatalog<WorkHubComposerCopy>;

export function getWorkHubComposerCopy(locale: UiLocale): WorkHubComposerCopy {
  return COMPOSER_COPY[locale];
}
