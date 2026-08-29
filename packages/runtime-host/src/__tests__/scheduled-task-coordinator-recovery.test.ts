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
import { HostScheduledTaskCoordinator } from '../server/scheduled-task-coordinator.js';

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
    await coordinator.assertRecoveryAdmission(admission(task.id, oldExecution), 'run_recorded');
    await coordinator.assertRecoveryAdmission(
      admission(task.id, newExecution),
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
      () => coordinator.assertRecoveryAdmission(admission(task.id, oldExecution), 'run_recorded'),
      /has no matching pending fire/,
    );
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
): RootTurnAdmission {
  return {
    schemaVersion: 1,
    ...identity,
    execution: { kind: 'scheduled_task', scheduledTaskId },
    previousRootTurnId: null,
    normalizedInput: { text: 'Continue the scheduled work.' },
    sourceMessages: [],
    admittedAt: 1_000,
  };
}
