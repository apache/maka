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

import type { UiLocale } from '@maka/core/ui-locale';

interface SessionHoverCardCopy {
  sessionDetailsLabel(name: string): string;
  projectDetailsLabel(name: string): string;
  groupDetailsLabel(name: string): string;
  noMessages: string;
  updated: string;
  taskCount(count: number): string;
  runningTaskCount(count: number): string;
  locationCount(count: number): string;
  projectAvailable: string;
  projectUnavailable: string;
}

const COPY: Record<UiLocale, SessionHoverCardCopy> = {
  'zh-CN': {
    sessionDetailsLabel: (name) => `${name} 任务详情`,
    projectDetailsLabel: (name) => `${name} 项目详情`,
    groupDetailsLabel: (name) => `${name} 分组详情`,
    noMessages: '尚无消息',
    updated: '更新于',
    taskCount: (count) => `${count} 个任务`,
    runningTaskCount: (count) => `${count} 个进行中`,
    locationCount: (count) => `${count} 个位置`,
    projectAvailable: '目录可用',
    projectUnavailable: '目录不可用',
  },
  'zh-TW': {
    sessionDetailsLabel: (name) => `${name} 任務詳細資料`,
    projectDetailsLabel: (name) => `${name} 專案詳細資料`,
    groupDetailsLabel: (name) => `${name} 群組詳細資料`,
    noMessages: '尚無訊息',
    updated: '更新於',
    taskCount: (count) => `${count} 個任務`,
    runningTaskCount: (count) => `${count} 個進行中`,
    locationCount: (count) => `${count} 個位置`,
    projectAvailable: '目錄可用',
    projectUnavailable: '目錄不可用',
  },
  en: {
    sessionDetailsLabel: (name) => `${name} task details`,
    projectDetailsLabel: (name) => `${name} project details`,
    groupDetailsLabel: (name) => `${name} group details`,
    noMessages: 'No messages yet',
    updated: 'Updated',
    taskCount: (count) => `${count} ${count === 1 ? 'task' : 'tasks'}`,
    runningTaskCount: (count) => `${count} running`,
    locationCount: (count) => `${count} ${count === 1 ? 'location' : 'locations'}`,
    projectAvailable: 'Directory available',
    projectUnavailable: 'Directory unavailable',
  },
};

export function getSessionHoverCardCopy(locale: UiLocale): SessionHoverCardCopy {
  return COPY[locale];
}
