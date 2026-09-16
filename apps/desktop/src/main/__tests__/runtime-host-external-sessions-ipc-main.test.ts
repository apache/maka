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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { IpcMain } from 'electron';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
import { decodeExternalSessionImportResult } from '@maka/runtime-host/protocol';
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
            sessions: [
              {
                id: 'source-1',
                name: 'Source',
                hostCwd: '/external',
                importState: {
                  importedCount: 0,
                  importedSessionIds: [],
                  isImporting: false,
                },
              },
            ],
            nextCursor: '16',
          };
        },
        importExternalSession: async (input) => {
          requests.push(input);
          return { kind: 'imported', session: session('imported-1') };
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
      sessions: [
        {
          id: 'source-1',
          name: 'Source',
          cwd: '/external',
          importState: {
            importedCount: 0,
            importedSessionIds: [],
            isImporting: false,
          },
        },
      ],
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

test('an uncertain commit still asks the shell to re-read the catalog', async () => {
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
  // The task may be in the catalog, so the shell has to look. The import page's
  // own banner cannot be the only trace: 导入任务 is a Settings page, and the
  // moment the user leaves it the banner is unmounted -- which is exactly when
  // they come back and import the same conversation again. No id, because not
  // knowing which task landed is what `commit_outcome_unknown` means.
  assert.deepEqual(events, [{ reason: 'created', sessionId: undefined }]);
});

test('keeps catalog eligibility owned by the Host after an uncertain import', async () => {
  const ipc = ipcHarness();
  registerRuntimeHostExternalSessionsIpc(
    {
      client: clientFixture({
        listExternalSessions: async () => ({
          sessions: [{
            id: 'source-1',
            name: 'Source',
            hostCwd: '/external',
            importState: { importedCount: 0, importedSessionIds: [], isImporting: false },
          }],
          nextCursor: null,
        }),
        importExternalSession: async () => {
          throw new RuntimeHostOperationError(
            'external-session.import',
            'commit_outcome_unknown',
            'check the Session list before retrying',
          );
        },
      }),
      emitSessionsChanged() {},
    },
    ipc,
  );

  await ipc.invoke('external-sessions:import', {
    adapterId: 'codex',
    sourceSessionId: 'source-1',
  });
  assert.deepEqual(await ipc.invoke('external-sessions:list', { adapterId: 'codex' }), {
    sessions: [{
      id: 'source-1',
      name: 'Source',
      cwd: '/external',
      importState: {
        importedCount: 0,
        importedSessionIds: [],
        isImporting: false,
      },
    }],
    nextCursor: null,
  });
});

test('a dispatched interrupted import has the same uncertain outcome as the Host error', async () => {
  const events: unknown[] = [];
  const ipc = ipcHarness();
  registerRuntimeHostExternalSessionsIpc(
    {
      client: clientFixture({
        importExternalSession: async () => {
          throw new RuntimeHostRequestInterruptedError(
            'external-session.import',
            'command',
            'dispatched',
            'connection_lost',
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
  assert.deepEqual(events, [{ reason: 'created', sessionId: undefined }]);
});

test('fails closed when a dispatched import response cannot be decoded', async () => {
  const events: unknown[] = [];
  const ipc = ipcHarness();
  registerRuntimeHostExternalSessionsIpc(
    {
      client: clientFixture({
        importExternalSession: async () => {
          throw new Error('Invalid external Session import result');
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
  assert.deepEqual(events, [{ reason: 'created', sessionId: undefined }]);
});

test('does not relabel an explicitly undispatched import as uncertain', async () => {
  const ipc = ipcHarness();
  registerRuntimeHostExternalSessionsIpc(
    {
      client: clientFixture({
        importExternalSession: async () => {
          throw new RuntimeHostRequestInterruptedError(
            'external-session.import',
            'command',
            'not_dispatched',
            'connection_lost',
          );
        },
      }),
      emitSessionsChanged() {},
    },
    ipc,
  );

  await assert.rejects(
    () =>
      ipc.invoke('external-sessions:import', {
        adapterId: 'codex',
        sourceSessionId: 'source-1',
      }),
    (error: unknown) =>
      error instanceof RuntimeHostRequestInterruptedError && error.dispatch === 'not_dispatched',
  );
});

test('maps a no-usable-model failure to a distinct, non-recovering reason', async () => {
  const events: unknown[] = [];
  const ipc = ipcHarness();
  registerRuntimeHostExternalSessionsIpc(
    {
      client: clientFixture({
        importExternalSession: async () => {
          throw new RuntimeHostOperationError(
            'external-session.import',
            'model_unavailable',
            'No usable Session model connection is available for import',
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
    { ok: false, reason: 'no_model' },
  );
  // A model-resolution failure never touched the catalog, so nothing to re-read.
  assert.deepEqual(events, []);
});

test('maps a pre-commit conversion failure to source_unreadable', async () => {
  const ipc = ipcHarness();
  registerRuntimeHostExternalSessionsIpc(
    {
      client: clientFixture({
        importExternalSession: async () => {
          throw new RuntimeHostOperationError(
            'external-session.import',
            'source_unreadable',
            'External Session could not be read or converted',
          );
        },
      }),
      emitSessionsChanged() {},
    },
    ipc,
  );

  assert.deepEqual(
    await ipc.invoke('external-sessions:import', {
      adapterId: 'codex',
      sourceSessionId: 'source-1',
    }),
    { ok: false, reason: 'source_unreadable' },
  );
});

test('maps a decoded source limit to IPC data without publishing a created Session', async () => {
  const events: string[] = [];
  const ipc = ipcHarness();
  const wireResult = decodeExternalSessionImportResult(JSON.parse(JSON.stringify({
    kind: 'source_limit_exceeded',
    limit: { kind: 'record_bytes', max: 67_108_864 },
  })));
  assert.equal(wireResult.kind, 'source_limit_exceeded');
  if (wireResult.kind !== 'source_limit_exceeded') assert.fail('Expected an import limit');
  registerRuntimeHostExternalSessionsIpc({
    client: clientFixture({ importExternalSession: async () => wireResult }),
    emitSessionsChanged: (reason) => events.push(reason),
  }, ipc);

  assert.deepEqual(await ipc.invoke('external-sessions:import', {
    adapterId: 'claude-code', sourceSessionId: 'source-1',
  }), {
    ok: false, reason: 'source_limit_exceeded', limit: { kind: 'record_bytes', max: 67_108_864 },
  });
  assert.deepEqual(events, []);
});

test('rethrows import failures that have no distinct renderer reason', async () => {
  const ipc = ipcHarness();
  registerRuntimeHostExternalSessionsIpc(
    {
      client: clientFixture({
        importExternalSession: async () => {
          // An unsupported adapter is a bad request, not a model or source
          // problem — it must NOT be relabeled as `source_unreadable`; it falls
          // through to the generic banner.
          throw new RuntimeHostOperationError(
            'external-session.import',
            'invalid_request',
            'External Session source is unsupported',
          );
        },
      }),
      emitSessionsChanged() {},
    },
    ipc,
  );

  await assert.rejects(
    () =>
      ipc.invoke('external-sessions:import', {
        adapterId: 'codex',
        sourceSessionId: 'source-1',
      }),
    /External Session source is unsupported/,
  );
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
          return { kind: 'imported', session: session('unexpected') };
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
    importExternalSession: async () => ({ kind: 'imported', session: session('imported') }),
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
    activityAt: 1,
    name: 'Imported',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'default',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}
