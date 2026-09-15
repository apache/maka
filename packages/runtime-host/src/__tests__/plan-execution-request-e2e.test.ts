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

import type { BackendSendInput } from '@maka/core/backend-types';
import { waitFor } from '@maka/core/test-only/async-primitives';
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractivePlanStoreForWrite } from '@maka/storage/plan-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';

import { connectRuntimeHost, type RuntimeHostConnection } from '../client/index.js';
import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import { RUNTIME_HOST_PROTOCOL_VERSION, type OperationOutput } from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { RuntimeHostKernel, type RuntimeHostCompositionFactory } from '../server/host-kernel.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

/**
 * The model-facing text the Host actually hands to the backend for the Turn.
 * Kept outside FakeBackend so the assertion covers the production composition
 * rather than the test backend's own behaviour.
 */
class RecordingBackend extends FakeBackend {
  constructor(
    context: { sessionId: string },
    private readonly sent: string[],
  ) {
    super(context);
  }

  override async *send(input: BackendSendInput) {
    this.sent.push(input.text);
    yield* super.send(input);
  }
}

test('the production Host sends the approved Plan steps to the execution Turn backend', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-plan-request-e2e-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  let owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  let host: Awaited<ReturnType<typeof RuntimeHostKernel.start>> | undefined;
  let client: RuntimeHostConnection | undefined;
  try {
    const setupStores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const planStore = await openInteractivePlanStoreForWrite(owner.lease);
    const session = await setupStores.sessionStore.create({
      cwd: root,
      llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'explore',
      collaborationMode: 'plan',
    });
    const submitted = await planStore.submitProposal({
      operationId: 'submit-1',
      sessionId: session.id,
      turnId: 'turn-1',
      title: 'Ship the plan request',
      steps: [
        { id: 'inspect', title: 'Inspect the caller', description: 'Read the relevant files.' },
        { id: 'patch', title: 'Land the fix', description: 'Update the Host request.' },
      ],
    });
    assert.equal(submitted.event.type, 'plan_submitted');
    if (submitted.event.type !== 'plan_submitted') return;
    planStore.close();

    const sent: string[] = [];
    const composition: RuntimeHostCompositionFactory = (context) =>
      createExecutionRuntimeHostComposition(
        context,
        {},
        {
          primaryBackendFactory: (backendContext) => new RecordingBackend(backendContext, sent),
        },
      );
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 30_000,
      composition: defineInteractiveRuntimeHostComposition(composition),
    });
    owner = undefined;
    client = await connect(root);

    const started = await client.request('plan.turn.start', {
      kind: 'approve_proposal',
      sessionId: session.id,
      proposalId: submitted.event.proposal.proposalId,
      expectedRevision: submitted.event.proposal.revision,
      expectedStoreVersion: submitted.state.storeVersion,
      turnId: 'approve-turn',
    });
    assert.equal(started.plan.eventType, 'plan_approved');
    const executionId = started.plan.executionId;
    assert.ok(executionId);
    await waitForTerminal(client, started.turn);

    const request = sent[0];
    assert.ok(request, 'the execution Turn never reached a backend');
    assert.match(request, new RegExp(`^Execute the approved plan execution ${executionId}\\.\n`));
    assert.match(request, /^Plan: Ship the plan request \(revision 1\)$/m);
    assert.match(request, /^- inspect \[pending\] Inspect the caller$/m);
    assert.match(request, /^- patch \[pending\] Land the fix$/m);
    assert.match(request, /update_plan/);
    assert.match(request, /cancel_plan/);
  } finally {
    await client?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    await owner?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

async function connect(rootPath: string): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({ rootPath, protocol: PROTOCOL });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Unable to connect to Runtime Host');
  return result.connection;
}

async function waitForTerminal(
  connection: RuntimeHostConnection,
  initial: OperationOutput<'plan.turn.start'>['turn'],
): Promise<void> {
  let snapshot = initial;
  await waitFor(
    async () => {
      if (
        snapshot.status === 'completed' ||
        snapshot.status === 'failed' ||
        snapshot.status === 'cancelled'
      ) {
        return true;
      }
      snapshot = await connection.request('turn.query', {
        sessionId: snapshot.sessionId,
        turnId: snapshot.turnId,
      });
      return (
        snapshot.status === 'completed' ||
        snapshot.status === 'failed' ||
        snapshot.status === 'cancelled'
      );
    },
    { timeoutMs: 5_000, pollMs: 10, message: 'Plan execution Turn did not settle' },
  );
}
