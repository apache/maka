import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExternalSessionAdapterRegistry,
  type CreateSessionInput,
  type SessionHeader,
  type StoredMessage,
} from '@maka/core';
import { headerToSummary } from '@maka/runtime';
import type { SessionCatalogRecord } from '@maka/storage/execution-stores';
import type { IpcMain } from 'electron';
import { registerEmbeddedExternalSessionsIpc } from '../embedded-external-sessions-ipc-main.js';

test('wires discovery and import to embedded Session storage', async () => {
  const ipc = ipcHarness();
  const records = new Map<string, SessionCatalogRecord>();
  const creates: Array<{ input: CreateSessionInput; messages: readonly StoredMessage[] }> = [];
  const events: Array<{ reason: string; sessionId?: string }> = [];
  registerEmbeddedExternalSessionsIpc(
    {
      adapters: adapterRegistry(),
      store: {
        async createImportedSession(input, messages) {
          creates.push({ input, messages });
          const header = sessionHeader('imported-1', input);
          records.set(header.id, {
            header,
            revision: 1,
            committedAt: 1,
            summary: headerToSummary(header),
          });
          return header;
        },
        async readCatalogRecord(sessionId) {
          const record = records.get(sessionId);
          if (!record) throw new Error(`missing record: ${sessionId}`);
          return record;
        },
      },
      resolveTarget: async () => target(),
      emitSessionsChanged: (reason, sessionId) => events.push({ reason, sessionId }),
    },
    ipc,
  );

  assert.deepEqual(await ipc.invoke('external-sessions:listSources'), {
    adapterIds: ['codex'],
  });
  assert.deepEqual(await ipc.invoke('external-sessions:list', { adapterId: 'codex' }), {
    sessions: [{ id: 'source-1', name: 'External source', cwd: '/external' }],
    nextCursor: null,
  });
  const result = await ipc.invoke('external-sessions:import', {
    adapterId: 'codex',
    sourceSessionId: 'source-1',
  });

  assert.equal((result as { ok: boolean }).ok, true);
  assert.equal((result as { session: { id: string } }).session.id, 'imported-1');
  assert.deepEqual(
    creates.map(({ input, messages }) => ({
      cwd: input.cwd,
      name: input.name,
      connection: input.llmConnectionSlug,
      messageTypes: messages.map(({ type }) => type),
    })),
    [
      {
        cwd: '/external',
        name: 'External source',
        connection: 'embedded-default',
        messageTypes: ['user'],
      },
    ],
  );
  assert.deepEqual(events, [{ reason: 'created', sessionId: 'imported-1' }]);
});

test('preserves embedded commit uncertainty as a structured IPC result', async () => {
  const ipc = ipcHarness();
  registerEmbeddedExternalSessionsIpc(
    {
      adapters: adapterRegistry(),
      store: {
        async createImportedSession() {
          throw new Error('commit acknowledgement lost');
        },
        async readCatalogRecord() {
          assert.fail('A failed commit acknowledgement must not be projected');
        },
      },
      resolveTarget: async () => target(),
      emitSessionsChanged() {
        assert.fail('An uncertain import must not publish a created event');
      },
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
});

function adapterRegistry(): ExternalSessionAdapterRegistry {
  return new ExternalSessionAdapterRegistry([
    {
      id: 'codex',
      detect: async () => true,
      listSessions: async () => [
        { id: 'source-1', name: 'External source', cwd: '/external' },
      ],
      readSession: async (sourceSessionId) => ({
        sourceSessionId,
        metadata: { name: 'External source', cwd: '/external' },
        messages: [
          {
            type: 'user',
            id: 'message-1',
            turnId: 'turn-1',
            ts: 1,
            text: 'hello',
          },
        ],
      }),
    },
  ]);
}

function target(): Omit<CreateSessionInput, 'cwd' | 'name'> {
  return {
    backend: 'ai-sdk',
    llmConnectionSlug: 'embedded-default',
    model: 'embedded-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}

function sessionHeader(id: string, input: CreateSessionInput): SessionHeader {
  return {
    id,
    workspaceRoot: '/workspace',
    cwd: input.cwd,
    createdAt: 1,
    lastUsedAt: 1,
    name: input.name ?? 'Imported',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: input.backend,
    llmConnectionSlug: input.llmConnectionSlug,
    connectionLocked: true,
    model: input.model ?? 'embedded-model',
    permissionMode: input.permissionMode,
    collaborationMode: input.collaborationMode,
    orchestrationMode: input.orchestrationMode,
    schemaVersion: 1,
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
