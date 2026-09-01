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
import type {
  MessageBoxOptions,
  MessageBoxReturnValue,
} from 'electron';
import {
  createDesktopStartupDiagnosticInput,
  formatDesktopDiagnosticReport,
  type DesktopDiagnosticEnvironment,
} from './main-process-diagnostics.js';
import { getNativeDiagnosticDialogCopy } from './native-diagnostic-dialog-copy.js';
import { whileAwaitingPerson } from './startup-step.js';

interface DiagnosticDialogDeps {
  readonly locale: UiLocale;
  readonly copyDiagnostics: () => void | Promise<void>;
  readonly showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
}

interface FatalStartupDiagnosticDialogDeps {
  readonly locale: UiLocale;
  readonly environment: () => DesktopDiagnosticEnvironment;
  readonly mainLogs: () => readonly string[];
  readonly writeClipboard: (value: string) => void;
  readonly showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
}

export interface RuntimeHostStartupRecoveryDialogInput {
  readonly startupError: Error;
  readonly repairError?: Error;
  readonly activeTasks: boolean;
}

export function defaultRuntimeHostRecoveryDialog(input: {
  readonly locale: UiLocale;
  readonly profileName: string;
  readonly error: Error;
}): { readonly options: MessageBoxOptions; readonly diagnosticDetails: string } {
  const copy = getNativeDiagnosticDialogCopy(input.locale).defaultRuntimeHostRecovery;
  return {
    options: {
      type: 'warning',
      title: copy.title,
      message: copy.connectFailed(input.profileName),
      detail: copy.detail,
      buttons: [copy.retry, copy.useLocal, copy.keepOffline],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    },
    diagnosticDetails: input.error.stack ?? `${input.error.name}: ${input.error.message}`,
  };
}

export async function showMessageBoxWithDiagnostics(
  options: MessageBoxOptions,
  deps: DiagnosticDialogDeps,
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
  deps: FatalStartupDiagnosticDialogDeps,
): Promise<void> {
  const copy = getNativeDiagnosticDialogCopy(deps.locale).fatalStartup;
  const message = error instanceof Error ? error.message : String(error);
  const input = createDesktopStartupDiagnosticInput({
    // The diagnostic report is machine-facing and stays English regardless of locale.
    title: 'Maka failed to start',
    description: message || 'Unknown startup error',
    ...(error instanceof Error && error.stack ? { details: error.stack } : {}),
  });
  await showMessageBoxWithDiagnostics(
    {
      type: 'error',
      title: copy.title,
      message: copy.message,
      detail: copy.detail,
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

export async function showMainRendererProcessGoneDialog(
  deps: DiagnosticDialogDeps,
): Promise<'relaunch' | 'exit'> {
  const copy = getNativeDiagnosticDialogCopy(deps.locale).rendererGone;
  const result = await showMessageBoxWithDiagnostics(
    {
      type: 'error',
      title: copy.title,
      message: copy.message,
      detail: copy.detail,
      buttons: [copy.relaunch, copy.exit],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    },
    deps,
  );
  return result.response === 0 ? 'relaunch' : 'exit';
}

export async function showRuntimeHostStartupRecoveryDialog(
  input: RuntimeHostStartupRecoveryDialogInput,
  deps: DiagnosticDialogDeps,
): Promise<'repair' | 'exit'> {
  const copy = getNativeDiagnosticDialogCopy(deps.locale).runtimeHostRecovery;
  const detail = [
    copy.detail,
    input.activeTasks ? copy.activeTasks : undefined,
    input.repairError ? copy.repairFailed : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
  const result = await showMessageBoxWithDiagnostics(
    {
      type: 'warning',
      title: copy.title,
      message: copy.message,
      detail,
      buttons: [input.activeTasks ? copy.repairAndRestart : copy.repair, copy.exit],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    },
    deps,
  );
  return result.response === 0 ? 'repair' : 'exit';
}

async function copyDiagnostics(
  copy: () => void | Promise<void>,
  locale: UiLocale,
): Promise<string> {
  try {
    await copy();
    return getNativeDiagnosticDialogCopy(locale).dialog.copied;
  } catch (error) {
    console.error('[diagnostics] native clipboard write failed:', error);
    return getNativeDiagnosticDialogCopy(locale).dialog.copyFailed;
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
  const copy = getNativeDiagnosticDialogCopy(locale).dialog;
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
