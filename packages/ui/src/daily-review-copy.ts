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
import type { DailyReviewRange } from './daily-review-view-state.js';

export interface DailyReviewCopy {
  page: {
    title: string;
    setup: string;
    runNow: string;
    running: string;
    manage: string;
    refresh: string;
    loading: string;
    loadFailed: string;
    retry: string;
  };
  range: {
    label: string;
    options: ReadonlyArray<readonly [DailyReviewRange, string]>;
    earlier: string;
    later: string;
    current: string;
  };
  overview: {
    tasks: string;
    modelCalls: string;
    tokens: string;
    cost: string;
  };
  schedule: {
    active: string;
    paused: string;
  };
  history: {
    title: string;
    count: (count: number) => string;
    open: string;
    migrated: string;
    migrationNote: string;
  };
  activity: {
    title: string;
    count: (count: number) => string;
    emptyTitle: string;
  };
}

const COPY = {
  zh: {
    page: {
      title: '每日回顾', setup: '设置每日回顾', runNow: '立即生成回顾', running: '正在启动…', manage: '管理日程', refresh: '刷新', loading: '正在载入每日回顾…', loadFailed: '每日回顾暂时无法载入。', retry: '重试',
    },
    range: { label: '活动范围', options: [[1, '今日'], [7, '最近 7 天'], [30, '最近 30 天']], earlier: '查看更早一天', later: '查看更晚一天', current: '回到当前范围' },
    overview: { tasks: '任务', modelCalls: '模型调用', tokens: 'Token', cost: '费用' },
    schedule: { active: '每日回顾已启用', paused: '每日回顾已暂停' },
    history: { title: '回顾报告', count: (count) => `${count} 份`, open: '打开报告任务', migrated: '已迁移', migrationNote: '旧报告已迁移为普通任务和 Artifact' },
    activity: { title: '任务活动', count: (count) => `${count} 个任务`, emptyTitle: '这个范围内还没有任务' },
  },
  en: {
    page: {
      title: 'Daily Review', setup: 'Set up Daily Review', runNow: 'Run review now', running: 'Starting…', manage: 'Manage schedule', refresh: 'Refresh', loading: 'Loading Daily Review…', loadFailed: 'Daily Review could not be loaded.', retry: 'Retry',
    },
    range: { label: 'Activity range', options: [[1, 'Today'], [7, 'Last 7 days'], [30, 'Last 30 days']], earlier: 'View one day earlier', later: 'View one day later', current: 'Return to the current range' },
    overview: { tasks: 'Tasks', modelCalls: 'Model calls', tokens: 'Tokens', cost: 'Cost' },
    schedule: { active: 'Daily Review is active', paused: 'Daily Review is paused' },
    history: { title: 'Review reports', count: (count) => `${count} ${count === 1 ? 'report' : 'reports'}`, open: 'Open report task', migrated: 'Migrated', migrationNote: 'Earlier reports are ordinary tasks and artifacts now' },
    activity: { title: 'Task activity', count: (count) => `${count} ${count === 1 ? 'task' : 'tasks'}`, emptyTitle: 'No tasks in this range yet' },
  },
} satisfies UiCatalog<DailyReviewCopy>;

export function getDailyReviewCopy(locale: UiLocale): DailyReviewCopy {
  return COPY[locale];
}
