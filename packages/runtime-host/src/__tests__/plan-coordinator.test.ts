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
import { PLAN_USER_ABANDON_REASON, PLAN_USER_CANCEL_REASON } from '@maka/core/plan';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractivePlanStoreForWrite } from '@maka/storage/plan-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { PlanControlInput } from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostPlanCoordinator } from '../server/plan-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const context: ConnectionContext = {
  hostEpoch: 'plan-test-epoch',
  connectionId: 'plan-test-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('ordinary approval and resume wake only once after durable control and refresh', async () => {
  const fixture = await createFixture();
  try {
    const approval = await fixture.submit();
    const approved = await fixture.control(approval);
    assert.ok(approved.ok);
    assert.deepEqual(fixture.observed, ['projection', 'refreshed', 'resumed']);
    const executionId = approved.result.executionId!;

    await fixture.store.interruptActiveExecution(fixture.sessionId, 'test pause');
    fixture.observed.length = 0;
    assert.deepEqual(await fixture.control(approval), approved);
    assert.deepEqual(fixture.observed, ['projection', 'refreshed']);
    assert.equal((await fixture.store.readState(fixture.sessionId)).activeExecutionId, undefined);

    fixture.observed.length = 0;
    const resume = {
      kind: 'resume_execution' as const,
      sessionId: fixture.sessionId,
      executionId,
      operationId: 'resume-operation',
    };
    const resumed = await fixture.control(resume);
    assert.ok(resumed.ok);
    assert.deepEqual(fixture.observed, ['projection', 'refreshed', 'resumed']);
    await fixture.store.interruptActiveExecution(fixture.sessionId, 'test pause again');

    fixture.observed.length = 0;
    const cancelled = await fixture.control({
      kind: 'cancel_execution',
      sessionId: fixture.sessionId,
      executionId,
      operationId: 'cancel-operation',
    });
    assert.ok(cancelled.ok);
    assert.deepEqual(fixture.observed, ['projection', 'refreshed']);
    fixture.observed.length = 0;
    assert.deepEqual(await fixture.control(resume), resumed);
    assert.deepEqual(fixture.observed, ['projection', 'refreshed']);
    assert.equal(
      (await fixture.store.readState(fixture.sessionId)).executions[0]?.status,
      'cancelled',
    );
    await fixture.archive(true);
    fixture.observed.length = 0;
    assert.deepEqual(await fixture.control(approval), approved);
    assert.deepEqual(fixture.observed, ['projection', 'refreshed']);
  } finally {
    await fixture.close();
  }
});

test('archived, conflicting, and abandoned Plan controls do not wake execution', async () => {
  const fixture = await createFixture();
  try {
    const approval = await fixture.submit();
    const stale = await fixture.control({ ...approval, expectedRevision: 999 });
    assert.equal(stale.ok, false);
    assert.deepEqual(fixture.observed, []);
    await fixture.archive(true);
    const archived = await fixture.control(approval);
    assert.equal(archived.ok ? null : archived.error.code, 'session_archived');
    assert.deepEqual(fixture.observed, []);
    await fixture.archive(false);
    const abandoned = await fixture.control({
      kind: 'abandon_proposal',
      sessionId: fixture.sessionId,
      proposalId: approval.proposalId,
      operationId: 'abandon-operation',
    });
    assert.ok(abandoned.ok);
    assert.deepEqual(fixture.observed, ['projection', 'refreshed']);
  } finally {
    await fixture.close();
  }
});

test('foreground Plan turns notify recovery after admission for approval or resume', async () => {
  const fixture = await createFixture();
  try {
    const approval = await fixture.submit();
    const { operationId: _operationId, ...turnApproval } = approval;
    const approved = await fixture.coordinator.handlers['plan.turn.start'](
      { ...turnApproval, turnId: 'approval-turn' },
      context,
    );
    assert.ok(approved.ok);
    assert.deepEqual(fixture.observed, ['projection', 'refreshed', 'admitted', 'resumed']);
    await fixture.store.interruptActiveExecution(fixture.sessionId, 'test pause');
    fixture.observed.length = 0;
    const resumed = await fixture.coordinator.handlers['plan.turn.start'](
      {
        kind: 'resume_execution',
        sessionId: fixture.sessionId,
        executionId: approved.result.plan.executionId!,
        turnId: 'resume-turn',
      },
      context,
    );
    assert.ok(resumed.ok);
    assert.deepEqual(fixture.observed, ['projection', 'refreshed', 'admitted', 'resumed']);
    fixture.observed.length = 0;
    const replay = await fixture.coordinator.handlers['plan.turn.start'](
      { ...turnApproval, turnId: 'approval-turn' },
      context,
    );
    assert.ok(replay.ok);
    assert.deepEqual(fixture.observed, ['projection', 'refreshed', 'admitted']);
  } finally {
    await fixture.close();
  }
});

test('Plan control commit still notifies recovery when subsequent foreground admission is rejected', async () => {
  const fixture = await createFixture({ rejectTurn: true });
  try {
    const { operationId: _operationId, ...approval } = await fixture.submit();
    const outcome = await fixture.coordinator.handlers['plan.turn.start'](
      { ...approval, turnId: 'rejected-turn' },
      context,
    );
    assert.equal(outcome.ok ? null : outcome.error.code, 'operation_conflict');
    assert.ok((await fixture.store.readState(fixture.sessionId)).activeExecutionId);
    assert.deepEqual(fixture.observed, ['projection', 'refreshed', 'admitted', 'resumed']);
  } finally {
    await fixture.close();
  }
});

test('failed refresh after approval does not wake execution or replay a stale wake', async () => {
  const options = { failRefresh: true };
  const fixture = await createFixture(options);
  try {
    const approval = await fixture.submit();
    const result = await fixture.control(approval);
    assert.equal(result.ok ? null : result.error.code, 'persistence_failed');
    assert.deepEqual(fixture.observed, ['projection', 'drain']);
    assert.ok((await fixture.store.readState(fixture.sessionId)).activeExecutionId);
    options.failRefresh = false;
    fixture.observed.length = 0;
    assert.ok((await fixture.control(approval)).ok);
    assert.deepEqual(fixture.observed, ['projection', 'refreshed']);
  } finally {
    await fixture.close();
  }
});

async function createFixture(options: { failRefresh?: boolean; rejectTurn?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maka-plan-coordinator-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const { sessionStore: sessions } = await openInteractiveExecutionStoresForWrite(owner.lease);
  const store = await openInteractivePlanStoreForWrite(owner.lease);
  const session = await sessions.create({
    cwd: root,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'explore',
    collaborationMode: 'plan',
  });
  const observed: string[] = [];
  const admission = new SessionAdmissionGate();
  let foregroundAdmissionPending = false;
  const coordinator = new HostPlanCoordinator({
    store,
    sessions,
    sessionAdmission: admission,
    runtime: {
      approvePlan: (input) => store.approveProposal(input),
      resumePlanExecution: (sessionId, executionId, operationId) =>
        store.resumeExecution(sessionId, executionId, operationId),
      cancelPlanExecution: (sessionId, executionId, operationId) =>
        store.cancelExecution({
          sessionId,
          executionId,
          operationId,
          reason: PLAN_USER_CANCEL_REASON,
        }),
      abandonPlanProposal: (sessionId, proposalId, operationId) =>
        store.abandonProposal({
          sessionId,
          proposalId,
          operationId,
          reason: PLAN_USER_ABANDON_REASON,
        }),
      requestPlanRevision: (sessionId, proposalId, operationId) =>
        store.requestRevision({ sessionId, proposalId, operationId }),
    },
    isSessionActive: () => false,
    onProjectionChanged: () => observed.push('projection'),
    refreshContinuity: async (sessionId) => {
      if (options.failRefresh) throw new Error('Refresh unavailable');
      assert.ok((await store.readState(sessionId)).storeVersion > 1);
      observed.push('refreshed');
    },
    onExecutionResumed: (sessionId) => {
      assert.equal(sessionId, session.id);
      assert.equal(foregroundAdmissionPending, false);
      assert.ok(['refreshed', 'admitted'].includes(observed.at(-1)!));
      observed.push('resumed');
    },
    requestDrain: () => observed.push('drain'),
    root: {
      startHostedExternalTransition: async (input) => {
        foregroundAdmissionPending = true;
        const outcome = await admission.run<
          Awaited<
            ReturnType<
              NonNullable<
                ConstructorParameters<typeof HostPlanCoordinator>[0]['root']
              >['startHostedExternalTransition']
            >
          >
        >(input.sessionId, async (lease) => {
          const prepared = await input.prepareContent(lease);
          if (prepared.kind === 'rejected') return prepared.outcome;
          observed.push('admitted');
          if (options.rejectTurn) {
            return {
              ok: false,
              error: { code: 'operation_conflict', message: 'Admission rejected' },
            };
          }
          return {
            ok: true,
            result: {
              sessionId: input.sessionId,
              turnId: input.turnId,
              runId: 'foreground-run',
              status: 'running',
            },
          };
        });
        foregroundAdmissionPending = false;
        return outcome;
      },
    },
  });
  return {
    coordinator,
    store,
    sessions,
    observed,
    sessionId: session.id,
    control: (input: PlanControlInput) => coordinator.handlers['plan.control'](input, context),
    archive: async (isArchived: boolean) => {
      const { revision } = await sessions.readHeaderRecordSnapshot(session.id);
      await sessions.setSessionsArchivedVersioned(
        [{ sessionId: session.id, expectedVersion: revision }],
        isArchived,
      );
    },
    submit: async () => {
      const submitted = await store.submitProposal({
        sessionId: session.id,
        turnId: 'proposal-turn',
        operationId: 'submit-operation',
        title: 'Test Plan',
        steps: [{ id: 'step-1', title: 'Run work', description: 'Run pending work' }],
      });
      assert.equal(submitted.event.type, 'plan_submitted');
      if (submitted.event.type !== 'plan_submitted') throw new Error('Missing proposal');
      return {
        kind: 'approve_proposal' as const,
        sessionId: session.id,
        proposalId: submitted.event.proposal.proposalId,
        expectedRevision: submitted.event.proposal.revision,
        expectedStoreVersion: submitted.state.storeVersion,
        operationId: 'approve-operation',
      };
    },
    close: async () => {
      store.close();
      await owner.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
