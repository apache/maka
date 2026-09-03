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

export function buildRuntimeHostQuitFailureDialog(
  error: unknown,
  locale: UiLocale,
): MessageBoxOptions {
  const retirement = error instanceof DesktopLocalHostRetirementError ? error : undefined;
  const copy = COPY[locale];
  const details: string[] = [copy.detail];
  if (retirement) {
    details.push(`State Root: ${retirement.facts.rootPath}`);
    details.push(`Host epoch: ${retirement.facts.hostEpoch}`);
    if (retirement.facts.pid !== undefined) {
      details.push(copy.process(retirement.facts.pid), copy.manual);
    }
  }
  const cause = error instanceof Error && error.cause instanceof Error
    ? error.cause.message
    : error instanceof Error
      ? error.message
      : String(error);
  details.push(`${copy.cause}: ${cause}`);
  return {
    type: 'error',
    title: copy.title,
    message: copy.message,
    detail: details.join('\n'),
    buttons: [copy.button],
    defaultId: 0,
    noLink: true,
  };
}

const COPY = {
  en: {
    title: 'Unable to quit Maka safely',
    message: 'The local Runtime Host could not stop safely. Maka is still running.',
    detail: 'Quit was cancelled. Try again, or inspect diagnostics if the problem persists.',
    process: (pid: number) => `Runtime Host process PID: ${pid}`,
    manual:
      "If retry still fails, confirm that no execution must be preserved before stopping this PID with the operating system's process-management tool.",
    cause: 'Cause',
    button: 'OK',
  },
  zh: {
    title: '无法安全退出 Maka',
    message: '本地 Runtime Host 未能安全停止，Maka 仍在运行。',
    detail: '退出已取消。请重试；如果问题持续存在，请查看诊断信息。',
    process: (pid: number) => `Runtime Host 进程 PID：${pid}`,
    manual: '如果重试仍然失败，请先确认没有需要保留的执行，再通过操作系统的进程管理工具停止该 PID。',
    cause: '原因',
    button: '好',
  },
  ko: {
    title: 'Maka를 안전하게 종료할 수 없습니다',
    message: '로컬 Runtime Host를 안전하게 중지하지 못했습니다. Maka는 계속 실행 중입니다.',
    detail: '종료가 취소되었습니다. 다시 시도하거나 문제가 계속되면 진단 정보를 확인하세요.',
    process: (pid: number) => `Runtime Host 프로세스 PID: ${pid}`,
    manual: '다시 시도해도 실패하면 보존해야 할 실행이 없는지 확인한 후 운영 체제의 프로세스 관리 도구로 이 PID를 중지하세요.',
    cause: '원인',
    button: '확인',
  },
} as const;
