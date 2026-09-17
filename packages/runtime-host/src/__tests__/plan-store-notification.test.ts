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

import { buildCancelPlanTool, buildUpdatePlanTool } from '@maka/runtime/plan-tools';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import {
  authenticateInteractivePlanStoreWriter,
  observeInteractivePlanStoreWriter,
  openInteractivePlanStoreForWrite,
  type InteractivePlanStoreWriter,
} from '@maka/storage/plan-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';

const SESSION_ID = 'session-1';
const STEPS = [{ id: 'step-1', title: 'Inspect', description: 'Inspect the code.' }];

test('Plan execution tools publish after committed writes and not after rejected writes', async () => {
  const fixture = await openFixture();
  try {
    const notifications: string[] = [];
    let drains = 0;
    const store = fixture.observe(
      (sessionId) => notifications.push(sessionId),
      () => {
        drains += 1;
      },
    );
    const executionId = await createActiveExecution(store);
    notifications.length = 0;

    const update = buildUpdatePlanTool(store, executionId);
    await update.impl(
      { steps: [{ id: 'step-1', status: 'in_progress' }] },
      toolContext('update-call'),
    );
    assert.deepEqual(notifications, [SESSION_ID]);
    assert.equal(
      (await store.readState(SESSION_ID)).executions[0]?.steps[0]?.status,
      'in_progress',
    );

    await assert.rejects(
      async () => await update.impl({ steps: [] }, toolContext('bad-update-call')),
      /must include every execution step/,
    );
    assert.deepEqual(notifications, [SESSION_ID], 'rejected writes publish no invalidation');

    const cancel = buildCancelPlanTool(store, executionId);
    await cancel.impl({ reason: 'User abandoned the plan.' }, toolContext('cancel-call'));
    assert.deepEqual(notifications, [SESSION_ID, SESSION_ID]);
    assert.equal((await store.readState(SESSION_ID)).activeExecutionId, undefined);
    assert.equal(drains, 0);
  } finally {
    await fixture.close();
  }
});

test('optional no-op Plan interrupts do not publish', async () => {
  const fixture = await openFixture();
  try {
    const notifications: string[] = [];
    const store = fixture.observe(
      (sessionId) => notifications.push(sessionId),
      () => assert.fail('no-op interrupt must not drain'),
    );

    assert.equal(
      await store.interruptActiveExecution('idle-session', 'No active execution', 'interrupt-idle'),
      null,
    );
    assert.deepEqual(notifications, []);
  } finally {
    await fixture.close();
  }
});

test('notification failures request drain without turning durable writes into failures', async () => {
  const fixture = await openFixture();
  try {
    const executionId = await createActiveExecution(fixture.source);
    let drains = 0;
    const store = fixture.observe(
      () => {
        throw new Error('subscriber failed');
      },
      () => {
        drains += 1;
      },
    );

    const result = await buildUpdatePlanTool(store, executionId).impl(
      { steps: [{ id: 'step-1', status: 'in_progress' }] },
      toolContext('update-call'),
    );

    assert.equal(result.kind, 'plan_progress_updated');
    assert.equal(drains, 1);
    assert.equal(
      (await store.readState(SESSION_ID)).executions[0]?.steps[0]?.status,
      'in_progress',
    );
  } finally {
    await fixture.close();
  }
});

test('a closed observed writer no longer authenticates', async () => {
  const fixture = await openFixture();
  try {
    const store = fixture.observe(
      () => {
        throw new Error('a closed writer must not publish');
      },
      () => assert.fail('a closed writer must not request a drain'),
    );
    assert.equal(authenticateInteractivePlanStoreWriter(store), store);

    store.close();

    assert.throws(
      () => authenticateInteractivePlanStoreWriter(store),
      (error: unknown) => (error as { code?: string }).code === 'invalid_lease',
      'closing the decorator must retire its own authority',
    );
  } finally {
    await fixture.close();
  }
});

async function createActiveExecution(store: InteractivePlanStoreWriter): Promise<string> {
  const submitted = await store.submitProposal({
    operationId: 'submit-1',
    sessionId: SESSION_ID,
    turnId: 'turn-1',
    title: 'Plan',
    steps: STEPS,
  });
  assert.equal(submitted.event.type, 'plan_submitted');
  if (submitted.event.type !== 'plan_submitted') throw new Error('Plan was not submitted');

  const approved = await store.approveProposal({
    operationId: 'approve-1',
    sessionId: SESSION_ID,
    proposalId: submitted.event.proposal.proposalId,
    expectedRevision: submitted.event.proposal.revision,
    expectedStoreVersion: submitted.state.storeVersion,
  });
  assert.equal(approved.event.type, 'plan_approved');
  if (approved.event.type !== 'plan_approved') throw new Error('Plan was not approved');
  return approved.event.execution.executionId;
}

async function openFixture(): Promise<{
  source: InteractivePlanStoreWriter;
  /** Decorates the raw writer, and takes over closing it. */
  observe(onChange: (sessionId: string) => void, onDrain: () => void): InteractivePlanStoreWriter;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'maka-plan-notify-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire the interactive storage root');
  const source = await openInteractivePlanStoreForWrite(owner.lease);
  let observed: InteractivePlanStoreWriter | undefined;
  return {
    source,
    observe: (onChange, onDrain) =>
      (observed = observeInteractivePlanStoreWriter(source, onChange, onDrain)),
    close: async () => {
      (observed ?? source).close();
      await owner.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function toolContext(toolCallId: string): MakaToolContext {
  return {
    sessionId: SESSION_ID,
    turnId: 'turn-1',
    toolCallId,
    cwd: '/workspace',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}
