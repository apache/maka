import type { SessionChangedReason } from '@maka/core/session';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import type {
  ExternalSessionCatalogQueryInput,
  ExternalSessionCatalogQueryResult,
  ExternalSessionSourceQueryResult,
  SessionCatalogProjection,
} from '@maka/runtime-host/protocol';
import {
  decodeExternalSessionCatalogQueryInput,
  decodeExternalSessionImportInput,
} from '@maka/runtime-host/protocol';
import type { ExternalSessionImportIpcResult } from '../preload/external-session-import-result.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';
import { toDesktopHostSessionSummary } from './runtime-host-session-catalog-ipc-main.js';

type ExternalSessionClient = {
  listExternalSessionSources(): Promise<ExternalSessionSourceQueryResult>;
  listExternalSessions(
    input: ExternalSessionCatalogQueryInput,
  ): Promise<ExternalSessionCatalogQueryResult>;
  importExternalSession(input: {
    readonly adapterId: string;
    readonly sourceSessionId: string;
  }): Promise<SessionCatalogProjection>;
};

export interface RuntimeHostExternalSessionsIpcDeps {
  readonly client: ExternalSessionClient;
  readonly emitSessionsChanged: (reason: SessionChangedReason, sessionId?: string) => void;
}

export function registerRuntimeHostExternalSessionsIpc(
  deps: RuntimeHostExternalSessionsIpcDeps,
  ipcMain: ReconnectableReadIpcMain,
): void {
  handleReconnectableRead(ipcMain, 'external-sessions:listSources', () =>
    deps.client.listExternalSessionSources(),
  );
  handleReconnectableRead(ipcMain, 'external-sessions:list', async (_event, input: unknown) => {
    const result = await deps.client.listExternalSessions(
      decodeExternalSessionCatalogQueryInput(input),
    );
    return {
      ...result,
      sessions: result.sessions.map(({ hostCwd, ...session }) => ({
        ...session,
        cwd: hostCwd,
      })),
    };
  });
  ipcMain.handle('external-sessions:import', async (_event, input: unknown) => {
    try {
      const session = await deps.client.importExternalSession(
        decodeExternalSessionImportInput(input),
      );
      deps.emitSessionsChanged('created', session.id);
      return {
        ok: true,
        session: toDesktopHostSessionSummary(session),
      } satisfies ExternalSessionImportIpcResult;
    } catch (error) {
      if (
        error instanceof RuntimeHostOperationError &&
        error.operation === 'external-session.import' &&
        error.code === 'commit_outcome_unknown'
      ) {
        return {
          ok: false,
          reason: 'commit_outcome_unknown',
        } satisfies ExternalSessionImportIpcResult;
      }
      throw error;
    }
  });
}
