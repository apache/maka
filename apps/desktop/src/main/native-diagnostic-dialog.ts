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
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import {
  createDesktopStartupDiagnosticInput,
  formatDesktopDiagnosticReport,
  type DesktopDiagnosticEnvironment,
} from './main-process-diagnostics.js';
import { whileAwaitingPerson } from './startup-step.js';

export async function showMessageBoxWithDiagnostics(
  options: MessageBoxOptions,
  deps: {
    readonly locale: UiLocale;
    readonly copyDiagnostics: () => void | Promise<void>;
    readonly showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  },
): Promise<MessageBoxReturnValue> {
  let status: string | undefined;
  for (;;) {
    const { options: next, copyId } = diagnosticDialogOptions(options, deps.locale, status);
    const result = await whileAwaitingPerson(deps.showMessageBox(next));
    if (result.response !== copyId) return result;
    status = await copyDiagnostics(deps.copyDiagnostics, deps.locale);
  }
}

export async function showFatalStartupError(
  error: unknown,
  deps: {
    readonly locale: UiLocale;
    readonly environment: () => DesktopDiagnosticEnvironment;
    readonly mainLogs: () => readonly string[];
    readonly writeClipboard: (value: string) => void;
    readonly showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  },
): Promise<void> {
  const copy = FATAL_STARTUP_COPY[deps.locale];
  const message = error instanceof Error ? error.message : String(error);
  const input = createDesktopStartupDiagnosticInput({
    title: 'Maka failed to start',
    description: message || 'Unknown startup error',
    ...(error instanceof Error && error.stack ? { details: error.stack } : {}),
  });
  await showMessageBoxWithDiagnostics(
    {
      type: 'error',
      title: copy.title,
      message: copy.message,
      detail: message || copy.unknownError,
      buttons: [copy.exit],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    },
    {
      locale: deps.locale,
      showMessageBox: deps.showMessageBox,
      copyDiagnostics: () =>
        deps.writeClipboard(
          formatDesktopDiagnosticReport(
            input,
            deps.environment(),
            deps.mainLogs(),
            { ok: false, error: 'Runtime Host diagnostics were unavailable before the app opened' },
          ),
        ),
    },
  );
}

async function copyDiagnostics(
  copy: () => void | Promise<void>,
  locale: UiLocale,
): Promise<string> {
  try {
    await copy();
    return DIALOG_COPY[locale].copied;
  } catch (error) {
    console.error('[diagnostics] native clipboard write failed:', error);
    return DIALOG_COPY[locale].copyFailed;
  }
}

function diagnosticDialogOptions(
  options: MessageBoxOptions,
  locale: UiLocale,
  status: string | undefined,
): { readonly options: MessageBoxOptions; readonly copyId: number } {
  const buttons = options.buttons;
  if (!buttons || buttons.length === 0) {
    throw new TypeError('A diagnostic dialog requires at least one decision button');
  }
  const copy = DIALOG_COPY[locale];
  return {
    options: {
      ...options,
      buttons: [...buttons, status === copy.copied ? copy.copyAgain : copy.copy],
      ...(status
        ? { detail: [options.detail, status].filter(Boolean).join('\n\n') }
        : {}),
    },
    copyId: buttons.length,
  };
}

const DIALOG_COPY = {
  en: {
    copy: 'Copy Diagnostics',
    copyAgain: 'Copy Again',
    copied: 'Diagnostics copied. You can paste them into an issue report.',
    copyFailed: 'Could not copy diagnostics.',
  },
  zh: {
    copy: '复制诊断信息',
    copyAgain: '再次复制',
    copied: '诊断信息已复制，可直接粘贴到问题报告中。',
    copyFailed: '无法复制诊断信息。',
  },
} as const;

const FATAL_STARTUP_COPY = {
  en: {
    title: 'Maka failed to start',
    message: 'Maka could not finish starting.',
    unknownError: 'An unknown startup error occurred.',
    exit: 'Exit',
  },
  zh: {
    title: 'Maka 启动失败',
    message: 'Maka 无法完成启动。',
    unknownError: '启动时发生未知错误。',
    exit: '退出',
  },
} as const;
