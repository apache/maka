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
import { test } from 'node:test';
import type { RootTurnAdmission } from '@maka/storage/execution-stores';
import { openInteractiveScheduledTaskStoreForWrite } from '@maka/storage/scheduled-task-store';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { SessionNotFoundError } from '@maka/storage/session-store';
import {
  HostScheduledTaskCoordinator,
  scheduledTaskExecutionFingerprint,
} from '../server/scheduled-task-coordinator.js';

test('ScheduledTask recovery distinguishes a settled fire from a newer pending fire', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-scheduled-task-recovery-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire the ScheduledTask recovery test root');
  const store = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  const coordinator = new HostScheduledTaskCoordinator({
    store,
    sessions: null as never,
    runtime: null as never,
    root: null as never,
    runtimePolicy: null as never,
    nativeEffects: null as never,
    createSession: async () => undefined,
    changes: { publish: () => undefined },
    acquireResidency: () => ({ release: () => undefined }),
    requestDrain: () => undefined,
  });
  try {
    const task = await store.create(
      {
        title: 'Recurring recovery task',
        intentBody: 'Continue the scheduled work.',
        schedule: { kind: 'interval', everySeconds: 60 },
        effect: {
          kind: 'agent_run',
          execution: {
            cwd: '/workspace',
            backend: 'ai-sdk',
            llmConnectionId: 'connection-default',
            llmConnectionSlug: 'default',
            model: 'test-model',
            permissionMode: 'ask',
            collaborationMode: 'agent',
            orchestrationMode: 'default',
          },
        },
        createdBy: { kind: 'user' },
      },
      1_000,
    );
    const oldExecution = execution('old');
    const oldClaim = await store.claimNow(task.id, 2_000);
    await store.bindFireExecution(oldClaim.id, oldExecution);
    await store.settleFire(oldClaim.id, {
      at: 2_001,
      outcome: 'ok',
      message: 'settled before the AgentRun terminal fact',
      sessionId: oldExecution.sessionId,
      runId: oldExecution.runId,
    });
    const newExecution = execution('new');
    const newClaim = await store.claimNow(task.id, 3_000);
    await store.bindFireExecution(newClaim.id, newExecution);

    await coordinator.prepareRecovery();
    const fingerprint =
      task.effect.kind === 'agent_run'
        ? scheduledTaskExecutionFingerprint(task.effect.execution)
        : undefined;
    await coordinator.assertRecoveryAdmission(
      admission(task.id, oldExecution, fingerprint),
      'run_recorded',
    );
    await coordinator.assertRecoveryAdmission(
      admission(task.id, newExecution, fingerprint),
      'pending_fire_required',
    );
    await assert.rejects(
      () =>
        coordinator.assertRecoveryAdmission(
          admission(task.id, execution('missing')),
          'pending_fire_required',
        ),
      /has no matching pending fire/,
    );
    await assert.rejects(
      () =>
        coordinator.assertRecoveryAdmission(
          admission(task.id, newExecution, `sha256:${'b'.repeat(64)}`),
          'pending_fire_required',
        ),
      /has no matching pending fire/,
    );

    await store.settleFire(newClaim.id, {
      at: 3_001,
      outcome: 'ok',
      message: 'settled newer fire',
      sessionId: newExecution.sessionId,
      runId: newExecution.runId,
    });
    const conflictingExecution = { ...oldExecution, runId: 'run-conflicting' };
    const conflictingClaim = await store.claimNow(task.id, 4_000);
    await store.bindFireExecution(conflictingClaim.id, conflictingExecution);
    await assert.rejects(
      () =>
        coordinator.assertRecoveryAdmission(
          admission(task.id, oldExecution, fingerprint),
          'run_recorded',
        ),
      /has no matching pending fire/,
    );
  } finally {
    await coordinator.close();
    store.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('ScheduledTask execution fails closed when the bound Connection identity is replaced', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-scheduled-task-identity-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire the ScheduledTask identity test root');
  const store = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  let createSessionCalls = 0;
  let admitCalls = 0;
  const coordinator = new HostScheduledTaskCoordinator({
    store,
    sessions: {
      readHeaderSnapshot: async () => {
        throw new SessionNotFoundError('scheduled-task-session');
      },
    },
    runtime: {
      sendMessage: async function* () {
        // The replacement-identity path must fail before this stream is used.
      },
    },
    root: {
      admit: async () => {
        admitCalls += 1;
        throw new Error('stale ScheduledTask was admitted');
      },
    },
    runtimePolicy: {
      runtimePolicy: {
        getSnapshot: async () => ({ policy: { privacy: { incognitoActive: false } } }),
      },
      connectionCatalog: null as never,
      credentialVault: null as never,
      operations: {
        resolveExecutionConnection: async () => ({ kind: 'identity_mismatch' as const }),
      },
    } as never,
    nativeEffects: null as never,
    createSession: async () => {
      createSessionCalls += 1;
    },
    changes: { publish: () => undefined },
    acquireResidency: () => ({ release: () => undefined }),
    requestDrain: () => undefined,
  });
  try {
    await coordinator.prepareRecovery();
    const created = await coordinator.handlers['scheduled-task.mutate'](
      {
        kind: 'create',
        input: {
          title: 'Rejected replacement target',
          intentBody: 'Must not persist an unresolvable Connection tuple.',
          schedule: { kind: 'once', runAt: Date.now() + 60_000 },
          effect: {
            kind: 'agent_run',
            execution: {
              cwd: '/workspace',
              llmConnectionId: 'connection-a',
              llmConnectionSlug: 'shared-slug',
              model: 'model-a',
              permissionMode: 'ask',
              collaborationMode: 'agent',
              orchestrationMode: 'default',
            },
          },
        },
      },
      {} as never,
    );
    assert.equal(created.ok, true);
    if (!created.ok || created.result.kind !== 'task') return;
    assert.equal(created.result.task.effect.kind, 'agent_run');
    assert.equal((await store.list()).length, 1);

    const updated = await coordinator.handlers['scheduled-task.mutate'](
      {
        kind: 'update',
        taskId: created.result.task.id,
        patch: {
          title: 'Updated while temporarily unavailable',
          effect: created.result.task.effect,
        },
      },
      {} as never,
    );
    assert.equal(updated.ok, true);
    if (!updated.ok || updated.result.kind !== 'task') return;
    assert.equal(updated.result.task.title, 'Updated while temporarily unavailable');

    const task = await store.create(
      {
        title: 'Replaced connection task',
        intentBody: 'Must not use a same-slug replacement.',
        schedule: { kind: 'once', runAt: 2_000 },
        effect: {
          kind: 'agent_run',
          execution: {
            cwd: '/workspace',
            llmConnectionId: 'connection-a',
            llmConnectionSlug: 'shared-slug',
            model: 'model-a',
            permissionMode: 'ask',
            collaborationMode: 'agent',
            orchestrationMode: 'default',
          },
        },
        createdBy: { kind: 'user' },
      },
      1_000,
    );
    const result = await coordinator.handlers['scheduled-task.mutate'](
      {
        kind: 'trigger_now',
        taskId: task.id,
      },
      {} as never,
    );
    assert.equal(result.ok, true);
    if (!result.ok || result.result.kind !== 'task') return;
    assert.equal(result.result.task.runs[0]?.outcome, 'failed');
    assert.equal(result.result.task.lastError, 'ScheduledTask model connection identity changed');
    assert.equal(createSessionCalls, 0);
    assert.equal(admitCalls, 0);
  } finally {
    await coordinator.close();
    store.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('ScheduledTask with an exact Connection identity reaches Session and AgentRun admission', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-scheduled-task-success-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire the ScheduledTask success test root');
  const store = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  let createSessionCalls = 0;
  let admitCalls = 0;
  let expectedTaskId = '';
  const connection = {
    connectionId: 'connection-a',
    revision: 1,
    slug: 'shared-slug',
    name: 'Account A',
    providerType: 'openai' as const,
    enabled: true,
    enabledModelIds: ['model-a'],
    models: [],
  };
  const coordinator = new HostScheduledTaskCoordinator({
    store,
    sessions: {
      readHeaderSnapshot: async () => {
        throw new SessionNotFoundError('scheduled-task-session');
      },
    },
    runtime: {
      sendMessage: async function* () {
        // The admission authority owns execution startup in this unit test.
      },
    },
    root: {
      admit: async (input) => {
        admitCalls += 1;
        assert.equal(input.execution.kind, 'scheduled_task');
        if (input.execution.kind === 'scheduled_task') {
          assert.equal(input.execution.scheduledTaskId, expectedTaskId);
          assert.equal(
            input.execution.executionFingerprint,
            scheduledTaskExecutionFingerprint({
              cwd: '/workspace',
              llmConnectionId: 'connection-a',
              llmConnectionSlug: 'shared-slug',
              model: 'model-a',
              permissionMode: 'ask',
              collaborationMode: 'agent',
              orchestrationMode: 'default',
            }),
          );
        }
        return {} as never;
      },
    },
    runtimePolicy: {
      runtimePolicy: {
        getSnapshot: async () => ({ policy: { privacy: { incognitoActive: false } } }),
      },
      connectionCatalog: null as never,
      credentialVault: null as never,
      operations: {
        resolveExecutionConnection: async () => ({ kind: 'ready' as const, connection }),
      },
    } as never,
    nativeEffects: null as never,
    createSession: async (input) => {
      createSessionCalls += 1;
      assert.deepEqual(input.modelTarget, {
        kind: 'explicit',
        connectionId: 'connection-a',
        connectionSlug: 'shared-slug',
        model: 'model-a',
      });
    },
    changes: { publish: () => undefined },
    acquireResidency: () => ({ release: () => undefined }),
    requestDrain: () => undefined,
  });
  try {
    const task = await store.create(
      {
        title: 'Exact connection task',
        intentBody: 'Run with the frozen account.',
        schedule: { kind: 'once', runAt: 2_000 },
        effect: {
          kind: 'agent_run',
          execution: {
            cwd: '/workspace',
            llmConnectionId: 'connection-a',
            llmConnectionSlug: 'shared-slug',
            model: 'model-a',
            permissionMode: 'ask',
            collaborationMode: 'agent',
            orchestrationMode: 'default',
          },
        },
        createdBy: { kind: 'user' },
      },
      1_000,
    );
    expectedTaskId = task.id;
    await coordinator.prepareRecovery();
    const result = await coordinator.handlers['scheduled-task.mutate'](
      { kind: 'trigger_now', taskId: task.id },
      {} as never,
    );
    assert.equal(result.ok, true);
    if (!result.ok || result.result.kind !== 'task') return;
    assert.equal(result.result.task.runs[0]?.outcome, 'ok');
    assert.equal(createSessionCalls, 1);
    assert.equal(admitCalls, 1);
  } finally {
    await coordinator.close();
    store.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

function execution(suffix: string) {
  return {
    sessionId: `session-${suffix}`,
    turnId: `turn-${suffix}`,
    runId: `run-${suffix}`,
    userMessageId: `message-${suffix}`,
  };
}

function admission(
  scheduledTaskId: string,
  identity: ReturnType<typeof execution>,
  executionFingerprint?: `sha256:${string}`,
): RootTurnAdmission {
  return {
    schemaVersion: 1,
    ...identity,
    execution: {
      kind: 'scheduled_task',
      scheduledTaskId,
      ...(executionFingerprint === undefined ? {} : { executionFingerprint }),
    },
    previousRootTurnId: null,
    normalizedInput: { text: 'Continue the scheduled work.' },
    sourceMessages: [],
    admittedAt: 1_000,
  };
}
