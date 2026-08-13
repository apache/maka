import type { IpcMain } from 'electron';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { redactSecrets } from '@maka/core/redaction';
import type { TurnTrace } from '@maka/core/session-trace';
import type { HostDiagnosticsResult } from '@maka/runtime-host/protocol';
import type { DesktopDiagnosticCopyResult } from '../preload/diagnostics-contract.js';
import {
  requireDesktopHostRef,
  type DesktopHostRef,
} from '../preload/runtime-host-identity.js';
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
  readonly resolveRuntimeHost: (scope: DesktopHostRef) =>
    | {
        readonly getDiagnostics: () => Promise<HostDiagnosticsResult>;
        readonly getTurnTrace: (
          sessionId: string,
          turnId: string,
        ) => Promise<TurnTrace | undefined>;
      }
    | undefined;
  readonly writeClipboard: (value: string) => void;
}

export function registerDesktopDiagnosticsIpc(deps: DesktopDiagnosticsIpcDeps): void {
  deps.ipcMain.handle(
    'diagnostics:copyErrorReport',
    async (_event, scope: unknown, rawInput: unknown): Promise<DesktopDiagnosticCopyResult> => {
      const host = requireDesktopHostRef(scope);
      const runtime = deps.resolveRuntimeHost(host);
      const input = parseDesktopErrorDiagnosticInput(rawInput);
      let runtimeHost: RuntimeHostDiagnosticRead;
      if (!runtime) {
        runtimeHost = { ok: false, error: 'Runtime Host is reconnecting' };
      } else {
        try {
          runtimeHost = { ok: true, value: await runtime.getDiagnostics() };
        } catch (error) {
          runtimeHost = {
            ok: false,
            error: truncateUtf8(
              redactSecrets(error instanceof Error ? error.message : String(error)),
              1024,
            ),
          };
        }
      }
      let runtimeExecution: RuntimeHostExecutionDiagnosticRead | undefined;
      if (input.execution && runtime) {
        try {
          const turn = await runtime.getTurnTrace(
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
