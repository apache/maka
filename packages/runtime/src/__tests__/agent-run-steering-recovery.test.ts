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

import { access, chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionEvent } from '@maka/core/events';
import {
  createSessionStore,
  createSqliteAgentRunStore,
  createWorkspaceRuntimeStore,
} from '@maka/storage';
import { AgentRun } from '../agent-run.js';
import { RuntimeLedgerRepair } from '../runtime-ledger-repair.js';
import { buildStatusPatch } from '../session-projection-helpers.js';

test('rejects an invalid tool mode before a durable AgentRun can be created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-tool-mode-'));
  try {
    const store = createSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/cwd',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);

    assert.throws(
      () =>
        new AgentRun({
          sessionId: session.id,
          header: session,
          userInput: { turnId: 'turn-invalid-mode', text: 'invalid', toolMode: 'typo' as never },
          runStore,
          runtimeEventStore,
          store,
          newId: () => 'unused',
          now: () => 1,
          recordSessionMessages: false,
          hooks: {
            reserveRun: async () => {
              throw new Error('reserveRun should not be called');
            },
            unregisterRun: () => {},
            updateHeader: async () => session,
            updateStatus: async () => {},
            appendTurnState: async () => {},
          },
        }),
      /invalid tool mode/i,
    );
    assert.deepEqual(await runStore.listSessionRuns(session.id), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not re-append atomically committed tool facts through the generic event lane', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-atomic-tool-boundary-'));
  try {
    const store = createSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/cwd',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const runId = 'run-atomic-tool';
    const turnId = 'turn-atomic-tool';
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId, text: 'run a durable tool' },
      runId,
      store,
      runtimeEventStore,
      toolBoundaryProtocol: 't1_after_preflight_v1',
      newId: () => 'unused-id',
      now: () => 10,
      recordSessionMessages: false,
      hooks: {
        reserveRun: async () => {
          throw new Error('reserveRun should not be called');
        },
        unregisterRun: () => {},
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });
    const sessionEvent: SessionEvent = {
      type: 'tool_start',
      id: 'operation-1_call',
      turnId,
      ts: 2,
      toolUseId: 'call-1',
      toolName: 'Read',
      args: { path: '/tmp/cwd/file.txt' },
      operationId: 'operation-1',
    };
    const runtimeEvent: RuntimeEvent = {
      id: sessionEvent.id,
      invocationId: run.invocationId,
      runId,
      sessionId: session.id,
      turnId,
      ts: sessionEvent.ts,
      partial: false,
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: sessionEvent.toolUseId,
        name: sessionEvent.toolName,
        args: sessionEvent.args,
      },
      refs: {
        operationId: sessionEvent.operationId,
        toolCallId: sessionEvent.toolUseId,
      },
    };

    await run.acceptMappedEvent(sessionEvent, runtimeEvent);

    await assert.rejects(access(join(root, 'sessions', session.id, 'runs', runId)), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('acks a steering event whose canonical append preceded proof publication failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-steering-recovery-'));
  try {
    const store = createSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/cwd',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
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
        reserveRun: async () => {
          throw new Error('reserveRun should not be called');
        },
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
    const recovered = createWorkspaceRuntimeStore(root);
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

test('materializes a durable steering event into the transcript exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-steering-transcript-'));
  try {
    const store = createSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/cwd',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const turnId = 'turn-steering-transcript';
    const sessionEvent: SessionEvent = {
      type: 'steering_message',
      id: 'runtime-steering-transcript',
      turnId,
      ts: 2,
      messageId: 'message-steering-transcript',
      content: { text: 'persist this interjection' },
    };
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId, text: 'start' },
      runId: 'run-steering-transcript',
      store,
      runtimeEventStore,
      newId: () => 'unused-id',
      now: () => 10,
      hooks: {
        reserveRun: async () => {
          throw new Error('reserveRun should not be called');
        },
        unregisterRun: () => {},
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });
    const runtimeEvent: RuntimeEvent = {
      id: sessionEvent.id,
      invocationId: run.invocationId,
      runId: 'run-steering-transcript',
      sessionId: session.id,
      turnId,
      ts: sessionEvent.ts,
      partial: false,
      role: 'user',
      author: 'user',
      content: {
        kind: 'text',
        text: sessionEvent.content.text,
        displayText: '/skill:writer persist this interjection',
        inlineReferences: [{ kind: 'skill', value: '/skill:writer', label: 'Writer', start: 0 }],
        steering: true,
      },
      refs: { providerEventId: sessionEvent.messageId },
    };

    await run.acceptMappedEvent(sessionEvent, runtimeEvent);
    await run.acceptMappedEvent(sessionEvent, runtimeEvent);

    assert.deepEqual(await store.readMessages(session.id), [
      {
        type: 'user',
        id: sessionEvent.messageId,
        turnId,
        ts: sessionEvent.ts,
        text: sessionEvent.content.text,
        displayText: '/skill:writer persist this interjection',
        inlineReferences: [{ kind: 'skill', value: '/skill:writer', label: 'Writer', start: 0 }],
        steeringEventId: sessionEvent.id,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovers a steering transcript message from the committed RuntimeEvent ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-steering-crash-cut-'));
  try {
    const store = createSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/cwd',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const runId = 'run-steering-crash-cut';
    const turnId = 'turn-steering-crash-cut';
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    await runStore.createRun(makeRunHeader(session.id, runId, turnId));
    const steeringContent = {
      kind: 'text' as const,
      text: 'canonical steering envelope',
      displayText: '/skill:writer recover this interjection',
      attachments: [
        {
          kind: 'pdf' as const,
          name: 'evidence.pdf',
          mimeType: 'application/pdf',
          bytes: 2048,
          ref: {
            kind: 'session_file' as const,
            sessionId: session.id,
            relativePath: 'attachments/evidence.pdf',
          },
        },
      ],
      quotes: [{ text: 'quoted evidence', label: 'Assistant', sourceTurnId: 'turn-source' }],
      inlineReferences: [
        { kind: 'skill' as const, value: '/skill:writer', label: 'Writer', start: 0 },
      ],
      steering: true as const,
    };
    const runtimeEvent: RuntimeEvent = {
      id: 'runtime-steering-crash-cut',
      invocationId: 'invocation-steering-crash-cut',
      runId,
      sessionId: session.id,
      turnId,
      ts: 2,
      partial: false,
      role: 'user',
      author: 'user',
      content: steeringContent,
      refs: { providerEventId: 'message-steering-crash-cut' },
    };
    await runtimeEventStore.appendRuntimeEvent(session.id, runId, runtimeEvent);
    assert.deepEqual(await store.readMessages(session.id), []);

    const recoveredStore = createSessionStore(root);
    const recoveredRunStore = createSqliteAgentRunStore(root);
    const recoveredRuntimeEventStore = createWorkspaceRuntimeStore(root);
    const repair = new RuntimeLedgerRepair({
      runStore: recoveredRunStore,
      runtimeEventStore: recoveredRuntimeEventStore,
      readMessages: (sessionId) => recoveredStore.readMessages(sessionId),
      appendMessage: (sessionId, message) => recoveredStore.appendMessage(sessionId, message),
      appendTurnState: async () => {},
      newId: () => 'unused-id',
      now: () => 10,
    });

    assert.equal(await repair.repairSteeringMessagesOnce(session.id), 1);
    assert.equal(await repair.repairSteeringMessagesOnce(session.id), 0);
    assert.deepEqual(await recoveredStore.readMessages(session.id), [
      {
        type: 'user',
        id: 'message-steering-crash-cut',
        turnId,
        ts: 2,
        text: 'canonical steering envelope',
        displayText: '/skill:writer recover this interjection',
        attachments: steeringContent.attachments,
        quotes: steeringContent.quotes,
        inlineReferences: steeringContent.inlineReferences,
        steeringEventId: runtimeEvent.id,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('awaits canonical Run status persistence before accepting an interaction resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-status-barrier-'));
  try {
    const store = createSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/cwd',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const runId = 'run-status-barrier';
    const turnId = 'turn-status-barrier';
    await store.updateHeader(session.id, buildStatusPatch('waiting_for_user', 1));
    await runStore.createRun({
      ...makeRunHeader(session.id, runId, turnId),
      status: 'waiting_for_user',
    });
    const updateStarted = deferred<void>();
    const allowUpdate = deferred<void>();
    const auditStarted = deferred<void>();
    const allowAudit = deferred<void>();
    const delayedRunStore = {
      updateRun: async (...args: Parameters<typeof runStore.updateRun>) => {
        updateStarted.resolve();
        await allowUpdate.promise;
        return await runStore.updateRun(...args);
      },
      appendEvent: async (...args: Parameters<typeof runStore.appendEvent>) => {
        if (args[2].type === 'run_status_changed') {
          auditStarted.resolve();
          await allowAudit.promise;
        }
        return await runStore.appendEvent(...args);
      },
    } as typeof runStore;
    let sessionUpdateStarted = false;
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
        reserveRun: async () => {
          throw new Error('reserveRun should not be called');
        },
        unregisterRun: () => {},
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async (sessionId, status, blockedReason, ts = 0) => {
          sessionUpdateStarted = true;
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

    try {
      await updateStarted.promise;
      assert.equal(accepted, false);
      assert.equal((await store.readHeader(session.id)).status, 'waiting_for_user');
      allowUpdate.resolve();
      await auditStarted.promise;
      await Promise.resolve();
      assert.equal(accepted, false);
      assert.equal(sessionUpdateStarted, false);
      assert.equal((await store.readHeader(session.id)).status, 'waiting_for_user');
      allowAudit.resolve();
      await accepting;
      assert.equal(sessionUpdateStarted, true);
      assert.equal((await runStore.readRun(session.id, runId))?.status, 'running');
      assert.equal((await store.readHeader(session.id)).status, 'running');
    } finally {
      allowUpdate.resolve();
      allowAudit.resolve();
      await accepting.catch(() => undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('required interaction resume recovers a failed best-effort Run Store latch through terminal commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-status-latch-'));
  try {
    const store = createSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/cwd',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
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
        reserveRun: async () => {
          throw new Error('reserveRun should not be called');
        },
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

    await run.recordRuntimeEvents([
      {
        id: 'terminal-after-latch',
        invocationId: run.invocationId,
        runId,
        sessionId: session.id,
        turnId,
        ts: 3,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      },
    ]);
    await run.recordSessionEvent({
      type: 'complete',
      id: 'complete-after-latch',
      turnId,
      ts: 3,
      stopReason: 'end_turn',
    });
    await run.finalize();

    const completedRun = await runStore.readRun(session.id, runId);
    assert.equal(completedRun?.status, 'completed');
    assert.equal(completedRun?.completedAt, 3);
    assert.equal(
      (await runtimeEventStore.readImmutableRuntimeEvents(session.id, runId)).at(-1)?.status,
      'completed',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('required interaction resume stays fail-closed until a later required write succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-status-latch-failure-'));
  try {
    const store = createSessionStore(root);
    const session = await store.create({
      cwd: '/tmp/cwd',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const runId = 'run-status-latch-failure';
    const turnId = 'turn-status-latch-failure';
    await store.updateHeader(session.id, buildStatusPatch('waiting_for_user', 1));
    await runStore.createRun({
      ...makeRunHeader(session.id, runId, turnId),
      status: 'waiting_for_user',
    });
    let failNextAppend = true;
    let failRequiredUpdate = false;
    const failingRunStore = {
      updateRun: async (...args: Parameters<typeof runStore.updateRun>) => {
        if (failRequiredUpdate) throw new Error('injected required status failure');
        return await runStore.updateRun(...args);
      },
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
      userInput: { turnId, text: 'remain waiting after repeated store failure' },
      runId,
      durability: 'required',
      store,
      runStore: failingRunStore,
      runtimeEventStore,
      newId: () => 'status-latch-failure-event',
      now: () => 10,
      recordSessionMessages: false,
      hooks: {
        reserveRun: async () => {
          throw new Error('reserveRun should not be called');
        },
        unregisterRun: () => {},
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async (sessionId, status, blockedReason, ts = 0) => {
          await store.updateHeader(sessionId, buildStatusPatch(status, ts, blockedReason));
        },
        appendTurnState: async () => {},
      },
    });
    run.recordRunTrace({
      id: 'trace-that-fails-before-required-write',
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
    failRequiredUpdate = true;

    await assert.rejects(
      run.recordSessionEvent({
        type: 'user_question_answer_ack',
        id: 'answer-after-repeated-failure',
        turnId,
        ts: 2,
        requestId: 'question-1',
        toolUseId: 'tool-1',
      }),
      /injected required status failure/,
    );
    assert.equal((await runStore.readRun(session.id, runId))?.status, 'waiting_for_user');
    assert.equal((await store.readHeader(session.id)).status, 'waiting_for_user');

    failRequiredUpdate = false;
    await run.recordSessionEvent({
      type: 'user_question_answer_ack',
      id: 'answer-after-required-store-recovers',
      turnId,
      ts: 3,
      requestId: 'question-1',
      toolUseId: 'tool-1',
    });
    await run.recordRuntimeEvents([
      {
        id: 'terminal-after-required-store-recovers',
        invocationId: run.invocationId,
        runId,
        sessionId: session.id,
        turnId,
        ts: 4,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      },
    ]);
    await run.recordSessionEvent({
      type: 'complete',
      id: 'complete-after-required-store-recovers',
      turnId,
      ts: 4,
      stopReason: 'end_turn',
    });
    await run.finalize();

    assert.equal((await runStore.readRun(session.id, runId))?.status, 'completed');
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
