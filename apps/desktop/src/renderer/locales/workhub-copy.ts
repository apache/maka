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
  ko: {
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
