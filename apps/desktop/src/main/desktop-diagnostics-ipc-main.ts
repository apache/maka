import type { IpcMain } from 'electron';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { redactSecrets } from '@maka/core/redaction';
import type { HostDiagnosticsResult } from '@maka/runtime-host/protocol';
import type { DesktopDiagnosticCopyResult } from '../preload/diagnostics-contract.js';
import {
  formatDesktopErrorDiagnosticReport,
  parseDesktopErrorDiagnosticInput,
  type DesktopDiagnosticEnvironment,
  type RuntimeHostDiagnosticRead,
} from './main-process-diagnostics.js';

export interface DesktopDiagnosticsIpcDeps {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly environment: () => DesktopDiagnosticEnvironment;
  readonly mainLogs: () => readonly string[];
  readonly getRuntimeHostDiagnostics: () => Promise<HostDiagnosticsResult>;
  readonly writeClipboard: (value: string) => void;
}

export function registerDesktopDiagnosticsIpc(deps: DesktopDiagnosticsIpcDeps): void {
  deps.ipcMain.handle(
    'diagnostics:copyErrorReport',
    async (_event, rawInput: unknown): Promise<DesktopDiagnosticCopyResult> => {
      const input = parseDesktopErrorDiagnosticInput(rawInput);
      let runtimeHost: RuntimeHostDiagnosticRead;
      try {
        runtimeHost = { ok: true, value: await deps.getRuntimeHostDiagnostics() };
      } catch (error) {
        runtimeHost = {
          ok: false,
          error: truncateUtf8(
            redactSecrets(error instanceof Error ? error.message : String(error)),
            1024,
          ),
        };
      }
      const report = formatDesktopErrorDiagnosticReport(
        input,
        deps.environment(),
        deps.mainLogs(),
        runtimeHost,
      );
      try {
        deps.writeClipboard(report);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'clipboard_unavailable' };
      }
    },
  );
}
