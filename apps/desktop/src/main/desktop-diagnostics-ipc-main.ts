import type { IpcMain } from 'electron';
import {
  copyDesktopDiagnosticReport,
  parseDesktopDiagnosticInput,
  type DesktopDiagnosticsDeps,
} from './main-process-diagnostics.js';

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
