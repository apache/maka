import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import { registerRuntimeHostSessionCatalogIpc } from '../runtime-host-session-catalog-ipc-main.js';

test('projects observed running Turn identities into renderer Session lists', async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostSessionCatalogIpc(
    {
      client: {
        listSessions: async () => [session('running'), session('idle')],
      } as never,
      runningTurnIds: (sessionId) =>
        sessionId === 'running' ? ['turn-live'] : [],
      resolveCreateProject: async () => ({ kind: 'host_path', path: '/workspace' }),
      emitSessionsChanged() {},
      releaseSessionResources() {},
      sessionCopyCleanup: {
        recover: async () => ({ failed: [] }),
      } as never,
    },
    {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
  );

  const list = handlers.get('sessions:list');
  assert.ok(list);
  const projected = await list({} as never) as Array<{ id: string; runningTurnIds?: string[] }>;

  assert.deepEqual(projected.find(({ id }) => id === 'running')?.runningTurnIds, ['turn-live']);
  assert.equal(
    Object.hasOwn(projected.find(({ id }) => id === 'idle') ?? {}, 'runningTurnIds'),
    false,
  );
});

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
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: true,
    model: 'fake-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}
