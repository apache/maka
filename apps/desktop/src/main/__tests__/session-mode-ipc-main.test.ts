/**
 * The Session's mode is one choice held in two persisted fields. It has to
 * reach the Host as one mutation, or a failure between two writes leaves the
 * Session in neither the mode it had nor the one that was asked for.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IpcMain } from 'electron';
import type { DesktopSessionConfigurationPatch } from '../runtime-host-client.js';
import {
  registerRuntimeHostSessionCatalogIpc,
  type RuntimeHostSessionCatalogIpcDeps,
} from '../runtime-host-session-catalog-ipc-main.js';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** Only the fields `toDesktopHostSessionSummary` reads back out. */
function projection(sessionId: string) {
  return {
    id: sessionId,
    revision: 1,
    workspace: { hostCwd: '/tmp/session', target: { kind: 'path' as const } },
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    status: 'active' as const,
    createdAt: 1,
    lastUsedAt: 1,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake-model',
    permissionMode: 'ask' as const,
    collaborationMode: 'agent' as const,
    orchestrationMode: 'default' as const,
  };
}

function harness(patches: DesktopSessionConfigurationPatch[]) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
  };
  const deps = {
    client: {
      async updateSessionConfiguration(sessionId: string, patch: DesktopSessionConfigurationPatch) {
        patches.push(patch);
        return projection(sessionId);
      },
    },
    resolveCreateProject: async () => ({}),
    emitSessionsChanged() {},
    releaseSessionResources() {},
    sessionCopyCleanup: { recover: async () => ({ cleaned: [], failed: [] }) },
  } as unknown as RuntimeHostSessionCatalogIpcDeps;
  registerRuntimeHostSessionCatalogIpc(deps, ipcMain as unknown as IpcMain);
  return {
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      assert.ok(handler, `missing handler: ${channel}`);
      return handler({}, ...args);
    },
    channels: handlers,
  };
}

test('the whole mode reaches the Host as one configuration patch', async () => {
  const patches: DesktopSessionConfigurationPatch[] = [];
  const ipc = harness(patches);

  await ipc.invoke('sessions:setSessionMode', 'session-1', {
    collaborationMode: 'plan',
    orchestrationMode: 'default',
  });

  assert.deepEqual(patches, [{ collaborationMode: 'plan', orchestrationMode: 'default' }]);
  // No per-field channel survives, so no caller can write one without the other.
  assert.equal(ipc.channels.has('sessions:setCollaborationMode'), false);
  assert.equal(ipc.channels.has('sessions:setOrchestrationMode'), false);
});

test('a complete but illegal pair is refused, not persisted', async () => {
  const patches: DesktopSessionConfigurationPatch[] = [];
  const ipc = harness(patches);

  // Both values are individually valid; the pair is not. Plan strips the tools
  // Swarm and Graph are made of, so this Session could not be honoured.
  await assert.rejects(
    ipc.invoke('sessions:setSessionMode', 'session-1', {
      collaborationMode: 'plan',
      orchestrationMode: 'swarm',
    }) as Promise<unknown>,
    /cannot be combined/,
  );
  await assert.rejects(
    ipc.invoke('sessions:setSessionMode', 'session-1', {
      collaborationMode: 'plan',
      orchestrationMode: 'graph',
    }) as Promise<unknown>,
  );
  assert.deepEqual(patches, [], 'nothing reached the Host');
});

test('a half-named mode is refused rather than half-applied', async () => {
  const patches: DesktopSessionConfigurationPatch[] = [];
  const ipc = harness(patches);

  await assert.rejects(
    ipc.invoke('sessions:setSessionMode', 'session-1', { collaborationMode: 'plan' }) as Promise<unknown>,
  );
  await assert.rejects(
    ipc.invoke('sessions:setSessionMode', 'session-1', { orchestrationMode: 'swarm' }) as Promise<unknown>,
  );
  await assert.rejects(ipc.invoke('sessions:setSessionMode', 'session-1', 'plan') as Promise<unknown>);
  assert.deepEqual(patches, []);
});
