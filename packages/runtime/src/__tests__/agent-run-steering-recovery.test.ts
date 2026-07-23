import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentRunHeader, RuntimeEvent } from '@maka/core';
import type { SessionEvent } from '@maka/core/events';
import {
  createAgentRunStore,
  createLegacyFileSessionStore,
  createRuntimeEventStore,
} from '@maka/storage';
import { AgentRun } from '../agent-run.js';
import { buildStatusPatch } from '../session-projection-helpers.js';

test('acks a steering event whose canonical append preceded proof publication failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-steering-recovery-'));
  try {
    const store = createLegacyFileSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/cwd',
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const runStore = createAgentRunStore(root);
    const runtimeEventStore = createRuntimeEventStore(root);
    const runId = 'run-1';
    const turnId = 'turn-1';
    await runStore.createRun(makeRunHeader(session.id, runId, turnId));
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId, text: 'start' },
      runId,
      store,
      runStore,
      runtimeEventStore,
      newId: () => 'unused-id',
      now: () => 10,
      recordSessionMessages: false,
      hooks: {
        ensureActive: async () => {
          throw new Error('ensureActive should not be called');
        },
        registerRun: () => {},
        unregisterRun: () => {},
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });
    const sessionEvent: SessionEvent = {
      type: 'steering_message',
      id: 'runtime-steering',
      turnId,
      ts: 2,
      messageId: 'message-steering',
      content: { text: 'persist me once' },
    };
    const runtimeEvent: RuntimeEvent = {
      id: sessionEvent.id,
      invocationId: run.invocationId,
      runId,
      sessionId: session.id,
      turnId,
      ts: sessionEvent.ts,
      partial: false,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'persist me once', steering: true },
      refs: { providerEventId: sessionEvent.messageId },
    };
    const proofDirectory = join(root, 'sessions', session.id, 'message-proofs', 'steering');
    await mkdir(proofDirectory, { recursive: true });
    await chmod(proofDirectory, 0o500);

    await run.acceptMappedEvent(sessionEvent, runtimeEvent);

    await chmod(proofDirectory, 0o700);
    await rm(proofDirectory, { recursive: true });
    const recovered = createRuntimeEventStore(root);
    await recovered.repairImmutableSteeringMessageProofsForRecovery(session.id);
    assert.deepEqual(await recovered.readImmutableRuntimeEvents(session.id, runId), [runtimeEvent]);
    assert.deepEqual(
      await recovered.readImmutableSteeringMessageProof(session.id, sessionEvent.messageId),
      { event: runtimeEvent },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('awaits canonical Run status persistence before accepting an interaction resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-status-barrier-'));
  try {
    const store = createLegacyFileSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/cwd',
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const runStore = createAgentRunStore(root);
    const runtimeEventStore = createRuntimeEventStore(root);
    const runId = 'run-status-barrier';
    const turnId = 'turn-status-barrier';
    await store.updateHeader(session.id, buildStatusPatch('waiting_for_user', 1));
    await runStore.createRun({
      ...makeRunHeader(session.id, runId, turnId),
      status: 'waiting_for_user',
    });
    const updateStarted = deferred<void>();
    const allowUpdate = deferred<void>();
    const delayedRunStore = {
      updateRun: async (...args: Parameters<typeof runStore.updateRun>) => {
        updateStarted.resolve();
        await allowUpdate.promise;
        return await runStore.updateRun(...args);
      },
      appendEvent: runStore.appendEvent.bind(runStore),
    } as typeof runStore;
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId, text: 'resume after answer' },
      runId,
      durability: 'required',
      store,
      runStore: delayedRunStore,
      runtimeEventStore,
      newId: () => 'status-event',
      now: () => 10,
      recordSessionMessages: false,
      hooks: {
        ensureActive: async () => {
          throw new Error('ensureActive should not be called');
        },
        registerRun: () => {},
        unregisterRun: () => {},
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async (sessionId, status, blockedReason, ts = 0) => {
          await store.updateHeader(sessionId, buildStatusPatch(status, ts, blockedReason));
        },
        appendTurnState: async () => {},
      },
    });
    let accepted = false;
    const accepting = run
      .recordSessionEvent({
        type: 'user_question_answer_ack',
        id: 'answer-ack',
        turnId,
        ts: 2,
        requestId: 'question-1',
        toolUseId: 'tool-1',
      })
      .then(() => {
        accepted = true;
      });

    await updateStarted.promise;
    assert.equal(accepted, false);
    assert.equal((await store.readHeader(session.id)).status, 'waiting_for_user');
    allowUpdate.resolve();
    await accepting;
    assert.equal((await runStore.readRun(session.id, runId))?.status, 'running');
    assert.equal((await store.readHeader(session.id)).status, 'running');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('required interaction resume bypasses a failed best-effort Run Store latch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-status-latch-'));
  try {
    const store = createLegacyFileSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/cwd',
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const runStore = createAgentRunStore(root);
    const runtimeEventStore = createRuntimeEventStore(root);
    const runId = 'run-status-latch';
    const turnId = 'turn-status-latch';
    await store.updateHeader(session.id, buildStatusPatch('waiting_for_user', 1));
    await runStore.createRun({
      ...makeRunHeader(session.id, runId, turnId),
      status: 'waiting_for_user',
    });
    let failNextAppend = true;
    const failingRunStore = {
      updateRun: runStore.updateRun.bind(runStore),
      appendEvent: async (...args: Parameters<typeof runStore.appendEvent>) => {
        if (failNextAppend) {
          failNextAppend = false;
          throw new Error('injected trace failure');
        }
        return await runStore.appendEvent(...args);
      },
    } as typeof runStore;
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId, text: 'fail closed after trace failure' },
      runId,
      durability: 'required',
      store,
      runStore: failingRunStore,
      runtimeEventStore,
      newId: () => 'status-latch-event',
      now: () => 10,
      recordSessionMessages: false,
      hooks: {
        ensureActive: async () => {
          throw new Error('ensureActive should not be called');
        },
        registerRun: () => {},
        unregisterRun: () => {},
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async (sessionId, status, blockedReason, ts = 0) => {
          await store.updateHeader(sessionId, buildStatusPatch(status, ts, blockedReason));
        },
        appendTurnState: async () => {},
      },
    });
    run.recordRunTrace({
      id: 'trace-that-fails',
      sessionId: session.id,
      turnId,
      ts: 1,
      phase: 'turn',
      type: 'turn_started',
      message: 'trip the best-effort trace latch',
    });
    await waitFor(async () =>
      Boolean((await runStore.readRun(session.id, runId))?.traceWriteError),
    );

    await run.recordSessionEvent({
      type: 'user_question_answer_ack',
      id: 'answer-after-latch',
      turnId,
      ts: 2,
      requestId: 'question-1',
      toolUseId: 'tool-1',
    });
    assert.equal((await runStore.readRun(session.id, runId))?.status, 'running');
    assert.equal((await store.readHeader(session.id)).status, 'running');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function makeRunHeader(sessionId: string, runId: string, turnId: string): AgentRunHeader {
  return {
    runId,
    sessionId,
    turnId,
    status: 'running',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve as (value?: T | PromiseLike<T>) => void;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for asynchronous test condition');
}
