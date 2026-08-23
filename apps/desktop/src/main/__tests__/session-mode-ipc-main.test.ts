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

/**
 * Plan and orchestration are two Session fields with two lifetimes, so they
 * are two channels here, and each writes only its own field. A Plan excursion
 * that cleared the orchestration default would lose it for the execution the
 * plan was written for — Runtime leaves Plan by itself on approval, and the
 * default has to still be there when it does.
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

test('entering or leaving Plan writes the collaboration field alone', async () => {
  const patches: DesktopSessionConfigurationPatch[] = [];
  const ipc = harness(patches);

  await ipc.invoke('sessions:setCollaborationMode', 'session-1', 'plan');
  await ipc.invoke('sessions:setCollaborationMode', 'session-1', 'agent');

  assert.deepEqual(patches, [{ collaborationMode: 'plan' }, { collaborationMode: 'agent' }]);
});

test('the orchestration default writes its own field alone', async () => {
  const patches: DesktopSessionConfigurationPatch[] = [];
  const ipc = harness(patches);

  await ipc.invoke('sessions:setOrchestrationMode', 'session-1', 'swarm');
  await ipc.invoke('sessions:setOrchestrationMode', 'session-1', 'default');

  assert.deepEqual(patches, [{ orchestrationMode: 'swarm' }, { orchestrationMode: 'default' }]);
});

test('a Plan Session keeps the orchestration default it was carrying', async () => {
  const patches: DesktopSessionConfigurationPatch[] = [];
  const ipc = harness(patches);

  await ipc.invoke('sessions:setOrchestrationMode', 'session-1', 'swarm');
  await ipc.invoke('sessions:setCollaborationMode', 'session-1', 'plan');

  // Nothing in the Plan write names `orchestrationMode`, so the merge at the
  // Host leaves Swarm standing. Plan strips the tools it needs for as long as
  // the excursion lasts; it does not end it.
  assert.deepEqual(patches[1], { collaborationMode: 'plan' });
  assert.equal('orchestrationMode' in (patches[1] ?? {}), false);
});

test('an unknown mode is refused rather than persisted', async () => {
  const patches: DesktopSessionConfigurationPatch[] = [];
  const ipc = harness(patches);

  await assert.rejects(
    ipc.invoke('sessions:setCollaborationMode', 'session-1', 'swarm') as Promise<unknown>,
    /Invalid collaboration mode/,
  );
  await assert.rejects(
    ipc.invoke('sessions:setOrchestrationMode', 'session-1', 'plan') as Promise<unknown>,
    /Invalid orchestration mode/,
  );
  assert.deepEqual(patches, [], 'nothing reached the Host');
});
