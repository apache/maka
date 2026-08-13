import assert from 'node:assert/strict';
import test from 'node:test';
import type { IpcMain } from 'electron';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import {
  registerRuntimeHostExternalSessionsIpc,
  type RuntimeHostExternalSessionsIpcDeps,
} from '../runtime-host-external-sessions-ipc-main.js';
import { toDesktopHostSessionSummary } from '../runtime-host-session-catalog-ipc-main.js';

test('forwards bounded external Session requests and publishes imported Sessions', async () => {
  const requests: unknown[] = [];
  const events: Array<{ reason: string; sessionId?: string }> = [];
  const ipc = ipcHarness();
  registerRuntimeHostExternalSessionsIpc(
    {
      client: clientFixture({
        listExternalSessions: async (input) => {
          requests.push(input);
          return {
            sessions: [{ id: 'source-1', name: 'Source', hostCwd: '/external' }],
            nextCursor: '16',
          };
        },
        importExternalSession: async (input) => {
          requests.push(input);
          return session('imported-1');
        },
      }),
      emitSessionsChanged: (reason, sessionId) => events.push({ reason, sessionId }),
    },
    ipc,
  );

  assert.deepEqual(await ipc.invoke('external-sessions:listSources'), { adapterIds: ['codex'] });
  assert.deepEqual(
    await ipc.invoke('external-sessions:list', {
      adapterId: 'codex',
      includeArchived: true,
      cursor: '16',
    }),
    {
      sessions: [{ id: 'source-1', name: 'Source', cwd: '/external' }],
      nextCursor: '16',
    },
  );
  assert.deepEqual(
    await ipc.invoke('external-sessions:import', {
      adapterId: 'codex',
      sourceSessionId: 'source-1',
    }),
    { ok: true, session: toDesktopHostSessionSummary(session('imported-1')) },
  );
  assert.deepEqual(requests, [
    { adapterId: 'codex', includeArchived: true, cursor: '16' },
    { adapterId: 'codex', sourceSessionId: 'source-1' },
  ]);
  assert.deepEqual(events, [{ reason: 'created', sessionId: 'imported-1' }]);
});

test('preserves commit uncertainty as a structured non-retryable IPC result', async () => {
  const events: unknown[] = [];
  const ipc = ipcHarness();
  registerRuntimeHostExternalSessionsIpc(
    {
      client: clientFixture({
        importExternalSession: async () => {
          throw new RuntimeHostOperationError(
            'external-session.import',
            'commit_outcome_unknown',
            'check the Session list before retrying',
          );
        },
      }),
      emitSessionsChanged: (reason, sessionId) => events.push({ reason, sessionId }),
    },
    ipc,
  );

  assert.deepEqual(
    await ipc.invoke('external-sessions:import', {
      adapterId: 'codex',
      sourceSessionId: 'source-1',
    }),
    { ok: false, reason: 'commit_outcome_unknown' },
  );
  assert.deepEqual(events, []);
});

test('rejects malformed renderer requests before they reach the Host client', async () => {
  let calls = 0;
  const ipc = ipcHarness();
  registerRuntimeHostExternalSessionsIpc(
    {
      client: clientFixture({
        listExternalSessions: async () => {
          calls += 1;
          return { sessions: [], nextCursor: null };
        },
        importExternalSession: async () => {
          calls += 1;
          return session('unexpected');
        },
      }),
      emitSessionsChanged() {},
    },
    ipc,
  );

  await assert.rejects(
    () => ipc.invoke('external-sessions:list', { adapterId: 'codex', cursor: '-1' }),
    /Invalid external Session cursor/,
  );
  await assert.rejects(
    () =>
      ipc.invoke('external-sessions:import', {
        adapterId: 'codex',
        sourceSessionId: 'bad\nsource',
      }),
    /Invalid external source Session id/,
  );
  assert.equal(calls, 0);
});

type ExternalSessionClient = RuntimeHostExternalSessionsIpcDeps['client'];

function clientFixture(overrides: Partial<ExternalSessionClient> = {}): ExternalSessionClient {
  return {
    listExternalSessionSources: async () => ({ adapterIds: ['codex'] }),
    listExternalSessions: async () => ({ sessions: [], nextCursor: null }),
    importExternalSession: async () => session('imported'),
    ...overrides,
  };
}

type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];

function ipcHarness() {
  const handlers = new Map<string, IpcHandler>();
  return {
    handle(channel: string, handler: IpcHandler): void {
      handlers.set(channel, handler);
    },
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      assert.ok(handler, `missing handler: ${channel}`);
      return handler({ sender: { id: 1 } } as never, ...args);
    },
  };
}

function session(id: string): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: '/workspace' },
      hostCwd: '/workspace',
    },
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Imported',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'default',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}
