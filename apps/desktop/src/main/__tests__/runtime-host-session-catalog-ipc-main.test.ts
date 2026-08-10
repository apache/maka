import assert from 'node:assert/strict';
import test from 'node:test';
import type { IpcMain } from 'electron';
import { DEEP_RESEARCH_SESSION_NAME, DEFAULT_SESSION_NAME } from '@maka/core';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import {
  registerRuntimeHostSessionCatalogIpc,
  type RuntimeHostSessionCatalogIpcDeps,
} from '../runtime-host-session-catalog-ipc-main.js';

test('leaves ordinary Session defaults to the Host while preserving product modes', async () => {
  const creates: unknown[] = [];
  const events: Array<{ reason: string; sessionId?: string }> = [];
  const client = catalogClient({
    createSession: async (input) => {
      creates.push(input);
      return session(input.sessionId, {
        name: input.mode === 'deep_research' ? DEEP_RESEARCH_SESSION_NAME : input.name,
      });
    },
  });
  const ipc = ipcHarness();
  let sequence = 0;
  registerRuntimeHostSessionCatalogIpc(
    {
      client,
      resolveCreateProject: async () => ({ cwd: '/project', projectId: 'project-1' }),
      emitSessionsChanged: (reason, sessionId) => events.push({ reason, sessionId }),
      releaseSessionResources() {},
      sessionCopyCleanup: cleanupAuthority(),
      newId: () => `session-${++sequence}`,
    },
    ipc,
  );

  const ordinary = await ipc.invoke('sessions:create', undefined);
  const research = await ipc.invoke('sessions:create', {
    mode: 'deep_research',
    labels: ['customer-label'],
  });

  assert.equal((ordinary as { name: string }).name, DEFAULT_SESSION_NAME);
  assert.equal((research as { id: string }).id, 'session-2');
  assert.deepEqual(creates, [
    {
      sessionId: 'session-1',
      cwd: '/project',
      projectId: 'project-1',
      name: DEFAULT_SESSION_NAME,
      modelTarget: { kind: 'default' },
      collaborationMode: 'agent',
      orchestrationMode: 'default',
    },
    {
      sessionId: 'session-2',
      cwd: '/project',
      projectId: 'project-1',
      mode: 'deep_research',
      labels: ['customer-label'],
      modelTarget: { kind: 'default' },
      collaborationMode: 'agent',
      orchestrationMode: 'default',
    },
  ]);
  assert.deepEqual(events, [
    { reason: 'created', sessionId: 'session-1' },
    { reason: 'created', sessionId: 'session-2' },
  ]);
});

test('filters linked subagents without exposing the filter to the Host protocol', async () => {
  const filters: unknown[] = [];
  const child = session('child', {
    subagent: { parentSessionId: 'parent', agentName: 'Worker', profile: 'default' },
  });
  const client = catalogClient({
    listSessions: async (filter) => {
      filters.push(filter);
      return [session('parent'), child, session('other-child', { subagent: { parentSessionId: 'other' } })];
    },
  });
  const ipc = ipcHarness();
  registerRuntimeHostSessionCatalogIpc(
    {
      client,
      resolveCreateProject: defaultCreateProject,
      emitSessionsChanged() {},
      releaseSessionResources() {},
      sessionCopyCleanup: cleanupAuthority(),
    },
    ipc,
  );

  const listed = await ipc.invoke('sessions:list', { subagentParentSessionId: 'parent' });

  assert.deepEqual(filters, [undefined]);
  assert.ok(Array.isArray(listed));
  assert.equal(listed.length, 1);
  assert.equal((listed[0] as { id: string }).id, 'child');
  assert.deepEqual((listed[0] as { labels: string[] }).labels, []);
  assert.deepEqual((listed[0] as { subagent: unknown }).subagent, {
    parentSessionId: 'parent',
    agentName: 'Worker',
    profile: 'default',
  });
});

test('recovers and records Session copy cleanup through the Runtime Host catalog facade', async () => {
  const cleanupCalls: string[] = [];
  let recoveries = 0;
  const ipc = ipcHarness();
  registerRuntimeHostSessionCatalogIpc(
    {
      client: catalogClient({ listSessions: async () => [] }),
      resolveCreateProject: defaultCreateProject,
      emitSessionsChanged() {},
      releaseSessionResources() {},
      sessionCopyCleanup: {
        ownCreation: (_creation, operation) => operation(),
        cleanup: async (sessionId) => { cleanupCalls.push(`cleanup:${sessionId}`); },
        schedule: async (sessionId) => { cleanupCalls.push(`abandon:${sessionId}`); },
        abandonOwner: async () => undefined,
        recover: async () => {
          recoveries += 1;
          return { removed: [], failed: [] };
        },
      },
    },
    ipc,
  );

  assert.equal(recoveries, 1);
  await ipc.invoke('sessions:list');
  await ipc.invoke('sessions:list');
  await ipc.invoke('sessions:cleanupSessionCopy', 'copy-cleanup');
  await ipc.invoke('sessions:abandonSessionCopy', 'copy-abandon');

  assert.equal(recoveries, 1);
  assert.deepEqual(cleanupCalls, ['cleanup:copy-cleanup', 'abandon:copy-abandon']);
});

test('keeps abandoned copies hidden while durable cleanup is still pending', async () => {
  const ipc = ipcHarness();
  registerRuntimeHostSessionCatalogIpc(
    {
      client: catalogClient({
        listSessions: async () => [session('visible'), session('abandoned-copy')],
      }),
      resolveCreateProject: defaultCreateProject,
      emitSessionsChanged() {},
      releaseSessionResources() {},
      sessionCopyCleanup: {
        ownCreation: (_creation, operation) => operation(),
        cleanup: async () => undefined,
        schedule: async () => undefined,
        abandonOwner: async () => undefined,
        recover: async () => ({
          removed: [],
          failed: [{ sessionId: 'abandoned-copy', error: new Error('remove failed') }],
        }),
      },
    },
    ipc,
  );

  assert.deepEqual(
    (await ipc.invoke('sessions:list') as Array<{ id: string }>).map(({ id }) => id),
    ['visible'],
  );
});

test('applies family metadata and retirement actions through Host-owned operations', async () => {
  const metadata: unknown[] = [];
  const lifecycle: unknown[] = [];
  const removed: string[] = [];
  const released: string[] = [];
  const root = session('root', { revisionRootSessionId: 'root' });
  const revision = session('revision', { revisionRootSessionId: 'root' });
  const client = catalogClient({
    listSessions: async () => [root, revision],
    updateSessionMetadata: async (sessionId, patch) => {
      metadata.push({ sessionId, patch });
      return session(sessionId, { name: 'Renamed', revisionRootSessionId: 'root' });
    },
    setSessionLifecycle: async (sessionId, state) => {
      lifecycle.push({ sessionId, state });
      return session(sessionId, { isArchived: state === 'archived', revisionRootSessionId: 'root' });
    },
    removeSession: async (sessionId) => {
      removed.push(sessionId);
    },
  });
  const ipc = ipcHarness();
  registerRuntimeHostSessionCatalogIpc(
    {
      client,
      resolveCreateProject: defaultCreateProject,
      emitSessionsChanged() {},
      releaseSessionResources: async (sessionId) => {
        released.push(sessionId);
      },
      sessionCopyCleanup: cleanupAuthority(),
    },
    ipc,
  );

  await ipc.invoke('sessions:rename', 'revision', 'Renamed', { revisionFamily: true });
  await ipc.invoke('sessions:archive', 'root', { revisionFamily: true });
  await ipc.invoke('sessions:remove', 'revision', { revisionFamily: true });

  assert.deepEqual(metadata, [
    { sessionId: 'root', patch: { name: 'Renamed' } },
    { sessionId: 'revision', patch: { name: 'Renamed' } },
  ]);
  assert.deepEqual(lifecycle, [{ sessionId: 'root', state: 'archived' }]);
  assert.deepEqual(removed, ['revision']);
  assert.deepEqual(released, ['root', 'revision', 'root', 'revision']);
});

test('normalizes renderer configuration actions into Host patches', async () => {
  const patches: unknown[] = [];
  const client = catalogClient({
    updateSessionConfiguration: async (sessionId, patch) => {
      patches.push({ sessionId, patch });
      return session(sessionId);
    },
  });
  const ipc = ipcHarness();
  registerRuntimeHostSessionCatalogIpc(
    {
      client,
      resolveCreateProject: defaultCreateProject,
      emitSessionsChanged() {},
      releaseSessionResources() {},
      sessionCopyCleanup: cleanupAuthority(),
    },
    ipc,
  );

  await ipc.invoke('sessions:setModel', 'session-1', {
    llmConnectionSlug: 'test-connection',
    model: 'test-model',
  });
  await ipc.invoke('sessions:setThinkingLevel', 'session-1', undefined);
  await ipc.invoke('sessions:setPermissionMode', 'session-1', 'execute');

  assert.deepEqual(patches, [
    {
      sessionId: 'session-1',
      patch: {
        modelTarget: {
          kind: 'explicit',
          connectionSlug: 'test-connection',
          model: 'test-model',
        },
        thinkingLevel: null,
      },
    },
    { sessionId: 'session-1', patch: { thinkingLevel: null } },
    { sessionId: 'session-1', patch: { permissionMode: 'execute' } },
  ]);
});

type CatalogClient = RuntimeHostSessionCatalogIpcDeps['client'];

function cleanupAuthority(): RuntimeHostSessionCatalogIpcDeps['sessionCopyCleanup'] {
  return {
    ownCreation: (_creation, operation) => operation(),
    cleanup: async () => undefined,
    schedule: async () => undefined,
    abandonOwner: async () => undefined,
    recover: async () => ({ removed: [], failed: [] }),
  };
}

const defaultCreateProject: RuntimeHostSessionCatalogIpcDeps['resolveCreateProject'] = async () => ({
  cwd: '/workspace',
});

function catalogClient(overrides: Partial<CatalogClient>): CatalogClient {
  const unavailable = async (): Promise<never> => {
    throw new Error('Unexpected Runtime Host Session catalog operation');
  };
  return {
    createSession: unavailable,
    listSessions: unavailable,
    removeSession: unavailable,
    setSessionLifecycle: unavailable,
    updateSessionConfiguration: unavailable,
    updateSessionMetadata: unavailable,
    ...overrides,
  };
}

type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];

function ipcHarness() {
  const handlers = new Map<string, IpcHandler>();
  return {
    handle(channel: string, handler: IpcHandler) {
      assert.equal(handlers.has(channel), false, `duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    },
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      assert.ok(handler, `missing handler: ${channel}`);
      return handler({} as never, ...args);
    },
  };
}

function session(
  id: string,
  overrides: Partial<SessionCatalogProjection> = {},
): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test-connection',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}
