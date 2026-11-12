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

import type { UiCatalog } from '@maka/core/ui-locale';
import type { TaskPhase } from './task-float-model.js';
interface Copy {
  other: string; tasks: string; collapse: string; expand: string; showArchived: string; hideArchived: string; updated: string; previous: string; next: string; offline: string; empty: string; unknown: string;
  phase: Record<TaskPhase, string>;
}
export const taskFloatCopy: UiCatalog<Copy> = {
  'zh-CN': { other: '其他', tasks: '持续任务', collapse: '收起任务', expand: '展开任务', showArchived: '已归档', hideArchived: '隐藏已归档', updated: '最后更新', previous: '上一页', next: '下一页', offline: '暂时无法更新', empty: '暂无持续任务', unknown: '时间未知', phase: { running: '运行', waiting: '等待', queued: '排队', attention: '待处理', paused: '已暂停', completed: '已完成', cancelled: '已取消' } },
  'zh-TW': { other: '其他', tasks: '持續任務', collapse: '收起任務', expand: '展開任務', showArchived: '已封存', hideArchived: '隱藏已封存', updated: '最後更新', previous: '上一頁', next: '下一頁', offline: '暫時無法更新', empty: '暫無持續任務', unknown: '時間未知', phase: { running: '執行', waiting: '等待', queued: '排隊', attention: '待處理', paused: '已暫停', completed: '已完成', cancelled: '已取消' } },
  en: { other: 'Other', tasks: 'Ongoing tasks', collapse: 'Collapse tasks', expand: 'Expand tasks', showArchived: 'Archived', hideArchived: 'Hide archived', updated: 'Last updated', previous: 'Previous page', next: 'Next page', offline: 'Updates unavailable', empty: 'No ongoing tasks', unknown: 'Time unknown', phase: { running: 'Running', waiting: 'Waiting', queued: 'Queued', attention: 'Needs you', paused: 'Paused', completed: 'Done', cancelled: 'Cancelled' } },
};
