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
import { DesktopLocalHostRetirementError } from './runtime-host-desktop-manager.js';
import type { RuntimeHostQuitFailureDecision } from './runtime-host-quit.js';

export interface RuntimeHostQuitDialog<Decision extends string> {
  readonly options: MessageBoxOptions;
  readonly decisions: readonly Decision[];
}

export type RuntimeHostActiveQuitDecision = 'quit' | 'cancel';

export function buildRuntimeHostActiveQuitDialog(
  locale: UiLocale,
): RuntimeHostQuitDialog<RuntimeHostActiveQuitDecision> {
  const copy = COPY[locale];
  return {
    options: {
      type: 'warning',
      title: copy.activeTitle,
      message: copy.activeMessage,
      detail: copy.activeDetail,
      buttons: [copy.stopAndQuit, copy.keepRunning],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    },
    decisions: ['quit', 'cancel'],
  };
}

export function buildRuntimeHostQuitFailureDialog(
  error: unknown,
  locale: UiLocale,
): RuntimeHostQuitDialog<RuntimeHostQuitFailureDecision> {
  const retirement = error instanceof DesktopLocalHostRetirementError ? error : undefined;
  const canForceTerminate = retirement?.facts.forceTerminationAvailable === true;
  const copy = COPY[locale];
  const details: string[] = [copy.detail];
  if (retirement) {
    details.push(`State Root: ${retirement.facts.rootPath}`);
    details.push(`Host epoch: ${retirement.facts.hostEpoch}`);
    if (retirement.facts.pid !== undefined) {
      details.push(copy.process(retirement.facts.pid));
      details.push(canForceTerminate ? copy.forceWarning : copy.manual);
    }
  }
  const cause = error instanceof Error && error.cause instanceof Error
    ? error.cause.message
    : error instanceof Error
      ? error.message
      : String(error);
  details.push(`${copy.cause}: ${cause}`);
  const decisions: RuntimeHostQuitFailureDecision[] = canForceTerminate
    ? ['retry', 'force', 'cancel']
    : ['retry', 'cancel'];
  return {
    options: {
      type: 'error',
      title: copy.title,
      message: copy.message,
      detail: details.join('\n'),
      buttons: canForceTerminate
        ? [copy.retry, copy.forceQuit, copy.keepRunning]
        : [copy.retry, copy.keepRunning],
      defaultId: decisions.length - 1,
      cancelId: decisions.length - 1,
      noLink: true,
    },
    decisions,
  };
}

const COPY = {
  en: {
    activeTitle: 'Maka is still working',
    activeMessage: 'Background work is still running.',
    activeDetail:
      'Quitting now stops the Runtime Host and may interrupt active executions or scheduled background work.',
    stopAndQuit: 'Stop Work and Quit',
    keepRunning: 'Keep Maka Running',
    title: 'Unable to quit Maka safely',
    message: 'The local Runtime Host could not stop safely. Maka is still running.',
    detail: 'Quit was cancelled. Try again, or inspect diagnostics if the problem persists.',
    process: (pid: number) => `Runtime Host process PID: ${pid}`,
    manual:
      "If retry still fails, confirm that no execution must be preserved before stopping this PID with the operating system's process-management tool.",
    forceWarning: 'Force quitting can discard in-flight external work that has not settled.',
    cause: 'Cause',
    retry: 'Retry Quit',
    forceQuit: 'Force Quit Maka',
  },
  'zh-CN': {
    activeTitle: 'Maka 正在后台工作',
    activeMessage: '仍有后台工作正在运行。',
    activeDetail: '现在退出会停止 Runtime Host，并可能中断正在执行或等待运行的后台任务。',
    stopAndQuit: '停止任务并退出',
    keepRunning: '继续运行 Maka',
    title: '无法安全退出 Maka',
    message: '本地 Runtime Host 未能安全停止，Maka 仍在运行。',
    detail: '退出已取消。请重试；如果问题持续存在，请查看诊断信息。',
    process: (pid: number) => `Runtime Host 进程 PID：${pid}`,
    manual: '如果重试仍然失败，请先确认没有需要保留的执行，再通过操作系统的进程管理工具停止该 PID。',
    forceWarning: '强制退出可能丢弃尚未完成的外部工作。',
    cause: '原因',
    retry: '重试退出',
    forceQuit: '强制退出 Maka',
  },
  'zh-TW': {
    activeTitle: 'Maka 正在背景工作',
    activeMessage: '仍有背景工作正在執行。',
    activeDetail: '現在退出會停止 Runtime Host，並可能中斷正在執行或等待執行的背景工作。',
    stopAndQuit: '停止工作並退出',
    keepRunning: '繼續執行 Maka',
    title: '無法安全退出 Maka',
    message: '本地 Runtime Host 未能安全停止，Maka 仍在執行。',
    detail: '退出已取消。請重試；如果問題持續存在，請檢視診斷資訊。',
    process: (pid: number) => `Runtime Host 程序 PID：${pid}`,
    manual: '如果重試仍然失敗，請先確認沒有需要保留的執行，再透過作業系統的程序管理工具停止該 PID。',
    forceWarning: '強制退出可能丟棄尚未完成的外部工作。',
    cause: '原因',
    retry: '重試退出',
    forceQuit: '強制退出 Maka',
  },
} as const;
