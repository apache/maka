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

import type { IpcMain } from 'electron';
import {
  copyDesktopDiagnosticReport,
  createDesktopPreviousMainProcessDiagnosticInput,
  parseDesktopDiagnosticInput,
  type DesktopDiagnosticsDeps,
} from './main-process-diagnostics.js';
import type { MainProcessRecoveryEvidence } from './main-process-recovery-journal.js';

export interface DesktopDiagnosticsIpcDeps extends DesktopDiagnosticsDeps {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
}

export function registerDesktopDiagnosticsIpc(deps: DesktopDiagnosticsIpcDeps): void {
  deps.ipcMain.handle(
    'diagnostics:copyReport',
    async (_event, scope: unknown, rawInput: unknown): Promise<void> => {
      const input = parseDesktopDiagnosticInput(rawInput);
      await copyDesktopDiagnosticReport(deps, input, scope);
    },
  );
}

export interface PreviousMainProcessDiagnosticsIpcDeps extends DesktopDiagnosticsIpcDeps {
  readonly evidence: MainProcessRecoveryEvidence | undefined;
  readonly acknowledge: () => void;
}

export function registerPreviousMainProcessDiagnosticsIpc(
  deps: PreviousMainProcessDiagnosticsIpcDeps,
): void {
  let noticeAvailable = deps.evidence !== undefined;
  deps.ipcMain.handle('diagnostics:takePreviousMainProcessInterruption', (): boolean => {
    if (!noticeAvailable) return false;
    deps.acknowledge();
    noticeAvailable = false;
    return true;
  });
  deps.ipcMain.handle('diagnostics:copyPreviousMainProcessInterruption', async (): Promise<void> => {
    if (!deps.evidence) throw new Error('Previous-session diagnostics are unavailable');
    await copyDesktopDiagnosticReport(
      deps,
      createDesktopPreviousMainProcessDiagnosticInput(deps.evidence),
    );
  });
}
