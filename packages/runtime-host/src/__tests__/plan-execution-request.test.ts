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

import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractivePlanStoreForWrite } from '@maka/storage/plan-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';

import { HostPlanCoordinator, type HostPlanCoordinatorInput } from '../server/plan-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const STEPS = [
  { id: 'inspect', title: 'Inspect the caller', description: 'Read the relevant files.' },
  { id: 'patch', title: 'Land the fix', description: 'Update the Host request.' },
];

test('an approved Plan starts its Turn with the approved steps and the progress instruction', async () => {
  const fixture = await openFixture();
  try {
    const transition = captureTransitionRequest(fixture);
    const { executionId } = await approveFirstProposal(fixture, transition);

    const request = transition.requests[0];
    assert.ok(request);
    // The execution id is what the model needs to name the execution, and every
    // step id is required by update_plan.
    assert.match(
      request.text,
      new RegExp(`^Execute the approved plan execution ${executionId}\\.\n`),
    );
    assert.match(request.text, /^Steps:$/m);
    assert.match(request.text, /^- inspect \[pending\] Inspect the caller$/m);
    assert.match(request.text, /^- patch \[pending\] Land the fix$/m);
    assert.match(request.text, /^Use update_plan to keep every step status current\.$/m);
    assert.doesNotMatch(request.text, /cancel_plan/);
    assert.doesNotMatch(request.text, /Plan: Ship the plan request/);
    // The transcript keeps the approval the user performed, not the request.
    assert.equal(request.displayText, `Execute the approved plan execution ${executionId}.`);
  } finally {
    await fixture.close();
  }
});

test('a resumed Plan reports the progress reached before the interruption', async () => {
  const fixture = await openFixture();
  try {
    const transition = captureTransitionRequest(fixture);
    const { sessionId, executionId } = await approveFirstProposal(fixture, transition);

    await fixture.store.updateExecution({
      operationId: 'update-1',
      sessionId,
      executionId,
      steps: [
        { id: 'inspect', status: 'completed' },
        { id: 'patch', status: 'in_progress' },
      ],
    });
    const interrupted = await fixture.store.interruptActiveExecution(
      sessionId,
      'Test interruption',
      'interrupt-1',
    );
    assert.ok(interrupted);

    const resumed = await transition.coordinator.handlers['plan.turn.start'](
      {
        kind: 'resume_execution',
        sessionId,
        executionId,
        turnId: 'resume-turn',
      },
      null as never,
    );
    assert.ok(resumed.ok);

    const request = transition.requests[1];
    assert.ok(request);
    assert.match(
      request.text,
      new RegExp(`^Resume the approved plan execution ${executionId}\\.\n`),
    );
    assert.match(request.text, /^Steps:$/m);
    assert.match(request.text, /^- inspect \[completed\] Inspect the caller$/m);
    assert.match(request.text, /^- patch \[in_progress\] Land the fix$/m);
    assert.match(request.text, /^Use update_plan to keep every step status current\.$/m);
    assert.equal(request.displayText, `Resume the approved plan execution ${executionId}.`);
  } finally {
    await fixture.close();
  }
});

interface Fixture {
  store: HostPlanCoordinatorInput['store'];
  sessions: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
  createSession(): Promise<{ id: string }>;
  close(): Promise<void>;
}

/** Submits the Plan and approves it through the coordinator, as a Client would. */
async function approveFirstProposal(
  fixture: Fixture,
  transition: ReturnType<typeof captureTransitionRequest>,
): Promise<{ sessionId: string; executionId: string }> {
  const session = await fixture.createSession();
  const submitted = await fixture.store.submitProposal({
    operationId: 'submit-1',
    sessionId: session.id,
    turnId: 'turn-1',
    title: 'Ship the plan request',
    steps: STEPS,
  });
  assert.equal(submitted.event.type, 'plan_submitted');
  if (submitted.event.type !== 'plan_submitted') throw new Error('Plan was not submitted');

  const approved = await transition.coordinator.handlers['plan.turn.start'](
    {
      kind: 'approve_proposal',
      sessionId: session.id,
      proposalId: submitted.event.proposal.proposalId,
      expectedRevision: submitted.event.proposal.revision,
      expectedStoreVersion: submitted.state.storeVersion,
      turnId: 'approve-turn',
    },
    null as never,
  );
  assert.ok(approved.ok);
  const executionId = approved.result.plan.executionId;
  assert.ok(executionId);
  return { sessionId: session.id, executionId };
}

async function openFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'maka-plan-request-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire the interactive storage root');
  const store = await openInteractivePlanStoreForWrite(owner.lease);
  let sessions: Fixture['sessions'];
  try {
    sessions = await openInteractiveExecutionStoresForWrite(owner.lease);
  } catch (error) {
    store.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    store,
    sessions,
    createSession: () =>
      sessions.sessionStore.create({
        cwd: root,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'explore',
        collaborationMode: 'plan',
      }),
    close: async () => {
      store.close();
      await sessions.sessionStore.close?.();
      await owner.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * The production RootTurnCoordinator admits the Plan Turn; this fake records the
 * content the coordinator prepares and reports a live Turn, so the assertion
 * stays on the coordinator's own contract.
 */
function captureTransitionRequest(fixture: Fixture): {
  coordinator: HostPlanCoordinator;
  requests: Array<{ text: string; displayText: string | undefined }>;
} {
  const requests: Array<{ text: string; displayText: string | undefined }> = [];
  const runtime: HostPlanCoordinatorInput['runtime'] = {
    approvePlan: (input) => fixture.store.approveProposal(input),
    resumePlanExecution: (sessionId, executionId, operationId) =>
      fixture.store.resumeExecution(sessionId, executionId, operationId),
    requestPlanRevision: () => Promise.reject(new Error('unused in this test')),
    abandonPlanProposal: () => Promise.reject(new Error('unused in this test')),
    cancelPlanExecution: () => Promise.reject(new Error('unused in this test')),
  };
  const coordinator = new HostPlanCoordinator({
    store: fixture.store,
    sessions: fixture.sessions.sessionStore,
    runtime,
    sessionAdmission: new SessionAdmissionGate(),
    isSessionActive: () => false,
    refreshContinuity: async () => {},
    requestDrain: () => {},
    root: {
      startHostedExternalTransition: async (request) => {
        const prepared = await request.prepareContent({} as never);
        assert.equal(prepared.kind, 'ready');
        if (prepared.kind === 'ready') {
          requests.push({
            text: prepared.content.text,
            displayText: prepared.content.displayText,
          });
        }
        return {
          ok: true,
          result: {
            sessionId: request.sessionId,
            turnId: request.turnId,
            runId: 'run-1',
            status: 'running',
          },
        };
      },
    },
  });
  return { coordinator, requests };
}
