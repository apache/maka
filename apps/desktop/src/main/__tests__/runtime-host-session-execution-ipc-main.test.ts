import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { IpcMain } from 'electron';
import type { AttachmentRef } from '@maka/core';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import { createAttachmentApprovalRegistry } from '../attachment-approval.js';
import type { DesktopRuntimeHostSession } from '../runtime-host-client.js';
import {
  registerRuntimeHostSessionExecutionIpc,
  type RuntimeHostSessionExecutionIpcDeps,
} from '../runtime-host-session-execution-ipc-main.js';
import { RuntimeHostSessionObserver } from '../runtime-host-session-observer.js';

test('sends canonical content and uploads owned Attachment bytes through the Host', async () => {
  const starts: unknown[] = [];
  const uploads: unknown[] = [];
  const changes: unknown[] = [];
  const attachment: AttachmentRef = {
    kind: 'other',
    name: 'notes.txt',
    mimeType: 'text/plain',
    bytes: 5,
    ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'artifact-1' },
  };
  const client = executionClient({
    getSession: async () => session(),
    ingestAttachment: async (input) => {
      uploads.push(input);
      return attachment;
    },
    startTurn: async (input) => {
      starts.push(input);
      return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: 'run-1',
        status: 'running',
      };
    },
  });
  const ipc = ipcHarness();
  registerRuntimeHostSessionExecutionIpc(
    {
      client,
      observer: unusedObserver(),
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged: (reason, sessionId, extra) =>
        changes.push({ reason, sessionId, ...extra }),
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      newId: () => 'turn-1',
    },
    ipc,
  );

  const result = await ipc.invoke('sessions:send', 'session-1', {
    type: 'send',
    text: 'Read @notes.txt',
    attachmentItems: [
      {
        name: 'notes.txt',
        mimeType: 'text/plain',
        base64: Buffer.from('hello').toString('base64'),
      },
    ],
    workspaceFileReferences: [{ value: '@notes.txt', start: 5 }],
  });

  assert.equal((uploads[0] as { content: Uint8Array }).content.byteLength, 5);
  assert.deepEqual(starts, [
    {
      sessionId: 'session-1',
      turnId: 'turn-1',
      content: {
        text: 'Read @notes.txt',
        attachments: [attachment],
        inlineReferences: [
          {
            kind: 'workspace_file',
            value: '@notes.txt',
            start: 5,
            label: 'notes.txt',
          },
        ],
      },
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    turnId: 'turn-1',
    attachments: [attachment],
    inlineReferences: [
      {
        kind: 'workspace_file',
        value: '@notes.txt',
        start: 5,
        label: 'notes.txt',
      },
    ],
    skillInvocation: { loaded: [], failed: [], receipts: [] },
  });
  assert.deepEqual(changes, [
    { reason: 'status-change', sessionId: 'session-1', turnId: 'turn-1' },
  ]);
});

test('uploads a selected workspace file as a Host-owned Session Artifact', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-host-attachment-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'notes.txt');
  await writeFile(path, 'hello');
  const approvals = createAttachmentApprovalRegistry();
  const [approved] = approvals.issueApprovals(9, [
    { path, name: 'notes.txt', mimeType: 'text/plain', size: 5 },
  ]);
  assert.ok(approved);
  const uploads: Array<{ content: Uint8Array }> = [];
  const starts: unknown[] = [];
  const attachment: AttachmentRef = {
    kind: 'other',
    name: 'notes.txt',
    mimeType: 'text/plain',
    bytes: 5,
    ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'artifact-1' },
  };
  const ipc = ipcHarness();
  registerRuntimeHostSessionExecutionIpc(
    {
      client: executionClient({
        getSession: async () => session(cwd),
        ingestAttachment: async (input) => {
          uploads.push(input);
          return attachment;
        },
        startTurn: async (input) => {
          starts.push(input);
          return {
            sessionId: input.sessionId,
            turnId: input.turnId,
            runId: 'run-1',
            status: 'running',
          };
        },
      }),
      observer: unusedObserver(),
      attachmentApprovals: approvals,
      emitSessionsChanged() {},
      stat: async () => ({ size: 5 }),
      resizeImage: async (bytes) => bytes,
      newId: () => 'turn-1',
    },
    ipc,
  );

  await ipc.invoke('sessions:send', 'session-1', {
    type: 'send',
    text: 'Read the attachment',
    attachmentItems: [approved],
  });

  assert.equal(Buffer.from(uploads[0]?.content ?? []).toString('utf8'), 'hello');
  assert.deepEqual(
    (starts[0] as { content: { attachments: AttachmentRef[] } }).content.attachments,
    [attachment],
  );
});

test('rejects Skill invocation until the Host Runtime-domain adapter owns its feedback contract', async () => {
  const ipc = ipcHarness();
  registerRuntimeHostSessionExecutionIpc(
    {
      client: executionClient({}),
      observer: unusedObserver(),
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
    },
    ipc,
  );

  await assert.rejects(
    ipc.invoke('sessions:send', 'session-1', {
      type: 'send',
      text: '/skill:review',
    }),
    /Skill invocation is not available/,
  );
  await assert.rejects(
    ipc.invoke('sessions:send', 'session-1', {
      type: 'send',
      text: '',
      skillIds: ['review'],
    }),
    /Skill invocation is not available/,
  );
});

test('binds steer and stop to Host-owned queue and active Turn identities', async () => {
  const submits: unknown[] = [];
  const interrupts: unknown[] = [];
  let sequence = 0;
  const client = executionClient({
    submitMessage: async (input) => {
      submits.push(input);
      return { disposition: 'steering', queueRevision: 2 };
    },
    interruptTurn: async (input) => {
      interrupts.push(input);
      return {
        queueRevision: 3,
        retracted: [],
        turn: {
          sessionId: input.sessionId,
          turnId: input.turnId,
          runId: input.runId,
          status: 'cancelled',
          terminalEventId: 'terminal-1',
          abortSource: 'user',
        },
      };
    },
  });
  const observer = observerWithSnapshot();
  const ipc = ipcHarness();
  registerRuntimeHostSessionExecutionIpc(
    {
      client,
      observer,
      attachmentApprovals: createAttachmentApprovalRegistry(),
      emitSessionsChanged() {},
      stat: async () => ({ size: 0 }),
      resizeImage: async (bytes) => bytes,
      newId: () => `id-${++sequence}`,
    },
    ipc,
  );

  assert.deepEqual(await ipc.invoke('sessions:steer', 'session-1', '  Continue  '), {
    kind: 'queued',
  });
  await ipc.invoke('sessions:stop', 'session-1');

  assert.deepEqual(submits, [
    {
      sessionId: 'session-1',
      messageId: 'id-1',
      content: { text: 'Continue' },
      placement: 'current_turn',
    },
  ]);
  assert.deepEqual(interrupts, [
    {
      sessionId: 'session-1',
      interruptId: 'id-2',
      turnId: 'turn-1',
      runId: 'run-1',
    },
  ]);
  await observer.close();
});

type ExecutionClient = RuntimeHostSessionExecutionIpcDeps['client'];

function executionClient(overrides: Partial<ExecutionClient>): ExecutionClient {
  const unavailable = async (): Promise<never> => {
    throw new Error('Unexpected Runtime Host Session execution operation');
  };
  return {
    answerInteraction: unavailable,
    compactContext: unavailable,
    copySession: unavailable,
    getSession: unavailable,
    ingestAttachment: unavailable,
    interruptTurn: unavailable,
    queryTurnResume: unavailable,
    readExecutionBoundary: unavailable,
    regenerateTurn: unavailable,
    setSessionReadMarker: unavailable,
    startTurn: unavailable,
    startTurnResume: unavailable,
    submitMessage: unavailable,
    updateSessionMetadata: unavailable,
    ...overrides,
  };
}

function unusedObserver(): RuntimeHostSessionObserver {
  return new RuntimeHostSessionObserver({
    client: {
      openSession: async (): Promise<DesktopRuntimeHostSession> => {
        throw new Error('Unexpected Runtime Host Session subscription');
      },
    },
    emitSessionsChanged() {},
  });
}

function observerWithSnapshot(): RuntimeHostSessionObserver {
  return new RuntimeHostSessionObserver({
    client: {
      openSession: async () => ({
        snapshot: {
          schemaVersion: 3,
          session: {
            sessionId: 'session-1',
            metadataRevision: 1,
            status: 'running',
            createdAt: 1,
            lastUsedAt: 1,
            isArchived: false,
          },
          projectionRevision: 1,
          rootTurn: {
            sessionId: 'session-1',
            turnId: 'turn-1',
            runId: 'run-1',
            status: 'running',
          },
          goal: null,
          queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] },
          interactions: { pending: [] },
        },
        transcript: Promise.resolve([]),
        events: emptyEvents(),
        async close() {},
      }),
    },
    emitSessionsChanged() {},
  });
}

async function* emptyEvents(): AsyncIterable<never> {}

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
      return handler({ sender: { id: 9 } } as never, ...args);
    },
  };
}

function session(cwd = '/workspace'): SessionCatalogProjection {
  return {
    id: 'session-1',
    revision: 1,
    cwd,
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Session',
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
  };
}
