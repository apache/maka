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

const COPY = {
  en: {
    activeTitle: 'Maka is still working',
    activeMessage: 'Background work is still running.',
    activeDetail:
      'Quitting now stops the Runtime Host and may interrupt active executions or scheduled background work. It resumes from its durable state the next time a Runtime Host runs.',
    stopAndQuit: 'Stop Work and Quit',
    keepRunning: 'Keep Maka Running',
  },
  'zh-CN': {
    activeTitle: 'Maka 正在后台工作',
    activeMessage: '仍有后台工作正在运行。',
    activeDetail:
      '现在退出会停止 Runtime Host，并可能中断正在执行或等待运行的后台任务。任务会在下次 Runtime Host 运行时从持久状态恢复。',
    stopAndQuit: '停止任务并退出',
    keepRunning: '继续运行 Maka',
  },
  'zh-TW': {
    activeTitle: 'Maka 正在背景工作',
    activeMessage: '仍有背景工作正在執行。',
    activeDetail:
      '現在結束會停止 Runtime Host，並可能中斷正在執行或等待執行的背景工作。工作會在下次 Runtime Host 執行時從持久狀態恢復。',
    stopAndQuit: '停止工作並結束',
    keepRunning: '繼續執行 Maka',
  },
  ko: {
    title: 'Maka를 안전하게 종료할 수 없습니다',
    message: '로컬 Runtime Host를 안전하게 중지하지 못했습니다. Maka가 아직 실행 중입니다.',
    detail: '종료가 취소되었습니다. 다시 시도하거나 문제가 계속되면 진단 정보를 확인하세요.',
    process: (pid: number) => `Runtime Host 프로세스 PID: ${pid}`,
    manual:
      '다시 시도해도 실패하면, 보존할 실행이 없는지 확인한 뒤 운영체제의 프로세스 관리 도구로 해당 PID를 중지하세요.',
    cause: '원인',
    button: '확인',
  },
} as const;
