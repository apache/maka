import type { CreateSessionInput, SessionChangedReason } from '@maka/core';
import type { ExternalSessionAdapterRegistry } from '@maka/core/external-session';
import { HostExternalSessionCoordinator } from '@maka/runtime-host/external-sessions';
import {
  decodeExternalSessionCatalogQueryInput,
  decodeExternalSessionImportInput,
} from '@maka/runtime-host/protocol';
import type { SessionAuthorityStore } from '@maka/storage';
import type { IpcMain } from 'electron';
import type { ExternalSessionImportIpcResult } from '../preload/external-session-import-result.js';
import { toDesktopHostSessionSummary } from './runtime-host-session-catalog-ipc-main.js';

export interface EmbeddedExternalSessionsIpcDeps {
  readonly adapters: ExternalSessionAdapterRegistry;
  readonly store: Pick<SessionAuthorityStore, 'createImportedSession' | 'readCatalogRecord'>;
  readonly resolveTarget: () => Promise<Omit<CreateSessionInput, 'cwd' | 'name'>>;
  readonly emitSessionsChanged: (reason: SessionChangedReason, sessionId?: string) => void;
}

/**
 * Gives the embedded Desktop owner the same external-Session coordinator as
 * Runtime Host. Raw source messages stay in main and only bounded catalog
 * projections cross Electron IPC.
 */
export function registerEmbeddedExternalSessionsIpc(
  deps: EmbeddedExternalSessionsIpcDeps,
  ipcMain: Pick<IpcMain, 'handle'>,
): void {
  const coordinator = new HostExternalSessionCoordinator({
    adapters: deps.adapters,
    sessions: deps.store,
    resolveTarget: deps.resolveTarget,
    // Embedded writes have no separate Host process to drain. The structured
    // result still tells the renderer to inspect the Session list before retrying.
    requestDrain() {},
  });

  ipcMain.handle('external-sessions:listSources', async () => {
    const outcome = await coordinator.listSources();
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.result;
  });
  ipcMain.handle('external-sessions:list', async (_event, input: unknown) => {
    const outcome = await coordinator.listSessions(
      decodeExternalSessionCatalogQueryInput(input),
    );
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.result;
  });
  ipcMain.handle('external-sessions:import', async (_event, input: unknown) => {
    const outcome = await coordinator.importSession(decodeExternalSessionImportInput(input));
    if (!outcome.ok) {
      if (outcome.error.code === 'commit_outcome_unknown') {
        return {
          ok: false,
          reason: 'commit_outcome_unknown',
        } satisfies ExternalSessionImportIpcResult;
      }
      throw new Error(outcome.error.message);
    }

    const imported = outcome.result.session;
    if ('kind' in imported) {
      return {
        ok: false,
        reason: 'commit_outcome_unknown',
      } satisfies ExternalSessionImportIpcResult;
    }
    const session = toDesktopHostSessionSummary(imported);
    deps.emitSessionsChanged('created', session.id);
    return { ok: true, session } satisfies ExternalSessionImportIpcResult;
  });
}
