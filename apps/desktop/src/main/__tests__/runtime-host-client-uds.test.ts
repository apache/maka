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
            return { ok: true, result: { disposition: 'steering', queueRevision: 1 } };
          },
        }),
        beginDrain() {},
        async recover() {},
        async close() {},
      })),
    });
    const connected = await connectRuntimeHost({
      rootPath: base,
      surface: 'desktop',
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
      { disposition: 'steering', queueRevision: 1 },
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
            projected = session(projected.id, {
              ...projected,
              revision: projected.revision + 1,
              permissionMode: input.configuration.permissionMode,
              collaborationMode: input.configuration.collaborationMode,
              orchestrationMode: input.configuration.orchestrationMode,
              ...(input.configuration.thinkingLevel === null
                ? {}
                : { thinkingLevel: input.configuration.thinkingLevel }),
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
              status: archived ? 'archived' : 'active',
            });
            return { ok: true, result: projected };
          },
          'session.remove': async (input) => {
            assert.ok(projected);
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
    assert.equal(
      (await ipc.invoke('sessions:setPermissionMode', 'session-ipc', 'execute') as {
        permissionMode: string;
      }).permissionMode,
      'execute',
    );
    await ipc.invoke('sessions:archive', 'session-ipc');
    assert.equal((await ipc.invoke('sessions:list') as Array<{ isArchived: boolean }>)[0]?.isArchived, true);
    await ipc.invoke('sessions:remove', 'session-ipc');
    assert.deepEqual(await ipc.invoke('sessions:list'), []);
    assert.deepEqual(changes, [
      { reason: 'created', sessionId: 'session-ipc' },
      { reason: 'mode-change', sessionId: 'session-ipc' },
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
          'turn.start': async (input) => {
            assert.equal(input.sessionId, projected.id);
            assert.equal(input.content.text, 'Run through the Host');
            return {
              ok: true,
              result: {
                kind: 'started',
                turn: {
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  runId: 'run-1',
                  status: 'running',
                },
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
      surface: 'desktop',
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
        observations: observer,
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
        turnId: 'turn-1',
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
          'task.ledger.query': async (input) => ({
            ok: true,
            result: {
              kind: 'page',
              sessionId: input.sessionId,
              revision: catalogRevision('6'),
              tasks: [
                {
                  id: 'task-1',
                  key: 'T1',
                  subject: 'Verify the Desktop adapter',
                  status: 'in_progress',
                  createdAt: 1,
                  updatedAt: 2,
                },
              ],
              nextCursor: null,
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
      surface: 'desktop',
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
      ((await ipc.invoke('tasks:list', 'session-1')) as Array<{ id: string }>)[0]?.id,
      'task-1',
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
    lastUsedAt: 1,
    name: 'Desktop Host Session',
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

function nativeTool(): MakaTool {
  return {
    name: 'browser_snapshot',
    description: 'Capture the current page.',
    parameters: z.object({}),
    impl: async () => 'snapshot',
  };
}
