import type { IpcMain } from 'electron';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { redactSecrets } from '@maka/core/redaction';
import type { TurnTrace } from '@maka/core/session-trace';
import type { HostDiagnosticsResult } from '@maka/runtime-host/protocol';
import type { DesktopDiagnosticCopyResult } from '../preload/diagnostics-contract.js';
import {
  parseDesktopSessionKey,
  requireDesktopTargetScope,
  type DesktopTargetScope,
} from '../shared/runtime-host-identity.js';
import {
  formatDesktopDiagnosticReport,
  parseDesktopDiagnosticInput,
  type DesktopDiagnosticEnvironment,
  type RuntimeHostDiagnosticRead,
  type RuntimeHostExecutionDiagnosticRead,
} from './main-process-diagnostics.js';

type RuntimeHostDiagnosticsClient = {
  readonly getDiagnostics: () => Promise<HostDiagnosticsResult>;
  readonly getTurnTrace: (
    sessionId: string,
    turnId: string,
  ) => Promise<TurnTrace | undefined>;
};

export interface DesktopDiagnosticsIpcDeps {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly environment: () => DesktopDiagnosticEnvironment;
  readonly mainLogs: () => readonly string[];
  readonly resolveActiveRuntimeHost: () => RuntimeHostDiagnosticsClient | undefined;
  readonly resolveRuntimeHost: (scope: DesktopTargetScope) => RuntimeHostDiagnosticsClient | undefined;
  readonly writeClipboard: (value: string) => void;
}

export function registerDesktopDiagnosticsIpc(deps: DesktopDiagnosticsIpcDeps): void {
  deps.ipcMain.handle(
    'diagnostics:copyReport',
    async (_event, scope: unknown, rawInput: unknown): Promise<DesktopDiagnosticCopyResult> => {
      const input = parseDesktopDiagnosticInput(rawInput);
      let runtime: RuntimeHostDiagnosticsClient | undefined;
      if (input.surface !== 'manual') {
        runtime = deps.resolveRuntimeHost(requireDesktopTargetScope(scope));
      } else if (input.targetSessionId === undefined) {
        runtime = deps.resolveActiveRuntimeHost();
      } else if (scope !== undefined) {
        const target = requireDesktopTargetScope(scope);
        if (target.hostId !== parseDesktopSessionKey(input.targetSessionId).hostId) {
          throw new Error('Desktop diagnostic target belongs to a different Runtime Host');
        }
        try {
          runtime = deps.resolveRuntimeHost(target);
        } catch {
          // A task's Host may disappear between preload scope resolution and
          // this handler. Manual capture still returns Desktop diagnostics.
          runtime = undefined;
        }
      }
      let runtimeHost: RuntimeHostDiagnosticRead;
      if (!runtime) {
        runtimeHost = {
          ok: false,
          error: input.surface === 'manual'
            ? input.targetSessionId === undefined
              ? 'Runtime Host is unavailable'
              : 'Runtime Host for this task is unavailable'
            : 'Runtime Host is reconnecting',
        };
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
      const execution = input.surface === 'manual' ? undefined : input.execution;
      if (execution && runtime) {
        try {
          const turn = await runtime.getTurnTrace(
            execution.sessionId,
            execution.turnId,
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
      const report = formatDesktopDiagnosticReport(
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
