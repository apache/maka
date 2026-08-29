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
    missingTitle: string;
    missingBody: string;
  };
  history: {
    title: string;
    ordinaryActions: string;
    count: (count: number) => string;
    emptyTitle: string;
    emptyBody: string;
    open: string;
    migrated: string;
    migrationTitle: string;
    migrationBody: string;
  };
}

const COPY = {
  zh: {
    page: {
      title: '每日回顾', setup: '设置每日回顾', runNow: '立即生成回顾', running: '正在启动…', manage: '管理日程', refresh: '刷新', loading: '正在载入每日回顾…', loadFailed: '每日回顾暂时无法载入。', retry: '重试',
    },
    range: { label: '活动范围', options: [[1, '今日'], [7, '最近 7 天'], [30, '最近 30 天']], earlier: '查看更早一天', later: '查看更晚一天', current: '回到当前范围' },
    overview: { tasks: '任务', modelCalls: '模型调用', tokens: 'Token', cost: '费用' },
    schedule: { active: '每日回顾已启用', paused: '每日回顾已暂停', missingTitle: '设置每日回顾', missingBody: '选择执行时间后，Maka 会通过普通定时任务启动一个新任务，并把 Markdown 报告保存在该任务及其 Artifact 中。' },
    history: { title: '回顾报告', ordinaryActions: '打开后可继续对话或引用报告内容；Markdown Artifact 可直接预览、复制和另存。', count: (count) => `${count} 份`, emptyTitle: '还没有回顾报告', emptyBody: '每日回顾运行后会在这里出现。每份报告都是可继续对话的普通任务，附件保存在该任务的 Artifact 中。', open: '打开报告任务', migrated: '已迁移', migrationTitle: '旧报告已迁移', migrationBody: '旧版 Daily Review 报告已转换为普通任务和 Artifact；内容没有丢失，也不会继续写入旧归档。' },
  },
  en: {
    page: {
      title: 'Daily Review', setup: 'Set up Daily Review', runNow: 'Run review now', running: 'Starting…', manage: 'Manage schedule', refresh: 'Refresh', loading: 'Loading Daily Review…', loadFailed: 'Daily Review could not be loaded.', retry: 'Retry',
    },
    range: { label: 'Activity range', options: [[1, 'Today'], [7, 'Last 7 days'], [30, 'Last 30 days']], earlier: 'View one day earlier', later: 'View one day later', current: 'Return to the current range' },
    overview: { tasks: 'Tasks', modelCalls: 'Model calls', tokens: 'Tokens', cost: 'Cost' },
    schedule: { active: 'Daily Review is active', paused: 'Daily Review is paused', missingTitle: 'Set up Daily Review', missingBody: 'Choose a time and Maka will use an ordinary scheduled task to start a new task, keeping the Markdown report in that task and its artifacts.' },
    history: { title: 'Review reports', ordinaryActions: 'Open a report to continue or quote it. Its Markdown artifact can be previewed, copied, or saved as usual.', count: (count) => `${count} ${count === 1 ? 'report' : 'reports'}`, emptyTitle: 'No review reports yet', emptyBody: 'Daily Review runs appear here as ordinary tasks you can continue. Their files stay in the task artifacts.', open: 'Open report task', migrated: 'Migrated', migrationTitle: 'Earlier reports were migrated', migrationBody: 'Reports from the earlier Daily Review system are now ordinary tasks and artifacts. Nothing was discarded, and no new data is written to the retired archive.' },
  },
} satisfies UiCatalog<DailyReviewCopy>;

export function getDailyReviewCopy(locale: UiLocale): DailyReviewCopy {
  return COPY[locale];
}
