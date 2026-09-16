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
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { SandboxBoundaryRequest } from '@maka/core/sandbox-boundary';
import type {
  FormRequestEvent,
  SandboxBoundaryRequestEvent,
  UserQuestionRequestEvent,
} from '@maka/core/events';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
  type RuntimeInteractionRunIdentity,
  type RuntimeFormContinuation,
  type RuntimeSandboxBoundaryContinuation,
  type RuntimeUserQuestionContinuation,
} from '@maka/runtime/interaction-authority';
import {
  openInteractiveExecutionStoresForWrite,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import {
  type InteractiveInteractionStoreWriterFacade,
  type StoredInteractionRequest,
} from '@maka/storage/interaction-store';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import {
  ClientCapabilityApprovalClosedError,
  HostInteractionCoordinator,
  type HostInteractionCoordinatorOptions,
} from '../server/interaction-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const RUN = Object.freeze({
  sessionId: 'session_1',
  turnId: 'turn_1',
  runId: 'run_1',
});

describe('HostInteractionCoordinator', () => {
  test('Host-owned forms reuse durable answers and concurrent requests without rebinding the Run', async () => {
    await withStore(async ({ store }) => {
      const published = deferred();
      const coordinator = createCoordinator(store, {
        refreshCanonicalContinuity: async () => {
          published.resolve();
        },
      });
      const owner = coordinator.bindRun(RUN);
      const input = {
        ...RUN,
        requestId: 'host-choice',
        create: async () => ({
          kind: 'form' as const,
          toolUseId: 'select-tool',
          message: 'Choose work',
          requester: { name: 'WorkHub' },
          fields: [
            {
              kind: 'single_select' as const,
              name: 'target',
              label: 'Work',
              required: true,
              options: [
                { value: 'opaque-a', label: 'Same name / alpha' },
                { value: 'opaque-b', label: 'Same name / beta' },
              ],
            },
          ],
        }),
      };
      const first = coordinator.requestForm(input);
      const second = coordinator.requestForm(input);
      await published.promise;
      const invalid = await coordinator.handlers['interaction.answer'](
        {
          sessionId: RUN.sessionId,
          interactionId: input.requestId,
          answer: { kind: 'form', action: 'accept', values: { target: 'forged' } },
        },
        connection(),
      );
      assert.equal(invalid.ok, false);
      assert.equal((await store.listPending(RUN)).length, 1);
      const answered = await coordinator.handlers['interaction.answer'](
        {
          sessionId: RUN.sessionId,
          interactionId: input.requestId,
          answer: { kind: 'form', action: 'accept', values: { target: 'opaque-b' } },
        },
        connection(),
      );
      assert.equal(answered.ok, true);
      const result = await first;
      assert.deepEqual(result.answer, { action: 'accept', values: { target: 'opaque-b' } });
      assert.deepEqual(await second, result);
      assert.deepEqual(
        await coordinator.requestForm({
          ...input,
          create: async () => {
            throw new Error('Must reuse offer');
          },
        }),
        result,
      );
      assert.equal(coordinator.isPoisoned(), false);
      await owner.close('turn_terminal');
      owner.release();
      await coordinator.close();
    });
  });

  test('a rejected Host form admission settles every concurrent caller without poisoning', async () => {
    await withStore(async ({ store }) => {
      const coordinator = createCoordinator(store, { preflightSessionSnapshot: () => false });
      const owner = coordinator.bindRun(RUN);
      const input = {
        ...RUN,
        requestId: 'oversized-host-form',
        create: async () => ({
          kind: 'form' as const,
          toolUseId: 'select-tool',
          message: 'Choose work',
          requester: { name: 'WorkHub' },
          fields: [
            {
              kind: 'single_select' as const,
              name: 'target',
              label: 'Work',
              required: true,
              options: [{ value: 'a', label: 'A' }],
            },
          ],
        }),
      };
      const outcomes = await Promise.allSettled([
        coordinator.requestForm(input),
        coordinator.requestForm(input),
      ]);
      assert.deepEqual(
        outcomes.map((outcome) => outcome.status),
        ['rejected', 'rejected'],
      );
      assert.equal(coordinator.isPoisoned(), false);
      assert.equal((await store.listPending(RUN)).length, 0);
      await owner.close('turn_terminal');
      owner.release();
      await coordinator.close();
    });
  });

  test('stopping the owning Run cancels its Host-owned form and closes the durable offer', async () => {
    await withStore(async ({ store }) => {
      const published = deferred();
      const coordinator = createCoordinator(store, {
        refreshCanonicalContinuity: async () => {
          published.resolve();
        },
      });
      const owner = coordinator.bindRun(RUN);
      const pending = coordinator.requestForm({
        ...RUN,
        requestId: 'stopped-choice',
        create: async () => ({
          kind: 'form',
          toolUseId: 'select-tool',
          message: 'Choose work',
          requester: { name: 'WorkHub' },
          fields: [
            {
              kind: 'single_select',
              name: 'target',
              label: 'Work',
              required: true,
              options: [{ value: 'a', label: 'A' }],
            },
          ],
        }),
      });
      await published.promise;
      await owner.close('turn_stopped');
      assert.deepEqual((await pending).answer, { action: 'cancel' });
      assert.equal(
        (await store.readInteraction('stopped-choice'))?.outcome?.outcome.kind,
        'closure',
      );
      owner.release();
      await coordinator.close();
    });
  });

  test('admits a durable question before continuity and returns one canonical answer to concurrent clients', async () => {
    await withStore(async ({ store }) => {
      const order: string[] = [];
      const continuation = questionContinuation('question_1', {
        answer: (answers) => order.push(`apply:${answers.join(',')}`),
      });
      const coordinator = createCoordinator(store, {
        preflightSessionSnapshot: async (_sessionId, projection) => {
          order.push('preflight');
          assert.equal(projection.pending.length, 1);
          assert.equal(await store.readInteraction('question_1'), undefined);
          return true;
        },
        refreshCanonicalContinuity: async () => {
          const record = await store.readInteraction('question_1');
          order.push(record?.outcome ? 'refresh:answered' : 'refresh:pending');
        },
      });
      const owner = coordinator.bindRun(RUN);

      await owner.acceptUserQuestionRequest({
        request: questionEvent('question_1', 10),
        continuation,
      });
      assert.deepEqual(order, ['preflight', 'refresh:pending']);
      assert.equal(await coordinator.hasPendingSession(RUN.sessionId), true);

      const answer = {
        sessionId: RUN.sessionId,
        interactionId: 'question_1',
        answer: { kind: 'question', answers: ['Yes'] },
      } as const;
      const [first, second] = await Promise.all([
        coordinator.handlers['interaction.answer'](answer, connection()),
        coordinator.handlers['interaction.answer'](answer, connection()),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.deepEqual(order, ['preflight', 'refresh:pending', 'refresh:answered', 'apply:Yes']);
      assert.equal(await coordinator.hasPendingSession(RUN.sessionId), false);

      const conflicting = await coordinator.handlers['interaction.answer'](
        {
          sessionId: RUN.sessionId,
          interactionId: 'question_1',
          answer: { kind: 'question', answers: ['No'] },
        },
        connection(),
      );
      assert.equal(conflicting.ok, false);
      if (!conflicting.ok) assert.equal(conflicting.error.code, 'already_resolved');

      await owner.close('turn_terminal');
      owner.release();
      await coordinator.close();
    });
  });

  test('closes a pending Client Capability approval when its provider disconnects', async () => {
    await withStore(async ({ store }) => {
      const coordinator = createCoordinator(store);
      const owner = coordinator.bindRun(RUN);
      const provider = new AbortController();
      const approval = coordinator.requestClientCapabilityApproval({
        ...RUN,
        toolCallId: 'browser-call-disconnected',
        providerSignal: provider.signal,
        target: {
          providerId: 'provider-1',
          contractId: 'contract-1',
          serverId: 'desktop_browser',
          toolName: 'browser_snapshot',
          capability: 'browser',
          scope: { kind: 'browser_origin', origin: 'https://example.com' },
        },
      });
      let pending = await store.listSessionPending(RUN.sessionId);
      while (pending.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        pending = await store.listSessionPending(RUN.sessionId);
      }

      provider.abort();
      await assert.rejects(
        approval,
        (error: unknown) =>
          error instanceof ClientCapabilityApprovalClosedError &&
          error.reason === 'provider_disconnected',
      );
      const record = await store.readInteraction(pending[0]?.requestId ?? 'missing');
      assert.equal(record?.outcome?.outcome.kind, 'closure');
      if (record?.outcome?.outcome.kind === 'closure') {
        assert.equal(record.outcome.outcome.reason, 'provider_disconnected');
      }

      await owner.close('turn_terminal');
      owner.release();
      await coordinator.close();
    });
  });

  test('validates and commits one canonical form answer before resuming its exact continuation', async () => {
    await withStore(async ({ store }) => {
      const order: string[] = [];
      const coordinator = createCoordinator(store, {
        refreshCanonicalContinuity: async () => {
          const record = await store.readInteraction('form_1');
          order.push(record?.outcome ? 'refresh:answered' : 'refresh:pending');
        },
      });
      const owner = coordinator.bindRun(RUN);
      assert.ok(owner.acceptFormRequest);
      await owner.acceptFormRequest({
        request: formEvent('form_1', 10),
        continuation: formContinuation('form_1', {
          answer: (answer) => order.push(`apply:${answer.action}`),
        }),
      });
      assert.deepEqual(order, ['refresh:pending']);

      const invalid = await coordinator.handlers['interaction.answer'](
        {
          sessionId: RUN.sessionId,
          interactionId: 'form_1',
          answer: { kind: 'form', action: 'accept', values: { replicas: 0 } },
        },
        connection(),
      );
      assert.equal(invalid.ok, false);
      if (!invalid.ok) assert.equal(invalid.error.code, 'operation_conflict');
      assert.deepEqual(order, ['refresh:pending']);

      const answer = {
        sessionId: RUN.sessionId,
        interactionId: 'form_1',
        answer: {
          kind: 'form',
          action: 'accept',
          values: { replicas: 3, regions: ['us', 'eu'] },
        },
      } as const;
      const [first, second] = await Promise.all([
        coordinator.handlers['interaction.answer'](answer, connection()),
        coordinator.handlers['interaction.answer'](answer, connection()),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.deepEqual(order, ['refresh:pending', 'refresh:answered', 'apply:accept']);
      const record = await store.readInteraction('form_1');
      assert.deepEqual(record?.outcome?.outcome, {
        kind: 'form_answer',
        action: 'accept',
        values: { replicas: 3, regions: ['us', 'eu'] },
        committedAt: 101,
      });

      const closures: string[] = [];
      await owner.acceptFormRequest({
        request: formEvent('form_2', 11),
        continuation: formContinuation('form_2', {
          closure: (reason) => closures.push(reason),
        }),
      });
      await owner.withdrawFormRequest('form_2');
      assert.deepEqual(closures, ['producer_cancelled']);
      assert.deepEqual((await store.readInteraction('form_2'))?.outcome?.outcome, {
        kind: 'closure',
        reason: 'producer_cancelled',
        committedAt: 102,
      });

      await owner.acceptFormRequest({
        request: formEvent('form_3', 12),
        continuation: formContinuation('form_3', {
          closure: (reason) => closures.push(reason),
        }),
      });
      await owner.close('turn_terminal');
      assert.deepEqual(closures, ['producer_cancelled', 'turn_terminal']);
      assert.deepEqual((await store.readInteraction('form_3'))?.outcome?.outcome, {
        kind: 'closure',
        reason: 'turn_terminal',
        committedAt: 103,
      });
      owner.release();
      await coordinator.close();
    });
  });

  test('does not expose settled interactions after Session removal', async () => {
    await withStore(async ({ store }) => {
      let sessionState: 'present' | 'removed' = 'present';
      const coordinator = createCoordinator(store, {
        sessions: {
          probeSessionRemoval: async () => ({ kind: sessionState }),
        },
      });
      const owner = coordinator.bindRun(RUN);
      await owner.acceptUserQuestionRequest({
        request: questionEvent('question_removed_session', 10),
        continuation: questionContinuation('question_removed_session'),
      });
      const answer = {
        sessionId: RUN.sessionId,
        interactionId: 'question_removed_session',
        answer: { kind: 'question', answers: ['Yes'] },
      } as const;
      assert.equal(
        (await coordinator.handlers['interaction.answer'](answer, connection())).ok,
        true,
      );

      sessionState = 'removed';
      assert.deepEqual(
        await coordinator.handlers['interaction.query'](
          { sessionId: RUN.sessionId, interactionId: answer.interactionId },
          connection(),
        ),
        {
          ok: false,
          error: { code: 'not_found', message: 'Interaction was not found' },
        },
      );
      assert.deepEqual(await coordinator.handlers['interaction.answer'](answer, connection()), {
        ok: false,
        error: { code: 'not_found', message: 'Interaction was not found' },
      });

      await owner.close('turn_terminal');
      owner.release();
      await coordinator.close();
    });
  });

  test('retains the exact live continuation and poisons when async apply rejects', async () => {
    await withStore(async ({ store }) => {
      const poison: RuntimeInteractionFailStopError[] = [];
      let applyCount = 0;
      const coordinator = createCoordinator(store, {
        onPoison: (error) => poison.push(error),
      });
      const owner = coordinator.bindRun(RUN);
      await owner.acceptUserQuestionRequest({
        request: questionEvent('question_rejected_apply', 10),
        continuation: questionContinuation('question_rejected_apply', {
          answer: async () => {
            applyCount += 1;
            throw new Error('local waiter rejected');
          },
        }),
      });

      await assert.rejects(
        coordinator.handlers['interaction.answer'](
          {
            sessionId: RUN.sessionId,
            interactionId: 'question_rejected_apply',
            answer: { kind: 'question', answers: ['Yes'] },
          },
          connection(),
        ),
        RuntimeInteractionFailStopError,
      );
      const record = await store.readInteraction('question_rejected_apply');
      assert.equal(record?.outcome?.outcome.kind, 'question_answer');
      assert.equal(applyCount, 1);
      assert.equal(coordinator.isPoisoned(), true);
      assert.equal(poison.length, 1);
      await assert.rejects(owner.close('turn_terminal'), poison[0]);
      await assert.rejects(coordinator.close(), poison[0]);
    });
  });

  test('drain permits only an exact Run preclaimed by its stop closure to bind', async () => {
    await withStore(async ({ store }) => {
      const gate = new SessionAdmissionGate();
      const coordinator = createCoordinator(store, { sessionAdmission: gate });
      coordinator.beginDrain();

      await gate.run(RUN.sessionId, (admission) =>
        coordinator.claimRunClosure(RUN, 'turn_stopped', admission),
      );
      const owner = coordinator.bindRun(RUN);
      await assert.rejects(
        Promise.resolve().then(() =>
          coordinator.bindRun({
            sessionId: RUN.sessionId,
            turnId: 'turn_unclaimed',
            runId: 'run_unclaimed',
          }),
        ),
        (error: unknown) =>
          error instanceof RuntimeInteractionAdmissionRejectedError &&
          error.reason === 'authority_draining',
      );

      await owner.close('turn_stopped');
      owner.release();
      await coordinator.close();
    });
  });

  test('close reaps a settled unbound closure-only Run without poisoning', async () => {
    await withStore(async ({ store }) => {
      const poison: RuntimeInteractionFailStopError[] = [];
      const gate = new SessionAdmissionGate();
      const coordinator = createCoordinator(store, {
        sessionAdmission: gate,
        onPoison: (error) => poison.push(error),
      });
      coordinator.beginDrain();

      await gate.run(RUN.sessionId, (admission) =>
        coordinator.claimRunClosure(RUN, 'turn_stopped', admission),
      );
      await coordinator.close();

      assert.equal(coordinator.isPoisoned(), false);
      assert.deepEqual(poison, []);
      assert.deepEqual(await store.listPending(RUN), []);
    });
  });

  test('terminal fence reaps an exact settled unbound closure-only Run', async () => {
    await withStore(async ({ store }) => {
      const poison: RuntimeInteractionFailStopError[] = [];
      const gate = new SessionAdmissionGate();
      const coordinator = createCoordinator(store, {
        sessionAdmission: gate,
        onPoison: (error) => poison.push(error),
      });
      coordinator.beginDrain();

      await gate.run(RUN.sessionId, (admission) =>
        coordinator.claimRunClosure(RUN, 'turn_stopped', admission),
      );
      await gate.run(RUN.sessionId, (admission) => coordinator.assertTerminalFence(RUN, admission));

      assert.equal(coordinator.isPoisoned(), false);
      assert.deepEqual(poison, []);
      assert.deepEqual(await store.listPending(RUN), []);
      await coordinator.close();
    });
  });

  test('close fails closed while an unbound closure claim is unsettled', async () => {
    await withStore(async ({ store }) => {
      const poison: RuntimeInteractionFailStopError[] = [];
      const refreshStarted = deferred();
      const releaseRefresh = deferred();
      const gate = new SessionAdmissionGate();
      const coordinator = createCoordinator(store, {
        sessionAdmission: gate,
        refreshCanonicalContinuity: async () => {
          refreshStarted.resolve();
          await releaseRefresh.promise;
        },
        onPoison: (error) => poison.push(error),
      });
      coordinator.beginDrain();

      const claim = gate.run(RUN.sessionId, (admission) =>
        coordinator.claimRunClosure(RUN, 'turn_stopped', admission),
      );
      await refreshStarted.promise;
      await assert.rejects(coordinator.close(), RuntimeInteractionFailStopError);
      assert.equal(coordinator.isPoisoned(), true);
      assert.equal(poison.length, 1);

      releaseRefresh.resolve();
      await assert.rejects(claim, poison[0]);
    });
  });

  test('terminal fence poisons on an exact Run pending record from the authentic Store', async () => {
    await withStore(async ({ store }) => {
      const poison: RuntimeInteractionFailStopError[] = [];
      const gate = new SessionAdmissionGate();
      const coordinator = createCoordinator(store, {
        sessionAdmission: gate,
        onPoison: (error) => poison.push(error),
      });
      const owner = coordinator.bindRun(RUN);
      await owner.close('turn_terminal');
      owner.release();

      const orphan = storedQuestion('question_fence', RUN, 30);
      assert.equal((await store.establishRequest(orphan)).status, 'stable');
      await assert.rejects(
        gate.run(RUN.sessionId, (admission) => coordinator.assertTerminalFence(RUN, admission)),
        RuntimeInteractionFailStopError,
      );
      assert.equal(coordinator.isPoisoned(), true);
      assert.equal(poison.length, 1);
      await assert.rejects(coordinator.close(), poison[0]);
      assert.deepEqual(await store.listPending(RUN), [orphan]);
    });
  });
});

function createCoordinator(
  store: InteractiveInteractionStoreWriterFacade,
  overrides: Partial<HostInteractionCoordinatorOptions> = {},
): HostInteractionCoordinator {
  let now = 100;
  return new HostInteractionCoordinator({
    store,
    sandboxBoundaries: {
      readSandboxBoundaryRequest: async () => undefined,
      listPendingSandboxBoundaryRequests: async () => [],
      settleSandboxBoundaryRequest: async () => {
        throw new Error('Unexpected sandbox boundary settlement');
      },
      listHeaders: async () => [],
    },
    sessionAdmission: new SessionAdmissionGate(),
    sessions: {
      probeSessionRemoval: async () => ({ kind: 'present' }),
    },
    now: () => ++now,
    preflightSessionSnapshot: () => true,
    refreshCanonicalContinuity: async () => {},
    onPoison: () => {},
    resolveSandboxBoundaryRootSession: async () => undefined,
    onSandboxBoundaryGraphWake: async () => {},
    ...overrides,
  });
}

function questionEvent(requestId: string, ts: number): UserQuestionRequestEvent {
  return {
    id: `event_${requestId}`,
    type: 'user_question_request',
    turnId: RUN.turnId,
    ts,
    requestId,
    toolUseId: `tool_${requestId}`,
    questions: [
      {
        question: 'Continue?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ],
  };
}

function formEvent(requestId: string, ts: number): FormRequestEvent {
  return {
    id: `event_${requestId}`,
    type: 'form_request',
    turnId: RUN.turnId,
    ts,
    requestId,
    toolUseId: `tool_${requestId}`,
    message: 'Choose deployment settings',
    requester: { name: 'deploy', source: 'Synthetic provider' },
    fields: [
      {
        kind: 'integer',
        name: 'replicas',
        label: 'Replicas',
        required: true,
        minimum: 1,
        maximum: 10,
      },
      {
        kind: 'multi_select',
        name: 'regions',
        label: 'Regions',
        required: false,
        options: [
          { value: 'us', label: 'US' },
          { value: 'eu', label: 'EU' },
        ],
      },
    ],
  };
}

function formContinuation(
  requestId: string,
  callbacks: {
    answer?: (answer: Parameters<RuntimeFormContinuation['applyAnswer']>[0]) => unknown;
    closure?: (reason: Parameters<RuntimeFormContinuation['applyClosure']>[0]) => unknown;
  } = {},
): RuntimeFormContinuation {
  return {
    ...RUN,
    requestId,
    waitForPublication: async () => {},
    applyAnswer: async (answer) => {
      await callbacks.answer?.(answer);
    },
    applyClosure: async (reason) => {
      await callbacks.closure?.(reason);
    },
  };
}

function questionContinuation(
  requestId: string,
  callbacks: {
    answer?: (answers: readonly (string | null)[]) => unknown;
    closure?: (reason: Parameters<RuntimeUserQuestionContinuation['applyClosure']>[0]) => unknown;
  } = {},
): RuntimeUserQuestionContinuation {
  return {
    ...RUN,
    requestId,
    waitForPublication: async () => {},
    applyAnswer: async (answer) => {
      await callbacks.answer?.(answer.answers);
    },
    applyClosure: async (reason) => {
      await callbacks.closure?.(reason);
    },
  };
}

function sandboxBoundaryEvent(request: SandboxBoundaryRequest): SandboxBoundaryRequestEvent {
  assert.ok(request.turnId);
  return {
    id: `event_${request.requestId}`,
    type: 'sandbox_boundary_request',
    turnId: request.turnId,
    ts: request.createdAt,
    requestId: request.requestId,
    toolUseId: `tool_${request.requestId}`,
    expansion: request.expansion,
    justification: request.justification,
  };
}

function sandboxBoundaryContinuation(
  identity: RuntimeInteractionRunIdentity,
  requestId: string,
  callbacks: {
    decision?: (status: string) => unknown;
    closure?: (
      reason: Parameters<RuntimeSandboxBoundaryContinuation['applyClosure']>[0],
    ) => unknown;
  } = {},
): RuntimeSandboxBoundaryContinuation {
  return {
    ...identity,
    requestId,
    waitForPublication: async () => {},
    applyDecision: async (settlement) => {
      await callbacks.decision?.(settlement.request.status);
    },
    applyClosure: async (reason) => {
      await callbacks.closure?.(reason);
    },
  };
}

function storedQuestion(
  requestId: string,
  identity: RuntimeInteractionRunIdentity,
  createdAt: number,
): StoredInteractionRequest {
  return {
    ...identity,
    requestId,
    createdAt,
    request: {
      kind: 'question',
      toolUseId: `tool_${requestId}`,
      questions: [
        {
          question: 'Continue?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    },
  };
}

function connection(): ConnectionContext {
  return {
    hostEpoch: 'host_epoch_1',
    connectionId: 'connection_1',
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => {} }),
  };
}

interface StoreContext {
  readonly owner: InteractiveRootOwner;
  readonly store: InteractiveInteractionStoreWriterFacade;
  readonly stores: ExecutionStoresWriter<'interactive'>;
}

async function withStore(run: (context: StoreContext) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-interaction-coordinator-'));
  const root = join(base, 'root');
  await mkdir(root);
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const store = stores.interactionStore;
  try {
    await run({ owner, store, stores });
  } finally {
    if (!owner.closed) await owner.close();
    await rm(owner.controlDirectory, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
}
