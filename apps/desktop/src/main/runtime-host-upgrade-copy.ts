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
import type { MessageBoxOptions } from 'electron';
import type {
  RuntimeHostRestartableConflict,
  RuntimeHostWaitConflict,
} from './runtime-host-desktop-manager.js';

type Conflict = RuntimeHostRestartableConflict | RuntimeHostWaitConflict;
type ActivityKey =
  | 'goal'
  | 'scheduledTask'
  | 'dailyReview'
  | 'execution'
  | 'resource'
  | 'graph'
  | 'other';

export function buildRuntimeHostUpgradeDialogOptions(
  conflict: Conflict,
  canRestart: boolean,
  locale: UiLocale,
): MessageBoxOptions {
  const activity = conflict.handshake?.activity;
  const hasWork =
    (activity?.activeOperations ?? 0) > 0 || (activity?.residencies.length ?? 0) > 0;
  const copy = UPGRADE_COPY[locale];
  const buttons = canRestart ? [copy.restart, copy.wait, copy.cancel] : [copy.wait, copy.cancel];
  return {
    type: 'warning',
    title: copy.title,
    message: copy.message,
    detail: formatActivity(conflict, locale),
    buttons,
    defaultId: hasWork || !canRestart ? (canRestart ? 1 : 0) : 0,
    cancelId: canRestart ? 2 : 1,
    noLink: true,
  };
}

function formatActivity(conflict: Conflict, locale: UiLocale): string {
  const activity = conflict.handshake?.activity;
  const copy = UPGRADE_COPY[locale];
  const lines: string[] = [];
  if (activity) {
    const minutes = Math.max(1, Math.round(activity.processUptimeSeconds / 60));
    lines.push(copy.uptime(minutes));
    if (activity.connections > 0) lines.push(copy.connections(activity.connections));
    if (activity.activeOperations > 0) lines.push(copy.operations(activity.activeOperations));
    for (const residency of activity.residencies) {
      lines.push(`${copy.activity[activityKey(residency.label)]}: ${residency.count}`);
    }
  } else lines.push(copy.unknownActivity);
  lines.push('', copy.restartWarning);
  if (conflict.kind !== 'upgrade_required' || !conflict.restartable) lines.push(copy.exitOwner);
  lines.push(copy.waitExplanation);
  return lines.join('\n');
}

function activityKey(label: string): ActivityKey {
  const keys: Record<string, ActivityKey> = {
    goal: 'goal',
    'scheduled-task': 'scheduledTask',
    'daily-review': 'dailyReview',
    'hosted-execution': 'execution',
    'runtime-resource': 'resource',
    'agent-graph': 'graph',
    'agent-graph-supervisor': 'graph',
  };
  return keys[label] ?? 'other';
}

const UPGRADE_COPY = {
  en: {
    title: 'Older Runtime Host is running',
    message: 'Another Runtime Host process still owns this workspace.',
    restart: 'Restart Runtime Host',
    wait: 'Wait',
    cancel: 'Cancel Startup',
    uptime: (n: number) => `Running for about ${n} ${n === 1 ? 'minute' : 'minutes'}`,
    connections: (n: number) => `${n} other client(s) are still connected`,
    operations: (n: number) => `${n} operation(s) are running`,
    unknownActivity: 'This Host version cannot report its background activity.',
    restartWarning:
      'Restarting preserves durable state, but it can interrupt in-flight external work.',
    exitOwner: 'Exit the process that owns this Host to replace it safely.',
    waitExplanation: 'If you wait, Maka will continue automatically when this Host exits.',
    activity: {
      goal: 'Goal', scheduledTask: 'Scheduled Task', dailyReview: 'Daily Review',
      execution: 'Active execution', resource: 'Runtime resource', graph: 'Agent Graph',
      other: 'Other background activity',
    },
  },
  zh: {
    title: '旧版 Runtime Host 正在运行',
    message: '另一个 Runtime Host 进程仍占用此工作区。',
    restart: '重启 Runtime Host',
    wait: '等待',
    cancel: '取消启动',
    uptime: (n: number) => `已运行约 ${n} 分钟`,
    connections: (n: number) => `仍有 ${n} 个其他客户端连接`,
    operations: (n: number) => `有 ${n} 个操作正在运行`,
    unknownActivity: '此 Host 版本无法报告后台活动。',
    restartWarning: '重启会保留持久化状态，但可能中断正在进行的外部工作。',
    exitOwner: '请退出当前占用此 Host 的进程，以便安全替换。',
    waitExplanation: '若选择等待，当前 Host 退出后 Maka 将自动继续。',
    activity: {
      goal: '目标', scheduledTask: '计划任务', dailyReview: '每日回顾', execution: '活动执行',
      resource: 'Runtime 资源', graph: 'Agent Graph', other: '其他后台活动',
    },
  },
} as const;
