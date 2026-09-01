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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { IpcMain } from 'electron';
import type { BotRegistry } from '@maka/runtime/bots';
import type { ComputerUseToolSet } from '@maka/runtime/computer-use-tools';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { connectRuntimeHost } from '@maka/runtime-host/client';
import {
  RUNTIME_HOST_PROTOCOL_VERSION,
  type SessionCatalogProjection,
} from '@maka/runtime-host/protocol';
import {
  createUnavailableDomainOperationHandlers,
  defineInteractiveRuntimeHostComposition,
  RuntimeHostKernel,
  type RuntimeHostComposition,
} from '@maka/runtime-host/server';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { z } from 'zod';
import { DesktopRuntimeHostClient } from '../runtime-host-client.js';
import { createAttachmentApprovalRegistry } from '../attachment-approval.js';
import { startDesktopRuntimeHostCandidate } from '../runtime-host-desktop-candidate.js';
import { registerRuntimeHostSessionExecutionIpc } from '../runtime-host-session-execution-ipc-main.js';
import { registerRuntimeHostSessionDomainsIpc } from '../runtime-host-session-domains-ipc-main.js';
import { RuntimeHostSessionObserver } from '../runtime-host-session-observer.js';

test('drives Desktop Session operations through a real Runtime Host connection', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-desktop-host-client-'));
  let host: RuntimeHostKernel | undefined;
  try {
    const capability = await resolveStorageRoot({ path: base, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const projected = session('session-1');
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 10_000,
      composition: defineInteractiveRuntimeHostComposition(async ({ hostEpoch }) => ({
        handlers: handlers({
          'session.catalog.query': async (input) =>
            input.kind === 'get'
              ? { ok: true, result: { kind: 'session', session: projected } }
              : {
                  ok: true,
                  result: {
                    kind: 'page',
                    revision: catalogRevision('1'),
                    sessions: [projected],
                    nextCursor: null,
                  },
                },
          'turn.message.submit': async (input) => {
            assert.equal(input.originHostEpoch, hostEpoch);
            return {
              ok: true,
              result: {
                disposition: 'steering',
                queueRevision: 1,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              },
            };
          },
        }),
        beginDrain() {},
        async recover() {},
        async close() {},
      })),
    });
    const connected = await connectRuntimeHost({
      rootPath: base,
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') throw new Error('Desktop did not connect to Runtime Host');
    const client = new DesktopRuntimeHostClient(connected.connection);

    assert.deepEqual(await client.listSessions(), [projected]);
    assert.deepEqual(
      await client.updateSessionConfiguration(projected.id, { thinkingLevel: undefined }),
      projected,
    );
    assert.deepEqual(
      await client.submitMessage({
        sessionId: projected.id,
        messageId: 'message-1',
        content: { text: 'Continue with the new constraints.' },
        placement: 'current_turn',
      }),
      {
        disposition: 'steering',
        queueRevision: 1,
        skillInvocation: { loaded: [], failed: [], receipts: [] },
      },
    );

    await client.close();
  } finally {
    await host?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('drives the renderer Session catalog facade through real UDS framing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-desktop-host-ipc-'));
  let host: RuntimeHostKernel | undefined;
  let projected: SessionCatalogProjection | undefined;
  /** Arms one concurrent restore, landing between the Client's read and its remove. */
  let restoreUnderNextRemove = false;
  try {
    const capability = await resolveStorageRoot({ path: base, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 10_000,
      composition: defineInteractiveRuntimeHostComposition(async () => ({
        handlers: handlers({
          'client.capability.replace': async (input) => ({
            ok: true,
            result: { registrationId: input.registrationId, revision: 1 },
          }),
          'client.capability.unregister': async (input) => ({
            ok: true,
            result: { registrationId: input.registrationId, revision: 2 },
          }),
          'session.catalog.query': async (input) => {
            if (input.kind === 'get') {
              return {
                ok: true,
                result: {
                  kind: 'session',
                  session: projected?.id === input.sessionId ? projected : null,
                },
              };
            }
            return {
              ok: true,
              result: {
                kind: 'page',
                revision: catalogRevision(String(projected?.revision ?? 0)),
                sessions: projected ? [projected] : [],
                nextCursor: null,
              },
            };
          },
          'session.create': async (input) => {
            assert.deepEqual(input.modelTarget, { kind: 'default' });
            assert.equal(input.permissionMode, undefined);
            assert.equal(input.workspace.kind, 'host_path');
            if (input.workspace.kind !== 'host_path') throw new Error('Expected Host path');
            projected = session(input.sessionId, {
              workspace: { target: input.workspace, hostCwd: input.workspace.path },
              name: input.name,
              connectionLocked: false,
            });
            return { ok: true, result: projected };
          },
          'session.configuration.update': async (input) => {
            assert.ok(projected);
            assert.equal(input.expectedRevision, projected.revision);
            const { thinkingLevel: _thinkingLevel, ...withoutThinkingLevel } = projected;
            projected = session(projected.id, {
              ...(input.patch.thinkingLevel === null ? withoutThinkingLevel : projected),
              revision: projected.revision + 1,
              ...(input.patch.permissionMode === undefined
                ? {}
                : { permissionMode: input.patch.permissionMode }),
              ...(input.patch.collaborationMode === undefined
                ? {}
                : { collaborationMode: input.patch.collaborationMode }),
              ...(input.patch.orchestrationMode === undefined
                ? {}
                : { orchestrationMode: input.patch.orchestrationMode }),
              ...(input.patch.thinkingLevel === null || input.patch.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: input.patch.thinkingLevel }),
            });
            return { ok: true, result: { kind: 'committed', session: projected } };
          },
          'session.lifecycle.set': async (input) => {
            assert.ok(projected);
            const archived = input.state === 'archived';
            projected = session(projected.id, {
              ...projected,
              revision: projected.revision + 1,
              isArchived: archived,
            });
            return { ok: true, result: projected };
          },
          'session.remove': async (input) => {
            assert.ok(projected);
            if (restoreUnderNextRemove) {
              // Another window restored the task between the Client's read and
              // this write. The Host rejects the stale revision, which is what
              // a restore looks like from here.
              restoreUnderNextRemove = false;
              projected = session(projected.id, {
                ...projected,
                revision: projected.revision + 1,
                isArchived: false,
                status: 'active',
              });
              return {
                ok: true,
                result: {
                  kind: 'revision_conflict',
                  expectedRevision: input.expectedRevision,
                  actualRevision: projected.revision,
                },
              };
            }
            assert.equal(input.expectedRevision, projected.revision);
            const sessionId = projected.id;
            projected = undefined;
            return { ok: true, result: { kind: 'removed', sessionId } };
          },
        }),
        beginDrain() {},
        async recover() {},
        async close() {},
      })),
    });
    const ipc = ipcHarness();
    const changes: Array<{ reason: string; sessionId?: string }> = [];
    const started = await startDesktopRuntimeHostCandidate({
      rootPath: base,
      candidateEntrypoint: new URL('file:///unused-runtime-host-candidate.js'),
      ipcMain: ipc,
      workspaceRoot: base,
      attachmentApprovals: createAttachmentApprovalRegistry(),
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      nativeCapabilities: {
        browserTools: [nativeTool()],
        resolveBrowserUrl: () => 'https://example.com/',
        releaseBrowserSession() {},
        computerUseTools: Object.assign([], {
          clearSession() {},
        }) as unknown as ComputerUseToolSet,
        releaseComputerUseSession() {},
      },
      botRegistry: {} as BotRegistry,
      resolveBotCreateTarget: async () => ({
        workspace: { kind: 'host_path', path: base },
      }),
      resolveSessionCreateProject: async () => ({ kind: 'host_path', path: base }),
      emitSessionsChanged: (_hostId, reason, sessionId) => changes.push({ reason, sessionId }),
      completeComputerUseTurn() {},
      createSessionCopyCleanup: () => ({
        ownCreation: (_creation, operation) => operation(),
        rejectCreation: async () => undefined,
        cleanup: async () => undefined,
        schedule: async () => undefined,
        abandonOwner: async () => undefined,
        recover: async () => ({ removed: [], failed: [] }),
      }),
      newId: () => 'session-ipc',
    });
    assert.equal(started.kind, 'ready');
    if (started.kind !== 'ready') throw new Error('Desktop candidate did not start');
    const { candidate } = started;
    ipc.setHost(candidate.client.hostId, 'uds-target');

    const created = await ipc.invoke('sessions:create', undefined);
    assert.deepEqual((await ipc.invoke('sessions:list')) as unknown[], [created]);
    for (const staleFilter of [
      { isArchived: false },
      { isFlagged: true },
      { labelSlug: 'paged' },
    ]) {
      await assert.rejects(
        ipc.invoke('sessions:list', staleFilter),
        /Invalid Session list filter/,
      );
    }
    assert.equal(
      (await ipc.invoke('sessions:setPermissionMode', 'session-ipc', 'bypass') as {
        permissionMode: string;
      }).permissionMode,
      'bypass',
    );
    await ipc.invoke('sessions:archive', 'session-ipc');
    assert.equal((await ipc.invoke('sessions:list') as Array<{ isArchived: boolean }>)[0]?.isArchived, true);
    // A purge sweep asks for the task it saw archived. Restored under it, the
    // deletion is called off rather than replayed at the fresh revision (#3050).
    restoreUnderNextRemove = true;
    assert.deepEqual(
      await ipc.invoke('sessions:remove', 'session-ipc', { revisionFamily: true, requireArchived: true }),
      { disposition: 'restored', archivedSubtaskCount: 0 },
    );
    assert.equal((await ipc.invoke('sessions:list') as Array<{ isArchived: boolean }>)[0]?.isArchived, false);
    await ipc.invoke('sessions:archive', 'session-ipc');
    assert.deepEqual(await ipc.invoke('sessions:remove', 'session-ipc'), {
      disposition: 'removed',
      archivedSubtaskCount: 0,
    });
    assert.deepEqual(await ipc.invoke('sessions:list'), []);
    // Nothing was retired for the restored task: no `deleted` between the two
    // archives, and the renderer keeps everything it holds for it.
    assert.deepEqual(changes, [
      { reason: 'created', sessionId: 'session-ipc' },
      { reason: 'mode-change', sessionId: 'session-ipc' },
      { reason: 'archived', sessionId: 'session-ipc' },
      { reason: 'archived', sessionId: 'session-ipc' },
      { reason: 'deleted', sessionId: 'session-ipc' },
    ]);

    await candidate.close();
  } finally {
    await host?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('drives the renderer Session execution facade through real UDS framing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-desktop-host-execution-ipc-'));
  let host: RuntimeHostKernel | undefined;
  try {
    const capability = await resolveStorageRoot({ path: base, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const projected = session('session-1');
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 10_000,
      composition: defineInteractiveRuntimeHostComposition(async () => ({
        handlers: handlers({
          'session.catalog.query': async (input) => ({
            ok: true,
            result: {
              kind: 'session',
              session: input.kind === 'get' && input.sessionId === projected.id ? projected : null,
            },
          }),
          'session.execution_boundary.query': async (input) => {
            assert.equal(input.sessionId, projected.id);
            return {
              ok: true,
              result: { kind: 'managed', access: 'read_only', revision: 2 },
            };
          },
          'turn.message.submit': async (input) => {
            assert.equal(input.sessionId, projected.id);
            assert.equal(input.messageId, 'turn-1');
            assert.equal(input.placement, 'current_turn');
            assert.equal(input.content.text, 'Run through the Host');
            return {
              ok: true,
              result: {
                disposition: 'turn_started',
                turnId: 'turn-host-1',
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              },
            };
          },
        }),
        beginDrain() {},
        async recover() {},
        async close() {},
      })),
    });
    const connected = await connectRuntimeHost({
      rootPath: base,
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') throw new Error('Desktop did not connect to Runtime Host');
    const client = new DesktopRuntimeHostClient(connected.connection);
    const observer = new RuntimeHostSessionObserver({ client, emitSessionsChanged() {} });
    const ipc = ipcHarness();
    registerRuntimeHostSessionExecutionIpc(
      {
        client,
        observer,
        attachmentApprovals: createAttachmentApprovalRegistry(),
        emitSessionsChanged() {},
        stat: async () => ({ size: 0 }),
        resizeImage: async (bytes) => bytes,
        beforeStop() {},
        sessionCopyCleanup: unusedSessionCopyCleanup(),
        onBackgroundError() {},
        newId: () => 'turn-1',
      },
      ipc,
    );

    assert.deepEqual(await ipc.invoke('sessions:readExecutionBoundary', projected.id), {
      kind: 'managed',
      access: 'read_only',
      revision: 2,
    });
    assert.deepEqual(
      await ipc.invoke('sessions:send', projected.id, {
        type: 'send',
        turnId: 'turn-1',
        text: 'Run through the Host',
      }),
      {
        ok: true,
        turnId: 'turn-host-1',
        attachments: [],
        inlineReferences: [],
        skillInvocation: { loaded: [], failed: [], receipts: [] },
      },
    );

    await observer.close();
    await client.close();
  } finally {
    await host?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('drives bounded Session domain projections through real UDS framing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-desktop-host-domains-ipc-'));
  let host: RuntimeHostKernel | undefined;
  try {
    const capability = await resolveStorageRoot({ path: base, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 10_000,
      composition: defineInteractiveRuntimeHostComposition(async () => ({
        handlers: handlers({
          'session.todo.query': async (input) => ({
            ok: true,
            result: {
              sessionId: input.sessionId,
              items: [
                { content: 'Verify the Desktop adapter', status: 'in_progress' },
              ],
            },
          }),
          'plan.query': async (input) => ({
            ok: true,
            result: {
              kind: 'page',
              sessionId: input.sessionId,
              storeVersion: 0,
              latestProposalId: null,
              activeExecutionId: null,
              items: [],
              nextCursor: null,
            },
          }),
          'goal.query': async (input) => ({
            ok: true,
            result: { sessionId: input.sessionId, goal: null },
          }),
          'deep-research.query': async (input) => ({
            ok: true,
            result: { kind: 'not_started', sessionId: input.sessionId, revision: 0 },
          }),
          'runtime.resource.query': async (input) => ({
            ok: true,
            result: {
              kind: 'page',
              sessionId: input.sessionId,
              revision: catalogRevision('7'),
              resources: [],
              nextCursor: null,
            },
          }),
        }),
        beginDrain() {},
        async recover() {},
        async close() {},
      })),
    });
    const connected = await connectRuntimeHost({
      rootPath: base,
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') throw new Error('Desktop did not connect to Runtime Host');
    const client = new DesktopRuntimeHostClient(connected.connection);
    const ipc = ipcHarness();
    registerRuntimeHostSessionDomainsIpc(
      { client, emitModeChanged() {}, sessionObserver: unusedSessionObserver() },
      ipc,
    );

    assert.equal(
      ((await ipc.invoke('todo:read', 'session-1')) as Array<{ content: string }>)[0]?.content,
      'Verify the Desktop adapter',
    );
    assert.deepEqual(await ipc.invoke('plan-mode:getState', 'session-1'), {
      schemaVersion: 1,
      sessionId: 'session-1',
      storeVersion: 0,
      proposals: [],
      executions: [],
    });
    assert.equal(await ipc.invoke('goal:get', 'session-1'), null);
    assert.equal(await ipc.invoke('deepResearch:get', 'session-1'), undefined);
    assert.deepEqual(await ipc.invoke('shell-runs:list', 'session-1'), []);

    await client.close();
  } finally {
    await host?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

type TestHandlers = Partial<RuntimeHostComposition['handlers']>;

function handlers(overrides: TestHandlers): RuntimeHostComposition['handlers'] {
  return {
    ...createUnavailableDomainOperationHandlers(),
    ...overrides,
  } as RuntimeHostComposition['handlers'];
}

function catalogRevision(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64)}`;
}

type IpcHandler = Parameters<Pick<IpcMain, 'handle'>['handle']>[1];

function ipcHarness() {
  const ipcHandlers = new Map<string, IpcHandler>();
  let host: { hostId: string; targetEpoch: string } | undefined;
  return {
    epoch: 'uds-target',
    isActive: () => true,
    handle(channel: string, handler: IpcHandler) {
      assert.equal(ipcHandlers.has(channel), false, `duplicate handler: ${channel}`);
      ipcHandlers.set(channel, handler);
    },
    removeHandler(channel: string) {
      ipcHandlers.delete(channel);
    },
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = ipcHandlers.get(channel);
      assert.ok(handler, `missing handler: ${channel}`);
      return handler({} as never, ...(host ? [host, ...args] : args));
    },
    setHost(hostId: string, targetEpoch: string): void {
      host = { hostId, targetEpoch };
    },
  };
}

function unusedSessionCopyCleanup() {
  return {
    ownCreation: async <T>(_creation: unknown, operation: () => Promise<T>) => operation(),
    async rejectCreation() {},
    async cleanup() {},
    async schedule() {},
    async abandonOwner() {},
    async recover() {
      return { removed: [], failed: [] };
    },
  };
}

function unusedSessionObserver() {
  return {
    async observe() {},
    async unobserve() {},
  };
}

function session(
  id: string,
  overrides: Partial<SessionCatalogProjection> = {},
): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: '/workspace' },
      hostCwd: '/workspace',
    },
    createdAt: 1,
    activityAt: 1,
    name: 'Desktop Host Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'test-connection',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}

function nativeTool(): MakaTool {
  return {
    name: 'browser_snapshot',
    description: 'Capture the current page.',
    parameters: z.object({}),
    impl: async () => 'snapshot',
  };
}
