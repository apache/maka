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

import { deferred } from '@maka/core/test-only/async-primitives';
import { access, chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionEvent } from '@maka/core/events';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { createSessionStore } from '@maka/storage/session-store';
import { AgentRun } from '../agent-run.js';
import { buildStatusPatch } from '../session-projection-helpers.js';
import { waitFor as pollFor } from '@maka/core/test-only/async-primitives';
import { seedInvocation } from './invocation-fixture.js';

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
          newId: () => 'unused',
          now: () => 1,
          hooks: {
            reserveRun: async () => {
              throw new Error('reserveRun should not be called');
            },
            unregisterRun: () => {},
            updateHeader: async () => session,
            updateStatus: async () => {},
          },
        }),
      /invalid tool mode/i,
    );
    assert.deepEqual(await runtimeEventStore.listSessionInvocations(session.id), []);
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
      runtimeEventStore,
      toolBoundaryProtocol: 't1_after_preflight_v1',
      newId: () => 'unused-id',
      now: () => 10,
      hooks: {
        reserveRun: async () => {
          throw new Error('reserveRun should not be called');
        },
        unregisterRun: () => {},
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
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
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId, text: 'start' },
      runId,
      runStore,
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

test('awaits the durable settlement fact before accepting an interaction resume', async () => {
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
    const { invocationId } = await seedInvocation(runtimeEventStore, {
      sessionId: session.id,
      runId,
      turnId,
      openedAt: 1,
    });
    const appendStarted = deferred<void>();
    const allowAppend = deferred<void>();
    const delayedRuntimeEventStore = {
      ...runtimeEventStore,
      appendRuntimeEvent: async (
        ...args: Parameters<typeof runtimeEventStore.appendRuntimeEvent>
      ) => {
        if (args[2].id === 'status-event') {
          appendStarted.resolve();
          await allowAppend.promise;
        }
        return await runtimeEventStore.appendRuntimeEvent(...args);
      },
    } as typeof runtimeEventStore;
    let sessionUpdateStarted = false;
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId, text: 'resume after answer' },
      runId,
      durability: 'required',
      runStore,
      runtimeEventStore: delayedRuntimeEventStore,
      newId: () => 'status-event',
      now: () => 10,
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
      },
    });
    let accepted = false;
    const accepting = run
      .acceptMappedEvent(
        {
          type: 'user_question_answer_ack',
          id: 'answer-ack',
          turnId,
          ts: 2,
          requestId: 'question-1',
          toolUseId: 'tool-1',
        },
        {
          id: 'status-event',
          invocationId,
          runId,
          sessionId: session.id,
          turnId,
          ts: 2,
          partial: false,
          role: 'system',
          author: 'user',
          actions: { userQuestionAnswerAccepted: { requestId: 'question-1' } },
          refs: { toolCallId: 'tool-1' },
        } satisfies RuntimeEvent,
      )
      .then(() => {
        accepted = true;
      });

    try {
      await appendStarted.promise;
      await Promise.resolve();
      assert.equal(accepted, false);
      assert.equal(sessionUpdateStarted, false);
      assert.equal((await store.readHeader(session.id)).status, 'waiting_for_user');
      allowAppend.resolve();
      await accepting;
      assert.equal(sessionUpdateStarted, true);
      assert.equal((await store.readHeader(session.id)).status, 'running');
    } finally {
      allowAppend.resolve();
      await accepting.catch(() => undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  await pollFor(predicate, {
    attempts: 100,
    pollMs: 5,
    message: 'Timed out waiting for asynchronous test condition',
  });
}
