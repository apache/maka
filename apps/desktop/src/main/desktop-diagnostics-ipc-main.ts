import type { IpcMain } from 'electron';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { redactSecrets } from '@maka/core/redaction';
import type { TurnTrace } from '@maka/core/session-trace';
import type { HostDiagnosticsResult } from '@maka/runtime-host/protocol';
import type { DesktopDiagnosticCopyResult } from '../preload/diagnostics-contract.js';
import {
  formatDesktopErrorDiagnosticReport,
  parseDesktopErrorDiagnosticInput,
  type DesktopDiagnosticEnvironment,
  type RuntimeHostDiagnosticRead,
  type RuntimeHostExecutionDiagnosticRead,
} from './main-process-diagnostics.js';

export interface DesktopDiagnosticsIpcDeps {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly environment: () => DesktopDiagnosticEnvironment;
  readonly mainLogs: () => readonly string[];
  readonly getRuntimeHostDiagnostics: () => Promise<HostDiagnosticsResult>;
  readonly getRuntimeHostTurnTrace: (sessionId: string, turnId: string) => Promise<TurnTrace | undefined>;
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
      let runtimeExecution: RuntimeHostExecutionDiagnosticRead | undefined;
      if (input.execution) {
        try {
          const turn = await deps.getRuntimeHostTurnTrace(
            input.execution.sessionId,
            input.execution.turnId,
          );
          runtimeExecution = turn
            ? { ok: true, value: turn }
            : { ok: false, error: 'Execution evidence was not found' };
        } catch (error) {
          runtimeExecution = {
            ok: false,
            error: truncateUtf8(
              redactSecrets(error instanceof Error ? error.message : String(error)),
              1024,
            ),
          };
        }
      }
      const report = formatDesktopErrorDiagnosticReport(
        input,
        deps.environment(),
        deps.mainLogs(),
        runtimeHost,
        runtimeExecution,
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
