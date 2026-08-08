import type { IpcMain } from 'electron';
import type { SessionChangedReason } from '@maka/core';
import type {
  ExternalSessionCatalogQueryInput,
  ExternalSessionCatalogQueryResult,
  ExternalSessionSourceQueryResult,
  SessionCatalogProjection,
} from '@maka/runtime-host/protocol';

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
  ipcMain: Pick<IpcMain, 'handle'>,
): void {
  ipcMain.handle('external-sessions:listSources', () => deps.client.listExternalSessionSources());
  ipcMain.handle('external-sessions:list', (_event, input: unknown) =>
    deps.client.listExternalSessions(externalSessionListInput(input)),
  );
  ipcMain.handle('external-sessions:import', async (_event, input: unknown) => {
    const session = await deps.client.importExternalSession(externalSessionImportInput(input));
    deps.emitSessionsChanged('created', session.id);
    return session;
  });
}

function externalSessionListInput(value: unknown): ExternalSessionCatalogQueryInput {
  const input = record(value, 'Invalid external Session list request');
  const adapterId = identifier(input.adapterId, 'Invalid external Session source');
  const includeArchived = input.includeArchived;
  const cwd = input.cwd;
  const cursor = input.cursor;
  if (includeArchived !== undefined && typeof includeArchived !== 'boolean') {
    throw new Error('Invalid external Session archive filter');
  }
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0)) {
    throw new Error('Invalid external Session cwd filter');
  }
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^\d+$/.test(cursor))) {
    throw new Error('Invalid external Session cursor');
  }
  return {
    adapterId,
    ...(includeArchived === undefined ? {} : { includeArchived }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function externalSessionImportInput(value: unknown): {
  adapterId: string;
  sourceSessionId: string;
} {
  const input = record(value, 'Invalid external Session import request');
  const sourceSessionId = input.sourceSessionId;
  if (
    typeof sourceSessionId !== 'string' ||
    sourceSessionId.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(sourceSessionId)
  ) {
    throw new Error('Invalid external source Session id');
  }
  return {
    adapterId: identifier(input.adapterId, 'Invalid external Session source'),
    sourceSessionId,
  };
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, message: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(message);
  }
  return value;
}
