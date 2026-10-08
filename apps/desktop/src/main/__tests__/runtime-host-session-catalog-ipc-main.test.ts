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
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import type { IpcMain } from 'electron';
import type { SessionCatalogProjection, SessionCreateInput } from '@maka/runtime-host/protocol';
import {
  registerRuntimeHostSessionCatalogIpc,
  toDesktopHostSessionSummary,
  type RuntimeHostSessionCatalogIpcDeps,
} from '../runtime-host-session-catalog-ipc-main.js';
import { DesktopRuntimeHostClientError } from '../runtime-host-client.js';
import { createManagedTaskDirectoryAuthority } from '../managed-task-directory.js';

test('maps Runtime Host live run state without collapsing unknown and known-empty', () => {
  const unknown = toDesktopHostSessionSummary(projection());
  const knownEmpty = toDesktopHostSessionSummary(
    projection({ liveRunState: { schemaVersion: 1, runningTurnIds: [] } }),
  );
  const running = toDesktopHostSessionSummary(
    projection({ liveRunState: { schemaVersion: 1, runningTurnIds: ['turn-live'] } }),
  );

  assert.equal(Object.hasOwn(unknown, 'runningTurnIds'), false);
  assert.deepEqual(knownEmpty.runningTurnIds, []);
  assert.deepEqual(running.runningTurnIds, ['turn-live']);
});

test('preserves the Session revision in Owner Desktop Host summaries', () => {
  assert.equal(toDesktopHostSessionSummary(projection({ revision: 7 })).revision, 7);
});

test('session creation forwards the caller name for a mode that carries none', async () => {
  const creates: SessionCreateInput[] = [];
  const ipc = ipcHarness();
  registerRuntimeHostSessionCatalogIpc(createDeps(creates), ipc as unknown as IpcMain);

  await ipc.invoke('sessions:create', { mode: 'bot', name: '飞书 任务' });
  await assert.rejects(
    () => ipc.invoke('sessions:create', { mode: 'deep_research', name: '飞书 任务' }),
    /Invalid session start mode/,
  );

  assert.deepEqual(
    creates.map((input) => [input.mode, input.name]),
    [
      ['bot', '飞书 任务'],
    ],
  );
});

test('session creation forwards a plugin executor model without a native model target', async () => {
  const creates: SessionCreateInput[] = [];
  const ipc = ipcHarness();
  registerRuntimeHostSessionCatalogIpc(createDeps(creates), ipc as unknown as IpcMain);

  await ipc.invoke('sessions:create', { executorId: 'codex.app-server', model: 'gpt-5' });

  assert.equal(creates[0]?.executorId, 'codex.app-server');
  assert.equal(creates[0]?.executorModel, 'gpt-5');
  assert.equal(creates[0]?.modelTarget, undefined);
  await assert.rejects(
    ipc.invoke('sessions:create', {
      executorId: 'codex',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai',
    }),
    /cannot include a model connection/,
  );
});

test('moves a projectless Session into a dedicated directory with one CAS commit', async () => {
  const ipc = ipcHarness();
  const relocations: unknown[] = [];
  const deps = createDeps([]);
  deps.client = {
    getSession: async (id: string) => projection({ id, revision: 3 }),
    relocateSessionWorkspace: async (sessionId: string, revision: number, workspace: { kind: 'host_path'; path: string }) => {
      relocations.push([sessionId, revision, workspace]);
      return projection({
        id: sessionId,
        revision: revision + 1,
        workspace: { target: workspace, hostCwd: workspace.path },
      });
    },
  } as unknown as RuntimeHostSessionCatalogIpcDeps['client'];
  deps.dedicatedTaskDirectory = {
    allocate: async () => '/tasks/task-1',
    classify: async () => 'managed',
  };
  registerRuntimeHostSessionCatalogIpc(deps, ipc as unknown as IpcMain);

  const result = (await ipc.invoke('sessions:moveToDedicatedDirectory', 'session-1')) as {
    ok: boolean;
    session: { cwd: string };
  };

  assert.equal(result.ok, true);
  assert.equal(result.session.cwd, '/tasks/task-1');
  assert.deepEqual(relocations, [
    ['session-1', 3, { kind: 'host_path', path: '/tasks/task-1' }],
  ]);
});

test('refuses a Project-bound Session without allocating', async () => {
  const ipc = ipcHarness();
  const allocated: string[] = [];
  const deps = createDeps([]);
  deps.client = {
    getSession: async (id: string) => projection({
      id,
      workspace: { target: { kind: 'project', projectId: 'project-1' }, hostCwd: '/repo' },
    }),
  } as unknown as RuntimeHostSessionCatalogIpcDeps['client'];
  deps.dedicatedTaskDirectory = {
    allocate: async () => { allocated.push('x'); return '/tasks/task-1'; },
    classify: async () => 'managed',
  };
  registerRuntimeHostSessionCatalogIpc(deps, ipc as unknown as IpcMain);

  const result = (await ipc.invoke('sessions:moveToDedicatedDirectory', 'session-1')) as {
    ok: boolean;
    code?: string;
  };

  assert.deepEqual(result, { ok: false, code: 'operation_unavailable' });
  assert.deepEqual(allocated, []);
});

test('reports a relocation revision conflict without retrying', async () => {
  const ipc = ipcHarness();
  let attempts = 0;
  const deps = createDeps([]);
  deps.client = {
    getSession: async (id: string) => projection({ id, revision: 5 }),
    relocateSessionWorkspace: async () => {
      attempts += 1;
      throw new DesktopRuntimeHostClientError('revision_conflict', 'stale revision');
    },
  } as unknown as RuntimeHostSessionCatalogIpcDeps['client'];
  deps.dedicatedTaskDirectory = {
    allocate: async () => '/tasks/task-1',
    classify: async () => 'managed',
  };
  registerRuntimeHostSessionCatalogIpc(deps, ipc as unknown as IpcMain);

  const result = (await ipc.invoke('sessions:moveToDedicatedDirectory', 'session-1')) as {
    ok: boolean;
    code?: string;
  };

  assert.deepEqual(result, { ok: false, code: 'operation_conflict' });
  assert.equal(attempts, 1);
});

test('refuses dedicated-directory relocation without an authority', async () => {
  const ipc = ipcHarness();
  registerRuntimeHostSessionCatalogIpc(createDeps([]), ipc as unknown as IpcMain);

  await assert.rejects(
    () => ipc.invoke('sessions:moveToDedicatedDirectory', 'session-1'),
    /Dedicated task directories are unavailable/,
  );
});

test('preserves the bound directory when creation commits but its response fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-create-unknown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ipc = ipcHarness();
  const deps = createDeps([]);
  const authority = createManagedTaskDirectoryAuthority({ root });
  deps.dedicatedTaskDirectory = authority;
  const directory = await authority.allocate();
  deps.resolveCreateProject = async () => ({ kind: 'host_path', path: directory });
  let committed: SessionCreateInput | undefined;
  const failure = new RuntimeHostOperationError(
    'session.create', 'commit_outcome_unknown', 'Post-commit read failed',
  );
  deps.client = {
    createSession: async (input: SessionCreateInput) => {
      committed = input;
      throw failure;
    },
  } as unknown as RuntimeHostSessionCatalogIpcDeps['client'];
  registerRuntimeHostSessionCatalogIpc(deps, ipc as unknown as IpcMain);

  await assert.rejects(ipc.invoke('sessions:create'), (error) => error === failure);
  assert.deepEqual(committed?.workspace, { kind: 'host_path', path: directory });
  assert.ok((await stat(directory)).isDirectory());
});

test('preserves the bound directory when relocation commits but its response fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-relocate-unknown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ipc = ipcHarness();
  const deps = createDeps([]);
  deps.dedicatedTaskDirectory = createManagedTaskDirectoryAuthority({ root });
  let current = projection({ revision: 5 });
  const failure = new RuntimeHostOperationError(
    'session.workspace.relocate', 'commit_outcome_unknown', 'Post-commit read failed',
  );
  deps.client = {
    getSession: async () => current,
    relocateSessionWorkspace: async (_id: string, revision: number, workspace: { kind: 'host_path'; path: string }) => {
      current = projection({ revision: revision + 1, workspace: { target: workspace, hostCwd: workspace.path } });
      throw failure;
    },
  } as unknown as RuntimeHostSessionCatalogIpcDeps['client'];
  registerRuntimeHostSessionCatalogIpc(deps, ipc as unknown as IpcMain);

  await assert.rejects(ipc.invoke('sessions:moveToDedicatedDirectory', current.id), (error) => error === failure);
  assert.equal(current.revision, 6);
  assert.ok((await stat(current.workspace.hostCwd)).isDirectory());
});

type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];

function ipcHarness() {
  const handlers = new Map<string, IpcHandler>();
  return {
    handle(channel: string, handler: IpcHandler) {
      handlers.set(channel, handler);
    },
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      assert.ok(handler, `missing handler: ${channel}`);
      return handler({} as never, ...args);
    },
  };
}

function createDeps(creates: SessionCreateInput[]): RuntimeHostSessionCatalogIpcDeps {
  return {
    client: {
      createSession: async (input: SessionCreateInput) => {
        creates.push(input);
        return projection({ id: input.sessionId });
      },
    } as unknown as RuntimeHostSessionCatalogIpcDeps['client'],
    runningTurnIds: () => [],
    resolveCreateProject: async () => ({ kind: 'host_path', path: '/workspace' }),
    emitSessionsChanged: () => {},
    releaseSessionResources: () => {},
    sessionCopyCleanup: {
      ownCreation: async <T>(_creation: unknown, operation: () => Promise<T>) => operation(),
      recover: async () => ({ removed: [], failed: [] }),
    } as unknown as RuntimeHostSessionCatalogIpcDeps['sessionCopyCleanup'],
  };
}

function projection(overrides: Partial<SessionCatalogProjection> = {}): SessionCatalogProjection {
  return {
    id: 'session-1',
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: '/workspace' },
      hostCwd: '/workspace',
    },
    createdAt: 1,
    activityAt: 2,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}
