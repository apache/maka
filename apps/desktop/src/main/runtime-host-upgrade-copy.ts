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
  RuntimeHostNonRestartableAction,
  RuntimeHostRestartableConflict,
  RuntimeHostWaitConflict,
} from './runtime-host-desktop-manager.js';

type Conflict = RuntimeHostRestartableConflict | RuntimeHostWaitConflict;
export type RuntimeHostUpgradeDialogDecision = 'restart' | 'replace' | 'wait' | 'cancel';

type RuntimeHostUpgradeAvailability = RuntimeHostNonRestartableAction | 'restart';

export interface RuntimeHostUpgradeDialog {
  readonly options: MessageBoxOptions;
  readonly decisions: readonly RuntimeHostUpgradeDialogDecision[];
}
type ActivityKey =
  | 'goal'
  | 'scheduledTask'
  | 'dailyReview'
  | 'execution'
  | 'resource'
  | 'graph'
  | 'other';

export function buildRuntimeHostUpgradeDialog(
  conflict: Conflict,
  availability: RuntimeHostUpgradeAvailability,
  locale: UiLocale,
): RuntimeHostUpgradeDialog {
  const copy = UPGRADE_COPY[locale];
  const choices: { readonly label: string; readonly decision: RuntimeHostUpgradeDialogDecision }[] =
    [];
  const action =
    availability === 'restart'
      ? 'restart'
      : availability === 'replace_may_interrupt_work'
        ? 'replace'
        : undefined;
  const canWait =
    availability === 'wait' ||
    (availability === 'restart' && conflict.registration.lifecycleMode !== 'service') ||
    (availability === 'replace_may_interrupt_work' &&
      conflict.registration.lifecycleMode === 'ephemeral');
  if (action) {
    choices.push({
      label: action === 'restart' ? copy.restart : copy.replace,
      decision: action,
    });
  }
  if (canWait) choices.push({ label: copy.wait, decision: 'wait' });
  choices.push({ label: copy.cancel, decision: 'cancel' });
  const cancelId = choices.length - 1;
  return {
    options: {
      type: 'warning',
      title: copy.title,
      message: copy.message,
      detail: formatActivity(conflict, availability, canWait, locale),
      buttons: choices.map((choice) => choice.label),
      defaultId: cancelId,
      cancelId,
      noLink: true,
    },
    decisions: choices.map((choice) => choice.decision),
  };
}

function formatActivity(
  conflict: Conflict,
  availability: RuntimeHostUpgradeAvailability,
  canWait: boolean,
  locale: UiLocale,
): string {
  const activity = conflict.handshake?.activity;
  const copy = UPGRADE_COPY[locale];
  const lines: string[] = [];
  lines.push(copy.processId(conflict.registration.pid));
  if (activity) {
    const minutes = Math.max(1, Math.round(activity.processUptimeSeconds / 60));
    lines.push(copy.uptime(minutes));
    if (activity.connections > 0) lines.push(copy.connections(activity.connections));
    if (activity.activeOperations > 0) lines.push(copy.operations(activity.activeOperations));
    for (const residency of activity.residencies) {
      lines.push(`${copy.activity[activityKey(residency.label)]}: ${residency.count}`);
    }
  } else if (availability === 'replace_may_interrupt_work') {
    lines.push(copy.idleNotVerified);
  } else lines.push(copy.unknownActivity);
  if (availability === 'replace_may_interrupt_work') {
    lines.push('', copy.replaceWarning, copy.replaceExplanation);
  } else if (availability === 'restart') {
    lines.push('', copy.restartWarning);
  } else if (conflict.kind !== 'upgrade_required' || !conflict.restartable) {
    lines.push('');
    lines.push(copy.exitOwner(conflict.registration.pid));
  }
  if (canWait) {
    lines.push(copy.waitExplanation);
  }
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
    replace: 'Stop Host and Continue',
    wait: 'Wait',
    cancel: 'Cancel Startup',
    uptime: (n: number) => `Running for about ${n} ${n === 1 ? 'minute' : 'minutes'}`,
    connections: (n: number) => `${n} other client(s) are still connected`,
    operations: (n: number) => `${n} operation(s) are running`,
    idleNotVerified: 'Maka could not verify that this Host is idle during the safe replacement check.',
    unknownActivity: 'This Host version cannot report its background activity.',
    processId: (pid: number) => `Process ID (PID): ${pid}`,
    restartWarning:
      'Restarting preserves durable state, but it can interrupt in-flight external work.',
    replaceWarning:
      'Stopping preserves durable state, but it can interrupt in-flight external work.',
    replaceExplanation: 'Maka will stop this Host, replace it safely, and continue startup.',
    exitOwner: (pid: number) =>
      `End process ${pid} with your system process manager to replace this Host safely.`,
    waitExplanation: 'If you wait, Maka will continue automatically when this Host exits.',
    activity: {
      goal: 'Goal', scheduledTask: 'Scheduled Task', dailyReview: 'Daily Review',
      execution: 'Active execution', resource: 'Runtime resource', graph: 'Agent Graph',
      other: 'Other background activity',
    },
  },
  'zh-CN': {
    title: '旧版 Runtime Host 正在运行',
    message: '另一个 Runtime Host 进程仍占用此工作区。',
    restart: '重启 Runtime Host',
    replace: '停止 Host 并继续',
    wait: '等待',
    cancel: '取消启动',
    uptime: (n: number) => `已运行约 ${n} 分钟`,
    connections: (n: number) => `仍有 ${n} 个其他客户端连接`,
    operations: (n: number) => `有 ${n} 个操作正在运行`,
    idleNotVerified: '安全替换检查无法确认此 Host 是否处于空闲状态。',
    unknownActivity: '此 Host 版本无法报告后台活动。',
    processId: (pid: number) => `进程 ID (PID)：${pid}`,
    restartWarning: '重启会保留持久化状态，但可能中断正在进行的外部工作。',
    replaceWarning: '停止 Host 会保留持久化状态，但可能中断正在进行的外部工作。',
    replaceExplanation: 'Maka 将停止并安全替换此 Host，然后继续启动。',
    exitOwner: (pid: number) =>
      `请使用系统进程管理工具结束进程 ${pid}，以便安全替换此 Host。`,
    waitExplanation: '若选择等待，当前 Host 退出后 Maka 将自动继续。',
    activity: {
      goal: '目标', scheduledTask: '计划任务', dailyReview: '每日回顾', execution: '活动执行',
      resource: 'Runtime 资源', graph: 'Agent Graph', other: '其他后台活动',
    },
  },
  'zh-TW': {
    title: '舊版 Runtime Host 正在執行',
    message: '另一個 Runtime Host 程序仍佔用此工作區。',
    restart: '重啟 Runtime Host',
    replace: '停止 Host 並繼續',
    wait: '等待',
    cancel: '取消啟動',
    uptime: (n: number) => `已執行約 ${n} 分鐘`,
    connections: (n: number) => `仍有 ${n} 個其他客戶端連線`,
    operations: (n: number) => `有 ${n} 個操作正在執行`,
    idleNotVerified: '安全替換檢查無法確認此 Host 是否處於閒置狀態。',
    unknownActivity: '此 Host 版本無法報告後臺活動。',
    processId: (pid: number) => `程序 ID (PID)：${pid}`,
    restartWarning: '重啟會保留持久化狀態，但可能中斷正在進行的外部工作。',
    replaceWarning: '停止 Host 會保留持久化狀態，但可能中斷正在進行的外部工作。',
    replaceExplanation: 'Maka 將停止並安全替換此 Host，然後繼續啟動。',
    exitOwner: (pid: number) => `請使用系統程序管理工具結束程序 ${pid}，以便安全替換此 Host。`,
    waitExplanation: '若選擇等待，目前 Host 退出後 Maka 將自動繼續。',
    activity: {
      goal: '目標', scheduledTask: '計劃任務', dailyReview: '每日回顧', execution: '活動執行',
      resource: 'Runtime 資源', graph: 'Agent Graph', other: '其他後臺活動',
    },
  },
} as const;
