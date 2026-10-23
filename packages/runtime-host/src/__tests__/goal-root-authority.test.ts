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

import { decodeAnyEventWaitRecord, type AnyEventWaitRecord } from '@maka/core/event-wait';
import { HostEventWaitObserver } from '../server/event-wait-manager.js';
import { interactiveEventWaitObservationStore } from '../server/event-wait-observation-store.js';
import { HostInvocationEventWaitCoordinator } from '../server/invocation-event-waits.js';
import { ShellRunEventWaitAccess } from '../server/shell-run-event-wait-access.js';
import { ShellRunEventWaitAdapter } from '../server/shell-run-event-wait-adapter.js';
import { openInteractiveShellRunStoreForWrite } from '@maka/storage/shell-run-authority';
import type { SubscriptionFrame } from '../protocol/index.js';

import { readLogicalRuntimeExecution } from '@maka/core/runtime-logical-execution';

import { createMemoryExecutionPersistenceProvider } from '@maka/storage/test-only/memory-execution-persistence';
import type { ExecutionPersistenceProvider } from '@maka/storage/execution-persistence-provider';
import type { RootTurnAdmission } from '@maka/storage/agent-run-store';

import { deferred } from '@maka/core/test-only/async-primitives';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { AiSdkBackend } from '@maka/runtime/ai-sdk-backend';

import { createExternalExecutionBoundary } from '@maka/core/sandbox-boundary';
import { EventWaitAdapterRegistry } from '../server/event-wait-adapter.js';
import type { HostEventWaitSources } from '../server/event-wait-sources.js';
import { waitFor } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { once } from 'node:events';

import { mkdtemp, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  runtimeInvocationOutcome,
  type RuntimeInvocationRecord,
} from '@maka/core/runtime-invocation';
import { runtimeInvocationFailureClass } from '@maka/runtime/runtime-event-read-model';
import { seedInvocation } from '@maka/runtime/test-only/invocation-fixture';
import { BackendRegistry, SessionManager } from '@maka/runtime/session-manager';
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import { GOAL_SET_TOOL_NAME } from '@maka/runtime/goal-tools';
import { goalCheckpoint } from '@maka/runtime/goal-state';
import { type RuntimeHostedRootAuthority } from '@maka/runtime/message-authority';
import {
  openInteractiveExecutionStoresForWrite,
  type InteractiveExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import {
  openInteractiveGoalAuthorityForWrite,
  type InteractiveGoalAuthorityWriter,
} from '@maka/storage/goal-authority';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import { HostCanonicalPermissionOutcomeReader } from '../server/canonical-permission-outcome-reader.js';
import { CanonicalSessionProjectionReader } from '../server/canonical-session-projection.js';
import type { RuntimeHostResidency } from '../server/host-kernel.js';
import { HostInteractionCoordinator } from '../server/interaction-coordinator.js';
import { HostGoalCoordinator } from '../server/goal-coordinator.js';
import { HostGoalExecutionCoordinator } from '../server/goal-execution-coordinator.js';
import { executeHostedExecutionToSettlement } from '../server/hosted-execution-wait.js';
import { type HostMessageRootPort, HostMessageCoordinator } from '../server/message-coordinator.js';
import { RootAdmissionOwner } from '../server/root-admission-owner.js';
import { RootTurnCoordinator } from '../server/root-turn-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { SessionContinuityCoordinator } from '../server/session-continuity-coordinator.js';
import { readLedgerMessages } from './fixtures/ledger-transcript.js';

test('Goal continuation uses the canonical root admission and durable origin', {
  timeout: 10_000,
}, async () => {
  const fixture = await createFixture();
  try {
    assert.equal(
      fixture.goal.tools.some((tool) => tool.name === 'WaitForEvent'),
      false,
    );
    const created = fixture.goal.manager.create(fixture.sessionId, 'Finish the whole slice').goal;
    const controlLease = fixture.goal.manager.getControlLease(fixture.sessionId);
    assert.ok(controlLease);
    if (!controlLease) return;
    const admission = fixture.goalExecutions.admitTurn(
      fixture.sessionId,
      'Continue the Goal',
      goalCheckpoint(created),
      controlLease,
    );
    assert.equal(admission.kind, 'prepared');
    if (admission.kind !== 'prepared') return;
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), { kind: 'reserved' });
    const competingMessage = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: 'goal-root-epoch',
        sessionId: fixture.sessionId,
        messageId: 'competing-message',
        content: { text: 'Do not overtake the Goal reservation' },
        placement: 'current_turn',
      },
      operationContext(),
    );
    assert.equal(competingMessage.ok, false);
    if (!competingMessage.ok) assert.equal(competingMessage.error.code, 'session_busy');

    const outcome = await admission.start();
    assert.deepEqual(outcome, { kind: 'completed', turnId: admission.turnId });
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), { kind: 'idle' });

    const durableAdmission = await fixture.stores.agentRunStore.readRootTurnAdmission(
      fixture.sessionId,
      admission.turnId,
    );
    assert.deepEqual(durableAdmission?.execution, { kind: 'goal', goalId: created.id });
    assert.ok(durableAdmission);
    if (!durableAdmission) return;
    const run = await readInvocation(fixture, durableAdmission.runId);
    assert.deepEqual(run?.opening.root, { kind: 'goal', goalId: created.id });
    const user = (
      await readLedgerMessages(fixture.stores.runtimeEventStore, fixture.sessionId)
    ).find((message) => message.type === 'user' && message.turnId === admission.turnId);
    assert.deepEqual(user?.type === 'user' ? user.origin : undefined, {
      kind: 'goal',
      goalId: created.id,
    });
    assert.equal(fixture.drainRequested(), false);
  } finally {
    await fixture.close();
  }
});

test('queued Goal control revokes a prepared root before durable admission', async () => {
  const fixture = await createFixture();
  try {
    const created = fixture.goal.manager.create(fixture.sessionId, 'Do not run after clear').goal;
    const controlLease = fixture.goal.manager.getControlLease(fixture.sessionId);
    assert.ok(controlLease);
    if (!controlLease) return;
    const admission = fixture.goalExecutions.admitTurn(
      fixture.sessionId,
      'This stale continuation must never run',
      goalCheckpoint(created),
      controlLease,
    );
    assert.equal(admission.kind, 'prepared');
    if (admission.kind !== 'prepared') return;

    const entered = deferred();
    const release = deferred();
    const held = fixture.sessionAdmission.run(fixture.sessionId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const clearing = fixture.goal.handlers['goal.control'](
      {
        sessionId: fixture.sessionId,
        goalId: created.id,
        expectedRevision: created.revision,
        action: 'clear',
      },
      operationContext(),
    );
    const outcome = admission.start();
    release.resolve();
    await held;

    const cleared = await clearing;
    assert.equal(cleared.ok && cleared.result.goal.status, 'cleared');
    assert.deepEqual(await outcome, {
      kind: 'errored',
      turnId: admission.turnId,
      reason: 'Goal continuation is unavailable for this Session.',
    });
    assert.equal(
      await fixture.stores.agentRunStore.readRootTurnAdmission(fixture.sessionId, admission.turnId),
      undefined,
    );
    assert.equal(
      (await fixture.stores.runtimeEventStore.listSessionInvocations(fixture.sessionId)).some(
        (run) => run.opening.root.kind === 'goal' && run.opening.root.goalId === created.id,
      ),
      false,
    );
    assert.equal(
      (await readLedgerMessages(fixture.stores.runtimeEventStore, fixture.sessionId)).some(
        (message) => message.type === 'user' && message.turnId === admission.turnId,
      ),
      false,
    );
  } finally {
    await fixture.close();
  }
});

test('Goal continuation cannot overtake a pending ScheduledTask admission', async () => {
  const fixture = await createFixture();
  const admissionEntered = deferred();
  const releaseAdmission = deferred();
  try {
    const scheduledTaskTurnId = randomUUID();
    const scheduledTaskRunId = randomUUID();
    const scheduledTaskId = 'scheduled-task-reservation';
    const scheduledTask = executeHostedExecutionToSettlement(fixture.coordinator, {
      sessionId: fixture.sessionId,
      turnId: scheduledTaskTurnId,
      runId: scheduledTaskRunId,
      userMessageId: randomUUID(),
      execution: { kind: 'scheduled_task', scheduledTaskId },
      content: { text: 'Hold the shared root reservation.' },
      admitExecution: async () => {
        admissionEntered.resolve();
        await releaseAdmission.promise;
        return 'executing';
      },
      start: ({ runId, userMessageId, onRunStarted }) =>
        fixture.manager.sendMessage(
          fixture.sessionId,
          {
            turnId: scheduledTaskTurnId,
            text: 'Hold the shared root reservation.',
            origin: { kind: 'scheduled_task', scheduledTaskId },
          },
          {
            runId,
            userMessageId: userMessageId ?? undefined,
            durability: 'required',
            onRunStarted,
          },
        ),
    });
    await admissionEntered.promise;

    const overtakingGoal = fixture.goalExecutions.admitTurn(
      fixture.sessionId,
      'Do not overtake the ScheduledTask admission.',
      { goalId: 'goal-pending', revision: 1 },
      { goalId: 'goal-pending', generation: 0 },
    );
    assert.equal(overtakingGoal.kind, 'busy');
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), { kind: 'reserved' });

    releaseAdmission.resolve();
    await scheduledTask;
    if (overtakingGoal.kind === 'busy') await overtakingGoal.whenIdle;

    const goal = fixture.goal.manager.create(fixture.sessionId, 'Run after ScheduledTask').goal;
    const controlLease = fixture.goal.manager.getControlLease(fixture.sessionId);
    assert.ok(controlLease);
    if (!controlLease) return;
    const goalAdmission = fixture.goalExecutions.admitTurn(
      fixture.sessionId,
      'Continue after ScheduledTask.',
      goalCheckpoint(goal),
      controlLease,
    );
    assert.equal(goalAdmission.kind, 'prepared');
    if (goalAdmission.kind !== 'prepared') return;
    assert.deepEqual(await goalAdmission.start(), {
      kind: 'completed',
      turnId: goalAdmission.turnId,
    });

    const durableGoal = await fixture.stores.agentRunStore.readRootTurnAdmission(
      fixture.sessionId,
      goalAdmission.turnId,
    );
    assert.equal(durableGoal?.previousRootTurnId, scheduledTaskTurnId);
    assert.equal(fixture.drainRequested(), false);
  } finally {
    releaseAdmission.resolve();
    await fixture.close();
  }
});

test('drain revokes pending ScheduledTask before durable root admission', async () => {
  const fixture = await createFixture();
  const admissionEntered = deferred();
  const releaseAdmission = deferred();
  const turnId = randomUUID();
  const runId = randomUUID();
  try {
    const scheduledTask = executeHostedExecutionToSettlement(fixture.coordinator, {
      sessionId: fixture.sessionId,
      turnId,
      runId,
      userMessageId: randomUUID(),
      execution: { kind: 'scheduled_task', scheduledTaskId: 'draining-scheduled-task' },
      content: { text: 'Do not admit after drain.' },
      admitExecution: async () => {
        admissionEntered.resolve();
        await releaseAdmission.promise;
        return 'executing';
      },
      start: ({ runId: admittedRunId, userMessageId, onRunStarted }) =>
        fixture.manager.sendMessage(
          fixture.sessionId,
          {
            turnId,
            text: 'Do not admit after drain.',
            origin: { kind: 'scheduled_task', scheduledTaskId: 'draining-scheduled-task' },
          },
          {
            runId: admittedRunId,
            userMessageId: userMessageId ?? undefined,
            durability: 'required',
            onRunStarted,
          },
        ),
    });
    await admissionEntered.promise;

    fixture.coordinator.beginDrain();
    releaseAdmission.resolve();

    await assert.rejects(scheduledTask, /lost its pending reservation/);
    assert.equal(
      await fixture.stores.agentRunStore.readRootTurnAdmission(fixture.sessionId, turnId),
      undefined,
    );
    assert.equal(
      (await fixture.stores.runtimeEventStore.listSessionInvocations(fixture.sessionId)).some(
        (run) => run.runId === runId,
      ),
      false,
    );
  } finally {
    releaseAdmission.resolve();
    await fixture.close();
  }
});

test('ScheduledTask turns can use Goal tools and contribute evaluation evidence', async () => {
  const fixture = await createFixture();
  try {
    const scheduledTaskId = 'scheduled-task-goal-tool';
    const turnId = randomUUID();
    const runId = randomUUID();
    const goalSet = fixture.goal.tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
    assert.ok(goalSet);
    if (!goalSet) return;

    await executeHostedExecutionToSettlement(fixture.coordinator, {
      sessionId: fixture.sessionId,
      turnId,
      runId,
      userMessageId: randomUUID(),
      execution: { kind: 'scheduled_task', scheduledTaskId },
      content: { text: 'Set and verify a Goal.' },
      start: ({ runId: admittedRunId, userMessageId, onRunStarted }) =>
        (async function* () {
          const result = await goalSet.impl(
            { condition: 'ScheduledTask Goal completes' },
            {
              sessionId: fixture.sessionId,
              runId: admittedRunId,
              turnId,
              cwd: fixture.base,
              toolCallId: 'goal-set-from-scheduled-task',
              abortSignal: new AbortController().signal,
              emitOutput: () => {},
            },
          );
          assert.equal(typeof result, 'string');
          assert.match(result as string, /Goal set/);
          yield* fixture.manager.sendMessage(
            fixture.sessionId,
            {
              turnId,
              text: 'Set and verify a Goal.',
              origin: { kind: 'scheduled_task', scheduledTaskId },
            },
            {
              runId: admittedRunId,
              userMessageId: userMessageId ?? undefined,
              durability: 'required',
              onRunStarted,
            },
          );
        })(),
    });

    const goal = await fixture.waitForGoalStatus('achieved');
    assert.equal(goal.condition, 'ScheduledTask Goal completes');
    assert.equal(goal.lastReason, 'verified');
    assert.equal(fixture.drainRequested(), false);
  } finally {
    await fixture.close();
  }
});

test('Host Goal continuation bridges its exact generation into root authority', async () => {
  const fixture = await createFixture();
  try {
    const created = fixture.goal.manager.create(fixture.sessionId, 'Bridge through the Host').goal;
    const paused = fixture.goal.manager.pause(fixture.sessionId, {
      checkpoint: goalCheckpoint(created),
    });
    assert.ok(paused);
    if (!paused) return;
    const resumed = fixture.goal.continuation.resumeFromControl(
      fixture.sessionId,
      goalCheckpoint(paused),
    );
    assert.ok(resumed);
    if (!resumed) return;

    const run = await waitForGoalRun(fixture, resumed.id);
    assert.deepEqual(run.opening.root, { kind: 'goal', goalId: resumed.id });
    const admission = await fixture.stores.agentRunStore.readRootTurnAdmission(
      fixture.sessionId,
      run.turnId,
    );
    assert.deepEqual(admission?.execution, { kind: 'goal', goalId: resumed.id });
    assert.deepEqual(admission?.sourceMessages, []);
    assert.equal(fixture.drainRequested(), false);
  } finally {
    await fixture.close();
  }
});

test('restart closes an admitted Goal without a Run instead of replaying it', async () => {
  const fixture = await createFixture({ recoverAdmissions: false });
  try {
    const turnId = randomUUID();
    const runId = randomUUID();
    await fixture.stores.agentRunStore.admitRootTurn({
      sessionId: fixture.sessionId,
      turnId,
      proposedRunId: runId,
      proposedUserMessageId: randomUUID(),
      execution: { kind: 'goal', goalId: 'goal-restart' },
      previousRootTurnId: null,
      normalizedInput: { text: 'Do not replay after restart' },
      sourceMessages: [],
      admittedAt: 1,
    });

    await fixture.coordinator.prepareRecovery();
    const run = await readInvocation(fixture, runId);
    assert.deepEqual(run?.opening.root, { kind: 'goal', goalId: 'goal-restart' });
    assert.equal(run && runtimeInvocationOutcome(run), 'failed');
    assert.equal(run && runtimeInvocationFailureClass(run), 'app_restarted');
    const user = (
      await readLedgerMessages(fixture.stores.runtimeEventStore, fixture.sessionId)
    ).find((message) => message.type === 'user' && message.turnId === turnId);
    assert.deepEqual(user?.type === 'user' ? user.origin : undefined, {
      kind: 'goal',
      goalId: 'goal-restart',
    });
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), { kind: 'idle' });
  } finally {
    await fixture.close();
  }
});

test('restart rejects an admitted Goal whose existing UserMessage lost its origin', async () => {
  const fixture = await createFixture({ recoverAdmissions: false });
  try {
    const turnId = randomUUID();
    const runId = randomUUID();
    const userMessageId = randomUUID();
    await fixture.stores.agentRunStore.admitRootTurn({
      sessionId: fixture.sessionId,
      turnId,
      proposedRunId: runId,
      proposedUserMessageId: userMessageId,
      execution: { kind: 'goal', goalId: 'goal-corrupt-origin' },
      previousRootTurnId: null,
      normalizedInput: { text: 'Preserve durable Goal provenance' },
      sourceMessages: [],
      admittedAt: 1,
    });
    const seeded = await seedInvocation(fixture.stores.runtimeEventStore, {
      sessionId: fixture.sessionId,
      turnId,
      runId,
      opening: { root: { kind: 'goal', goalId: 'goal-corrupt-origin' } },
    });
    await fixture.stores.runtimeEventStore.appendRuntimeEvent(fixture.sessionId, runId, {
      id: userMessageId,
      sessionId: fixture.sessionId,
      invocationId: seeded.invocationId,
      runId,
      turnId,
      ts: 1,
      partial: false,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'Preserve durable Goal provenance' },
    });

    await assert.rejects(
      () => fixture.coordinator.prepareRecovery(),
      /does not match its UserMessage/,
    );
  } finally {
    await fixture.close();
  }
});

test('restart rejects a Goal Run carrying delegated execution lineage', async () => {
  const fixture = await createFixture({ recoverAdmissions: false });
  try {
    const turnId = randomUUID();
    const runId = randomUUID();
    const goalId = 'goal-cross-lineage';
    await fixture.stores.agentRunStore.admitRootTurn({
      sessionId: fixture.sessionId,
      turnId,
      proposedRunId: runId,
      proposedUserMessageId: randomUUID(),
      execution: { kind: 'goal', goalId },
      previousRootTurnId: null,
      normalizedInput: { text: 'Reject ambiguous root ownership.' },
      sourceMessages: [],
      admittedAt: 1,
    });
    await seedInvocation(fixture.stores.runtimeEventStore, {
      sessionId: fixture.sessionId,
      turnId,
      runId,
      opening: {
        root: { kind: 'goal', goalId },
        lineage: { parentRunId: 'foreign-parent-run' },
      },
    });

    await assert.rejects(
      () => fixture.coordinator.prepareRecovery(),
      /changed its root execution identity/,
    );
  } finally {
    await fixture.close();
  }
});

interface Fixture {
  readonly errors: unknown[];
  readonly waitObserver?: HostEventWaitObserver;
  readonly invocationWaits?: HostInvocationEventWaitCoordinator;
  readonly owner: InteractiveRootOwner;
  readonly base: string;
  readonly stores: InteractiveExecutionStoresWriter;
  readonly goalStore: InteractiveGoalAuthorityWriter;
  readonly sessionId: string;
  readonly rootAdmissions: RootAdmissionOwner;
  readonly coordinator: RootTurnCoordinator;
  readonly goal: HostGoalCoordinator;
  readonly goalExecutions: HostGoalExecutionCoordinator;
  readonly manager: SessionManager;
  readonly messages: HostMessageCoordinator;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly continuity: SessionContinuityCoordinator;
  readonly drainRequested: () => boolean;
  waitForGoalStatus(status: GoalStatus): Promise<GoalState>;
  close(): Promise<void>;
}

type GoalState = NonNullable<ReturnType<HostGoalCoordinator['manager']['get']>>;
type GoalStatus = GoalState['status'];

async function createFixture(
  options: {
    base?: string;
    keepRoot?: boolean;
    sessionId?: string;
    recoverAdmissions?: boolean;
    persistenceProvider?: ExecutionPersistenceProvider | 'local';
    registerBackend?: (backends: BackendRegistry) => void;
    model?: MockLanguageModelV4;
    eventWaitSources?: HostEventWaitSources;
    onEventWaitChanged?: (wait: AnyEventWaitRecord) => void;
    onEvaluate?: () => unknown;
    onGoalProjection?: (goal: HostGoalCoordinator, sessionId: string) => void;
    afterRootAdmission?: (admission: RootTurnAdmission) => Promise<void>;
    beforeReadContext?: () => Promise<void>;
  } = {},
): Promise<Fixture> {
  const base = options.base ?? (await mkdtemp(join(tmpdir(), 'maka-goal-root-')));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire test root');
  const provider =
    options.persistenceProvider === 'local' ? undefined : options.persistenceProvider;
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
  const waitSources = options.eventWaitSources;
  const goalStore = await openInteractiveGoalAuthorityForWrite(owner.lease);
  const session = options.sessionId
    ? await stores.sessionStore.readHeaderSnapshot(options.sessionId)
    : await stores.sessionStore.create({
        cwd: capability.canonicalPath,
        llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
  const admission = new SessionAdmissionGate();
  const rootAdmissions = new RootAdmissionOwner(
    options.afterRootAdmission
      ? {
          ...stores.agentRunStore,
          admitRootTurn: async (input) => {
            const result = await stores.agentRunStore.admitRootTurn(input);
            await options.afterRootAdmission!(result.admission);
            return result;
          },
        }
      : stores.agentRunStore,
  );
  if (options.recoverAdmissions !== false) await rootAdmissions.recoverSession(session.id);
  const acquireResidency = (): RuntimeHostResidency => ({ release() {} });
  let coordinator: RootTurnCoordinator | undefined;
  let continuity: SessionContinuityCoordinator | undefined;
  let projection: CanonicalSessionProjectionReader | undefined;
  let goal: HostGoalCoordinator | undefined;
  const errors: unknown[] = [];
  let requestedDrain = false;
  let invocationWaits: HostInvocationEventWaitCoordinator | undefined;
  const eventWaitsChanged = (sessionId: string) => {
    requireContinuity(continuity).enqueueCanonicalRefresh(sessionId);
    requireContinuity(continuity).enqueueSessionDomainChanged(sessionId, 'event_wait');
  };
  const waitObserver = waitSources
    ? new HostEventWaitObserver({
        store: interactiveEventWaitObservationStore(stores.eventWaitStore),
        decodeRecord: decodeAnyEventWaitRecord,
        adapters: waitSources.adapters,
        authorize: async (wait, signal) => {
          if (wait.schemaVersion !== 2) return { kind: 'revoked', reason: 'unsupported_consumer' };
          if (wait.consumer.kind === 'tool_invocation')
            return invocationWaits!.authorizeObservation(wait, signal);
          return requireGoal(goal).goalWaitingBridge!.authorizeObservation(wait, signal);
        },
        onChanged: (wait) => {
          invocationWaits?.changed(wait);
          if (wait.schemaVersion === 2 && wait.consumer.kind === 'goal_waiting')
            void goal?.goalWaitingBridge?.reconcile();
          eventWaitsChanged(wait.sessionId);
          options.onEventWaitChanged?.(wait);
        },
        onError: (error) => {
          errors.push(error);
          requestedDrain = true;
        },
        ...(waitSources.clock ? { clock: waitSources.clock } : {}),
        ...(waitSources.policy ? { policy: waitSources.policy } : {}),
      })
    : undefined;
  if (waitObserver && waitSources)
    invocationWaits = new HostInvocationEventWaitCoordinator({
      stores,
      observer: waitObserver,
      sources: waitSources,
      onChanged: eventWaitsChanged,
      onError: (error) => {
        errors.push(error);
        requestedDrain = true;
      },
      ...(waitSources.clock ? { clock: waitSources.clock } : {}),
    });
  const goalChangeListeners = new Set<() => void>();
  const rootPort: HostMessageRootPort = {
    readLatestRootTurnLineage: async (identity) => identity,
    readSessionHeader: (sessionId) => requireCoordinator(coordinator).readSessionHeader(sessionId),
    readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
    claimStopFence: (input, commitQueueFence, lease) =>
      requireCoordinator(coordinator).claimStopFence(input, commitQueueFence, lease),
    startFromMessage: (input, lease, commitAdmission) =>
      requireCoordinator(coordinator).startFromMessage(input, lease, commitAdmission),
    prepareMessage: (input) => requireCoordinator(coordinator).prepareMessage(input),
    claimStop: (input, commitQueueFence, lease) =>
      requireCoordinator(coordinator).claimStop(input, commitQueueFence, lease),
  };
  const hostEpoch = 'goal-root-epoch';
  const messages = new HostMessageCoordinator({
    hostEpoch,
    root: rootPort,
    durableProof: {
      readLogicalExecution: (identity) =>
        readLogicalRuntimeExecution(stores.runtimeEventStore, identity),
      readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
        stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
      readImmutableSteeringMessageProof: (sessionId, messageId) =>
        stores.runtimeEventStore.readImmutableSteeringMessageProof(sessionId, messageId),
    },
    admissions: stores.sessionStore,
    sessionAdmission: admission,
    acquireResidency,
    requestDrain: () => {
      requestedDrain = true;
    },
    preflightSessionSnapshot: (sessionId, candidate) =>
      requireProjection(projection).fitsCandidate(sessionId, candidate),
    onProjectionChanged: (sessionId) =>
      requireContinuity(continuity).enqueueCanonicalRefresh(sessionId),
  });
  const canonical = new CanonicalSessionProjectionReader({
    stores,
    rootAdmissions,
    messages,
    readGoal: (sessionId) => requireGoal(goal).readProjection(sessionId),
    readEventWaits: async (sessionId) => {
      const { items, nextCursor } = await requireGoal(goal).readEventWaits(sessionId);
      return { items, nextCursor };
    },
  });
  projection = canonical;
  continuity = new SessionContinuityCoordinator(
    hostEpoch,
    (sessionId) => canonical.read(sessionId),
    admission,
    () => {
      requestedDrain = true;
    },
  );
  const interactions = new HostInteractionCoordinator({
    store: stores.interactionStore,
    sandboxBoundaries: stores.sessionStore,
    sessionAdmission: admission,
    sessions: stores.sessionStore,
    preflightSessionSnapshot: (sessionId, interactions) =>
      canonical.fitsCandidate(sessionId, { interactions }),
    refreshCanonicalContinuity: (sessionId, lease) =>
      requireContinuity(continuity).refreshCanonical(sessionId, lease),
    onPoison: () => {
      requestedDrain = true;
    },
    resolveSandboxBoundaryRootSession: async () => undefined,
    onSandboxBoundaryGraphWake: async () => {},
  });
  const backends = new BackendRegistry();
  if (options.registerBackend) options.registerBackend(backends);
  else
    backends.register('ai-sdk', (context) =>
      options.model
        ? new AiSdkBackend({
            sessionId: context.sessionId,
            header: context.header,
            connection: { slug: 'fake', providerType: 'openai', defaultModel: 'fake-model' },
            apiKey: 'test',
            modelId: 'fake-model',
            modelFactory: () => options.model!,
            providerStateIdentity: `sha256:${'a'.repeat(64)}`,
            tools: [
              ...requireGoal(goal).tools,
              ...(invocationWaits
                ? [
                    invocationWaits.createTool(context.sessionId, () =>
                      ['active', 'waiting'].includes(
                        requireGoal(goal).manager.get(context.sessionId)?.status ?? '',
                      ),
                    ).tool,
                  ]
                : []),
            ],
            runtimeCommitSink: stores.runtimeEventStore,
            loadTurnRuntimeEvents: context.loadTurnRuntimeEvents,
            loadModelProjectionTransitions: context.loadModelProjectionTransitions,
            recordModelProjectionTransition: context.recordModelProjectionTransition,
            readExecutionBoundary: async () => createExternalExecutionBoundary(),
            readPermissionMode: async () => context.header.permissionMode,
            maxSteps: 4,
          })
        : new FakeBackend(context),
    );
  const authority: RuntimeHostedRootAuthority = {
    bindRun: (identity) => {
      const owner = messages.bindRun(identity);
      invocationWaits?.admitRun(
        identity,
        ['active', 'waiting'].includes(
          requireGoal(goal).manager.get(identity.sessionId)?.status ?? '',
        ),
      );
      return {
        ...owner,
        release: () => {
          owner.release();
          invocationWaits?.releaseRun(identity);
        },
      };
    },
    executeRoot: (input) =>
      executeHostedExecutionToSettlement(requireCoordinator(coordinator), input),
    stopRoot: (identity, input) => requireCoordinator(coordinator).stopRoot(identity, input),
    stopRootRun: (identity, input) => requireCoordinator(coordinator).stopRootRun(identity, input),
    stopSession: (sessionId, input) =>
      requireCoordinator(coordinator).stopSession(sessionId, input),
  };
  const manager = new SessionManager({
    ...(options.registerBackend
      ? {
          safeBoundaryResumeEnabled: true,
          inspectContinuationSafety: async () => ({
            workspaceIdentity: 'handoff-workspace',
            backgroundOperationsSettled: true,
            availableToolNames: [],
          }),
        }
      : {}),
    store: stores.sessionStore,
    runStore: stores.agentRunStore,
    runtimeEventStore: stores.runtimeEventStore,
    toolBoundaryProtocol: stores.runtimeEventStore.toolBoundaryProtocol,
    backends,
    newId: randomUUID,
    now: Date.now,
    messageAuthority: authority,
    interactionAuthority: interactions,
    canonicalPermissionOutcomes: new HostCanonicalPermissionOutcomeReader({
      store: stores.interactionStore,
    }),
  });
  coordinator = new RootTurnCoordinator(
    manager,
    stores,
    admission,
    rootAdmissions,
    interactions,
    messages,
    continuity,
    acquireResidency,
    () => {
      requestedDrain = true;
    },
    undefined,
    () => requireGoal(goal),
  );
  const rootCoordinator = coordinator;
  const goalExecutions = new HostGoalExecutionCoordinator({
    preflightGoalWaiting: async (sessionId, pending) =>
      (await requireGoal(goal).goalWaitingBridge?.preflightAdmission(sessionId, pending)) ?? false,
    authorizeGoalWaiting: async (sessionId, pending) =>
      (await requireGoal(goal).goalWaitingBridge?.authorizeAdmission(sessionId, pending)) ?? false,
    executions: rootCoordinator,
    runtime: manager,
    matchesActive: (sessionId, checkpoint, controlLease) =>
      requireGoal(goal).matchesActive(sessionId, checkpoint, controlLease),
    newId: randomUUID,
  });
  goal = new HostGoalCoordinator({
    cancelInvocationWait: (target) => invocationWaits?.cancel(target) ?? Promise.resolve(false),
    ...(waitObserver ? { eventWaitObserver: waitObserver } : {}),
    ...(waitSources ? { eventWaitSources: waitSources } : {}),
    store: goalStore,
    stores,
    readSessionContext: async (sessionId) => {
      await options.beforeReadContext?.();
      return { messages: await manager.getMessages(sessionId) };
    },
    executions: rootCoordinator,
    sessionAdmission: admission,
    evaluator: {
      evaluate: async () => {
        const result = await options.onEvaluate?.();
        if (typeof result === 'string') return result;
        return '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"verified"}';
      },
      close: async () => {},
    },
    admitTurn: (sessionId, text, checkpoint, controlLease, goalWaiting) =>
      goalExecutions.admitTurn(sessionId, text, checkpoint, controlLease, goalWaiting),
    acquireResidency,
    onProjectionChanged: (sessionId) => {
      eventWaitsChanged(sessionId);
      for (const listener of goalChangeListeners) listener();
      if (goal) options.onGoalProjection?.(goal, sessionId);
    },
    requestDrain: () => {
      requestedDrain = true;
    },
  });
  await goal.prepareRecovery();
  const goalCoordinator = goal;
  await waitObserver?.start();
  await invocationWaits?.start();

  return {
    errors,
    ...(waitObserver ? { waitObserver } : {}),
    ...(invocationWaits ? { invocationWaits } : {}),
    owner,
    base,
    stores,
    goalStore,
    sessionId: session.id,
    rootAdmissions,
    coordinator: rootCoordinator,
    goal: goalCoordinator,
    goalExecutions,
    manager,
    messages,
    sessionAdmission: admission,
    drainRequested: () => requestedDrain,
    continuity,
    waitForGoalStatus: (status) =>
      new Promise<GoalState>((resolve, reject) => {
        let timeout: NodeJS.Timeout | undefined;
        const check = () => {
          const current = goalCoordinator.manager.get(session.id);
          if (current?.status !== status) return;
          if (timeout) clearTimeout(timeout);
          goalChangeListeners.delete(check);
          resolve(current);
        };
        goalChangeListeners.add(check);
        timeout = setTimeout(() => {
          goalChangeListeners.delete(check);
          reject(new Error(`Goal did not reach ${status}`));
        }, 10_000);
        check();
      }),
    async close() {
      goalExecutions.beginDrain();
      goalCoordinator.beginDrain();
      rootCoordinator.beginDrain();
      try {
        await goalCoordinator.close();
        await invocationWaits?.close();
        await waitObserver?.close();
      } finally {
        await rootCoordinator.close();
        await messages.close();
        await interactions.close();
        continuity?.close();
        await goalStore.close();
        await stores.sessionStore.close?.();
        await owner.close();
        if (!options.keepRoot) await rm(base, { recursive: true, force: true });
      }
    },
  };
}
async function readInvocation(
  fixture: Fixture,
  runId: string,
): Promise<RuntimeInvocationRecord | undefined> {
  return (await fixture.stores.runtimeEventStore.listSessionInvocations(fixture.sessionId)).find(
    (candidate) => candidate.runId === runId,
  );
}

async function waitForGoalRun(fixture: Fixture, goalId: string): Promise<RuntimeInvocationRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = (
      await fixture.stores.runtimeEventStore.listSessionInvocations(fixture.sessionId)
    ).find(
      (candidate) =>
        candidate.opening.root.kind === 'goal' && candidate.opening.root.goalId === goalId,
    );
    if (run) return run;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Goal continuation did not reach the root authority');
}

function operationContext() {
  return {
    hostEpoch: 'goal-root-epoch',
    connectionId: 'connection-1',
    principal: 'local_os_user' as const,
    acquireResidency: () => ({ release() {} }),
  };
}

function requireCoordinator(value: RootTurnCoordinator | undefined): RootTurnCoordinator {
  if (!value) throw new Error('Root coordinator is not composed');
  return value;
}

function requireContinuity(
  value: SessionContinuityCoordinator | undefined,
): SessionContinuityCoordinator {
  if (!value) throw new Error('Continuity coordinator is not composed');
  return value;
}

function requireProjection(
  value: CanonicalSessionProjectionReader | undefined,
): CanonicalSessionProjectionReader {
  if (!value) throw new Error('Canonical projection is not composed');
  return value;
}

function requireGoal(value: HostGoalCoordinator | undefined): HostGoalCoordinator {
  if (!value) throw new Error('Goal coordinator is not composed');
  return value;
}

async function startEventWait(f: Fixture, maxIterations = 50) {
  await f.goal.recover();
  f.goal.manager.create(f.sessionId, 'Wait for the job', { armed: true, maxIterations });
  await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
  const submitted = await f.messages.handlers['turn.message.submit'](
    {
      originHostEpoch: 'goal-root-epoch',
      sessionId: f.sessionId,
      messageId: 'start-wait',
      content: { text: 'Start waiting' },
      placement: 'current_turn',
    },
    operationContext(),
  );
  assert.equal(submitted.ok, true);
}

async function waitForInvocationDelivery(f: Fixture, waitId: string, kind: 'consumed' | 'retired') {
  // Run termination and a joined reconciliation scan are not delivery commit barriers.
  await waitFor(
    async () =>
      (await f.stores.eventWaitStore.readAny({ sessionId: f.sessionId, waitId }))?.record.delivery
        ?.kind === kind,
    { timeoutMs: 5000 },
  );
  const snapshot = await f.stores.eventWaitStore.readAny({ sessionId: f.sessionId, waitId });
  assert.ok(snapshot);
  return snapshot;
}

function observationSources(
  read: () => Promise<import('../server/event-wait-adapter.js').EventWaitObservationResult>,
): HostEventWaitSources {
  return {
    authorize: async () => ({ kind: 'allowed', context: null }),
    policy: { minIntervalMs: 1, pollIntervalMs: 5, jitterRatio: 0 },
    adapters: new EventWaitAdapterRegistry([
      {
        providerId: 'test',
        resourceType: 'job',
        conditionType: 'done',
        conditionVersion: 1,
        reconciliation: 'snapshot',
        validate() {},
        read,
      },
    ]),
  };
}
const naturalCondition = {
  resource: { providerId: 'test', connectionId: null, resourceType: 'job', resourceId: 'job' },
  condition: { typeId: 'done', version: 1, parameters: {} },
  deadlineAt: null,
};
function scriptedWaitModel(
  script: (call: number) => readonly string[],
  onCall?: (call: number) => unknown,
) {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const call = ++calls;
      await onCall?.(call);
      const ids = script(call);
      return {
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'stream-start', warnings: [] },
          ...ids.map((id) => ({
            type: 'tool-call' as const,
            toolCallId: id,
            toolName: 'WaitForEvent',
            input: JSON.stringify({
              resource: naturalCondition.resource,
              condition: naturalCondition.condition,
              reason: 'Observe the job',
            }),
          })),
          {
            type: 'finish',
            finishReason: { unified: ids.length ? 'tool-calls' : 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
            },
          },
        ]),
      };
    },
  });
}

for (const provider of ['local', 'memory'] as const)
  for (const cancel of [false, true])
    test(`natural Goal waiting uses one atomic next Root admission (${provider}, cancel=${cancel})`, {
      timeout: 15_000,
    }, async () => {
      let satisfied = false,
        evaluations = 0;
      const firstRead = deferred();
      const f = await createFixture({
        persistenceProvider:
          provider === 'local' ? 'local' : createMemoryExecutionPersistenceProvider(),
        model: scriptedWaitModel(() => []),
        eventWaitSources: observationSources(async () => {
          firstRead.resolve();
          return satisfied
            ? { kind: 'satisfied', receiptKey: 'job-done', evidenceRefs: ['job/result'] }
            : { kind: 'pending' };
        }),
        onEvaluate: () =>
          ++evaluations === 1
            ? JSON.stringify({
                met: false,
                impossible: false,
                progress: true,
                waiting: true,
                reason: 'Waiting for job',
                waitingCondition: naturalCondition,
              })
            : '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"verified"}',
      });
      try {
        await startEventWait(f);
        await firstRead.promise;
        const waiting = await f.goalStore.read(f.sessionId);
        assert.equal(waiting?.record.goal.status, 'waiting');
        assert.equal(waiting?.record.goal.iterations, 1);
        const pending = waiting?.record.pendingContinuation;
        assert.ok(pending?.observation);
        const sourceAdmissions = await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
          f.sessionId,
        );
        assert.equal(sourceAdmissions.length, 1);
        const source = await f.stores.runtimeEventStore.readRunInvocation(
          f.sessionId,
          sourceAdmissions[0]!.runId,
        );
        assert.equal(source?.terminalEvent?.status, 'completed');
        assert.notEqual(source?.terminalEvent?.actions?.stateDelta?.stopReason, 'event_wait');
        if (cancel) {
          const projection = await f.goal.readEventWaits(f.sessionId);
          assert.equal(projection.items.length, 1);
          const { sessionId, waitId, consumer } = projection.items[0]!;
          const result = await f.goal.handlers['session.event-wait.cancel'](
            { sessionId, waitId, consumer },
            operationContext(),
          );
          assert.ok(result.ok && result.result.outcome === 'cancelled');
        } else {
          satisfied = true;
          await f.waitObserver!.reconcile();
        }
        try {
          await f.waitForGoalStatus('achieved');
        } catch (error) {
          throw new Error(
            JSON.stringify({
              goal: await f.goalStore.read(f.sessionId),
              waits: await f.stores.eventWaitStore.listAny({ sessionId: f.sessionId, limit: 10 }),
              admissions: await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
                f.sessionId,
              ),
              evaluations,
              drain: f.drainRequested(),
            }),
            { cause: error },
          );
        }
        const admissions = await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
          f.sessionId,
        );
        assert.equal(admissions.length, 2);
        const successor = admissions.find((a) => a.execution.kind === 'goal')!;
        assert.ok(successor.execution.kind === 'goal' && successor.execution.goalWaiting);
        const wait = (await f.stores.eventWaitStore.readAny({
          sessionId: f.sessionId,
          waitId: pending.observation.waitId,
        }))!.record;
        assert.equal(wait.delivery?.kind, 'admitted');
        assert.equal(wait.status, cancel ? 'cancelled' : 'resolved');
        assert.equal(f.goal.manager.get(f.sessionId)?.iterations, 1);
        assert.equal(evaluations, 2);
        await f.goal.goalWaitingBridge!.reconcile();
        assert.equal(
          (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
          2,
        );
        assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
      } finally {
        await f.close();
      }
    });

for (const provider of ['local', 'memory'] as const)
  for (const cancel of [false, true])
    test(`natural admission retries the current result after source preflight (${provider}, cancel=${cancel})`, {
      timeout: 15_000,
    }, async () => {
      let evaluations = 0;
      let f: Fixture | undefined;
      let held = false;
      const entered = deferred();
      const release = deferred();
      const transitions: GoalStatus[] = [];
      f = await createFixture({
        persistenceProvider:
          provider === 'local' ? 'local' : createMemoryExecutionPersistenceProvider(),
        model: scriptedWaitModel(() => []),
        eventWaitSources: {
          ...observationSources(async () => ({
            kind: 'satisfied',
            receiptKey: 'done',
            evidenceRefs: ['job/result'],
          })),
          authorize: async (wait) => {
            // Pause real source I/O after ready has frozen the successor identity,
            // while Root is reserved but the Session admission lane is still free.
            if (
              f &&
              !held &&
              wait.status === 'resolved' &&
              f.goal.manager.get(f.sessionId)?.status === 'active' &&
              f.coordinator.readRootState(f.sessionId).kind === 'reserved'
            ) {
              held = true;
              entered.resolve();
              await release.promise;
            }
            return { kind: 'allowed', context: null };
          },
        },
        onGoalProjection: (goal, sessionId) => {
          const status = goal.manager.get(sessionId)?.status;
          if (status) transitions.push(status);
        },
        onEvaluate: () =>
          ++evaluations === 1
            ? JSON.stringify({
                met: false,
                impossible: false,
                progress: true,
                waiting: true,
                reason: 'Waiting for job',
                waitingCondition: naturalCondition,
              })
            : '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"verified"}',
      });
      try {
        await startEventWait(f);
        await entered.promise;
        const before = (await f.stores.goalStore.read(f.sessionId))!.record;
        const expected = before.pendingContinuation!.goalWaiting!;
        const target = (await f.goal.readEventWaits(f.sessionId)).items[0]!;
        assert.equal(target.phase, 'result_ready');
        if (cancel) {
          const outcome = await f.goal.handlers['session.event-wait.cancel'](
            { sessionId: f.sessionId, waitId: target.waitId, consumer: target.consumer },
            operationContext(),
          );
          assert.ok(outcome.ok && outcome.result.outcome === 'cancelled');
          // A stale result at either gate must remain retryable under this owner.
          assert.equal(
            await f.goal.goalWaitingBridge!.preflightAdmission(f.sessionId, expected),
            'defer',
          );
          assert.equal(
            await f.goal.goalWaitingBridge!.authorizeAdmission(f.sessionId, expected),
            'defer',
          );
        }
        release.resolve();
        await waitFor(() => transitions.includes('paused') || transitions.includes('achieved'));
        await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
        assert.equal(
          transitions.includes('paused'),
          false,
          'an unadmitted attempt is not a failed Turn',
        );
        await f.waitForGoalStatus('achieved');
        const after = (await f.stores.goalStore.read(f.sessionId))!.record;
        assert.deepEqual(after.controlLease, before.controlLease);
        const admissions = await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
          f.sessionId,
        );
        assert.equal(admissions.length, 2);
        const successor = admissions.find((a) => a.turnId === expected.execution.turnId)!;
        assert.ok(successor);
        assert.equal(successor.runId, expected.execution.runId);
        assert.equal(successor.userMessageId, expected.userMessageId);
        assert.match(
          successor.normalizedInput!.text!,
          new RegExp(`"outcome":"${cancel ? 'cancelled' : 'satisfied'}"`),
        );
        const wait = (await f.stores.eventWaitStore.readAny({
          sessionId: f.sessionId,
          waitId: target.waitId,
        }))!.record;
        assert.equal(wait.status, cancel ? 'cancelled' : 'resolved');
        assert.equal(wait.delivery?.kind, 'admitted');
        assert.equal(after.goal.iterations, 1);
        assert.equal(evaluations, 2);
        assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
      } finally {
        release.resolve();
        await f.close();
      }
    });

for (const provider of ['local', 'memory'] as const)
  for (const control of ['drain', 'clear'] as const)
    test(`natural observation distinguishes Host drain from Goal clear (${provider}, ${control})`, {
      timeout: 15_000,
    }, async () => {
      const observed = deferred();
      const afterDrain = deferred();
      let draining = false;
      const f = await createFixture({
        persistenceProvider:
          provider === 'local' ? 'local' : createMemoryExecutionPersistenceProvider(),
        model: scriptedWaitModel(() => []),
        eventWaitSources: observationSources(async () => ({ kind: 'pending' })),
        onEventWaitChanged: (wait) => {
          if (wait.observation?.outcome === 'pending') observed.resolve();
          if (draining && (wait.status === 'cancelled' || wait.observation?.outcome === 'unknown'))
            afterDrain.resolve();
        },
        onEvaluate: () =>
          JSON.stringify({
            met: false,
            impossible: false,
            progress: true,
            waiting: true,
            reason: 'Waiting for job',
            waitingCondition: naturalCondition,
          }),
      });
      try {
        await startEventWait(f);
        await observed.promise;
        const target = (await f.goal.readEventWaits(f.sessionId)).items[0]!;
        const read = () =>
          f.stores.eventWaitStore.readAny({ sessionId: f.sessionId, waitId: target.waitId });
        const original = (await read())!.record;
        assert.equal(original.schemaVersion, 2);
        if (original.schemaVersion !== 2) throw new Error('Expected consumer wait');
        if (control === 'drain') {
          draining = true;
          f.goalExecutions.beginDrain();
          f.goal.beginDrain();
          // Deliberately keep the observer alive to exercise the authorization
          // fallback independently of the production observer drain ordering.
          await afterDrain.promise;
          const current = (await read())!.record;
          assert.equal(current.status, 'waiting', 'Host shutdown is not a business cancellation');
          assert.equal(current.delivery, undefined);
          assert.equal((await f.stores.goalStore.read(f.sessionId))!.record.goal.status, 'waiting');
          assert.equal(
            (
              await f.goal.goalWaitingBridge!.authorizeObservation(
                original,
                new AbortController().signal,
              )
            ).kind,
            'unknown',
          );
        } else {
          f.goal.manager.clear(f.sessionId);
          await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
          assert.equal(
            (
              await f.goal.goalWaitingBridge!.authorizeObservation(
                original,
                new AbortController().signal,
              )
            ).kind,
            'revoked',
          );
          assert.equal((await read())!.record.delivery?.kind, 'retired');
        }
        assert.equal(
          (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
          1,
        );
        assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
      } finally {
        await f.close();
      }
    });

test('natural waiting survives SQLite close and reopen after Goal drain', {
  timeout: 15_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-goal-drain-reopen-'));
  const observed = deferred();
  const afterDrain = deferred();
  let draining = false;
  let first: Fixture | undefined;
  let reopened: Fixture | undefined;
  let firstClosed = false;
  try {
    first = await createFixture({
      base,
      keepRoot: true,
      model: scriptedWaitModel(() => []),
      eventWaitSources: observationSources(async () => ({ kind: 'pending' })),
      onEventWaitChanged: (wait) => {
        if (wait.observation?.outcome === 'pending') observed.resolve();
        if (draining && (wait.status === 'cancelled' || wait.observation?.outcome === 'unknown'))
          afterDrain.resolve();
      },
      onEvaluate: () =>
        JSON.stringify({
          met: false,
          impossible: false,
          progress: true,
          waiting: true,
          reason: 'Waiting for job',
          waitingCondition: naturalCondition,
        }),
    });
    await startEventWait(first);
    await observed.promise;
    const sessionId = first.sessionId;
    const waitId = (await first.goal.readEventWaits(sessionId)).items[0]!.waitId;
    draining = true;
    first.goalExecutions.beginDrain();
    first.goal.beginDrain();
    await afterDrain.promise;
    await first.close();
    firstClosed = true;
    const reobserved = deferred();
    let satisfied = false;
    reopened = await createFixture({
      base,
      sessionId,
      keepRoot: true,
      model: scriptedWaitModel(() => []),
      eventWaitSources: observationSources(async () =>
        satisfied
          ? { kind: 'satisfied', receiptKey: 'real-result-after-reopen', evidenceRefs: [] }
          : { kind: 'pending' },
      ),
      onEventWaitChanged: (wait) => {
        if (wait.observation?.outcome === 'pending') reobserved.resolve();
      },
    });
    assert.equal(
      (await reopened.stores.eventWaitStore.readAny({ sessionId, waitId }))!.record.status,
      'waiting',
    );
    await reopened.goal.recover();
    await reobserved.promise;
    assert.equal(
      (await reopened.stores.agentRunStore.listRootTurnAdmissionsForRecovery(sessionId)).length,
      1,
    );
    satisfied = true;
    await reopened.waitObserver!.reconcile();
    await reopened.waitForGoalStatus('achieved');
    const wait = (await reopened.stores.eventWaitStore.readAny({ sessionId, waitId }))!.record;
    assert.equal(wait.status, 'resolved');
    assert.equal(wait.delivery?.kind, 'admitted');
    assert.equal(
      (await reopened.stores.agentRunStore.listRootTurnAdmissionsForRecovery(sessionId)).length,
      2,
    );
    assert.equal(reopened.drainRequested(), false, reopened.errors.map(String).join('\n'));
  } finally {
    if (reopened) await reopened.close();
    if (first && !firstClosed) await first.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('natural cancellation checks its revision after an earlier ready mutation commits', {
  timeout: 15_000,
}, async () => {
  let satisfied = false;
  let evaluations = 0;
  let holdReadyRead = false;
  let readyReadHeld = false;
  let observeCancelHeader = false;
  const initialRead = deferred();
  const readyRead = deferred();
  const releaseReadyRead = deferred();
  const cancelHeader = deferred();
  const backing = createMemoryExecutionPersistenceProvider();
  const persistenceProvider: ExecutionPersistenceProvider = {
    open: async (input) => {
      const stores = await backing.open(input);
      return {
        ...stores,
        sessionStore: {
          ...stores.sessionStore,
          readHeaderSnapshot: async (sessionId) => {
            const header = await stores.sessionStore.readHeaderSnapshot(sessionId);
            if (observeCancelHeader) {
              observeCancelHeader = false;
              cancelHeader.resolve();
            }
            return header;
          },
        },
        eventWaitStore: {
          ...stores.eventWaitStore,
          readAny: async (identity) => {
            const snapshot = await stores.eventWaitStore.readAny(identity);
            if (holdReadyRead && snapshot?.record.status === 'resolved') {
              holdReadyRead = false;
              readyReadHeld = true;
              readyRead.resolve();
              await releaseReadyRead.promise;
            }
            return snapshot;
          },
        },
      };
    },
  };
  const sources: HostEventWaitSources = {
    ...observationSources(async () => {
      initialRead.resolve();
      return satisfied
        ? { kind: 'satisfied', receiptKey: 'finished', evidenceRefs: [] }
        : { kind: 'pending' };
    }),
    authorize: async (wait) => {
      // The scan has read the resolved record; its next read is ready's
      // revalidation under the Goal mutation lane.
      if (wait.status === 'resolved' && !readyReadHeld) holdReadyRead = true;
      return { kind: 'allowed', context: null };
    },
  };
  const f = await createFixture({
    persistenceProvider,
    model: scriptedWaitModel(() => []),
    eventWaitSources: sources,
    onEvaluate: () =>
      ++evaluations === 1
        ? JSON.stringify({
            met: false,
            impossible: false,
            progress: true,
            waiting: true,
            reason: 'Waiting for job',
            waitingCondition: naturalCondition,
          })
        : '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"verified"}',
  });
  try {
    await startEventWait(f);
    await initialRead.promise;
    const { sessionId, waitId, consumer } = (await f.goal.readEventWaits(f.sessionId)).items[0]!;
    assert.equal(consumer.kind, 'goal_waiting');
    satisfied = true;
    await f.waitObserver!.reconcile();
    await readyRead.promise;
    observeCancelHeader = true;
    const cancellation = f.goal.handlers['session.event-wait.cancel'](
      { sessionId, waitId, consumer },
      operationContext(),
    );
    await cancelHeader.promise;
    // Drain runnable continuations while the exact ready read remains held.
    // A stale pre-read implementation can now cancel outside the Goal lane.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseReadyRead.resolve();
    const outcome = await cancellation;
    assert.ok(outcome.ok && outcome.result.outcome === 'conflict');
    await f.waitForGoalStatus('achieved');
    const final = (await f.stores.eventWaitStore.readAny({ sessionId, waitId }))!.record;
    assert.equal(final.status, 'resolved');
    assert.equal(final.delivery?.kind, 'admitted');
    assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
  } finally {
    releaseReadyRead.resolve();
    await f.close();
  }
});

for (const change of ['none', 'pause', 'clear'] as const)
  test(`in-turn wait retains Root and tool capability after ${change} (${change === 'none' ? 'last iteration' : 'second wait'})`, {
    timeout: 15_000,
  }, async () => {
    let satisfied = false,
      reads = 0,
      modelCalls = 0,
      evaluations = 0;
    const firstRead = deferred();
    const f = await createFixture({
      model: scriptedWaitModel(
        (call) => (call <= (change === 'none' ? 1 : 2) ? [`wait-${call}`] : []),
        (call) => {
          modelCalls = call;
        },
      ),
      eventWaitSources: observationSources(async () => {
        reads++;
        firstRead.resolve();
        return satisfied
          ? { kind: 'satisfied', receiptKey: `job-done-${reads}`, evidenceRefs: [] }
          : { kind: 'pending' };
      }),
      onEvaluate: () => {
        evaluations++;
      },
    });
    try {
      await startEventWait(f, 1);
      await firstRead.promise;
      const first = (
        await f.stores.eventWaitStore.listAny({
          sessionId: f.sessionId,
          consumerKind: 'tool_invocation',
          limit: 10,
        })
      ).items[0]!.record;
      const before = await f.goalStore.read(f.sessionId);
      assert.equal(before?.record.goal.iterations, 0);
      assert.equal(before?.record.pendingContinuation, null);
      assert.equal(modelCalls, 1);
      assert.equal(evaluations, 0);
      const admissions = await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
        f.sessionId,
      );
      assert.equal(admissions.length, 1);
      const running = await f.stores.runtimeEventStore.readRunInvocation(
        f.sessionId,
        admissions[0]!.runId,
      );
      assert.equal(running?.terminalEvent, undefined);
      if (change === 'pause') f.goal.manager.pause(f.sessionId, { reason: 'User paused the Goal' });
      if (change === 'clear') f.goal.manager.clear(f.sessionId);
      await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
      if (change === 'clear') {
        const projection = await f.goal.readEventWaits(f.sessionId);
        assert.equal(projection.items.length, 1);
        assert.equal(projection.items[0]!.waitId, first.waitId);
        assert.equal((await f.goal.readProjection(f.sessionId))?.status, 'cleared');
      }
      satisfied = true;
      await f.waitObserver!.reconcile();
      await waitFor(
        async () =>
          !!(await f.stores.runtimeEventStore.readRunInvocation(f.sessionId, admissions[0]!.runId))
            ?.terminalEvent,
        { timeoutMs: 5000 },
      );
      const ended = await f.stores.runtimeEventStore.readRunInvocation(
        f.sessionId,
        admissions[0]!.runId,
      );
      assert.equal(ended?.terminalEvent?.status, 'completed');
      assert.notEqual(ended?.terminalEvent?.actions?.stateDelta?.stopReason, 'event_wait');
      assert.equal(
        (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
        1,
      );
      const registeredWaits = (
        await f.stores.eventWaitStore.listAny({
          sessionId: f.sessionId,
          consumerKind: 'tool_invocation',
          limit: 10,
        })
      ).items;
      assert.equal(registeredWaits.length, change === 'none' ? 1 : 2);
      const waits = await Promise.all(
        registeredWaits.map(({ record }) =>
          waitForInvocationDelivery(f, record.waitId, 'consumed'),
        ),
      );
      assert.ok(
        waits.every(
          (s) => s.record.status === 'resolved' && s.record.delivery?.kind === 'consumed',
        ),
      );
      assert.ok(waits.every((s) => s.record.sourceTurnId === first.sourceTurnId));
      assert.equal(modelCalls, change === 'none' ? 2 : 3);
      assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
    } finally {
      await f.close();
    }
  });

test('natural outbox releases its completed Root while registration is pending', {
  timeout: 15_000,
}, async () => {
  let evaluations = 0,
    sourceReads = 0;
  const registering = deferred(),
    releaseRegistration = deferred();
  const backing = createMemoryExecutionPersistenceProvider();
  const persistenceProvider: ExecutionPersistenceProvider = {
    open: async (input) => {
      const stores = await backing.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          registerGoalWaitingWait: async (input) => {
            registering.resolve();
            await releaseRegistration.promise;
            return stores.eventWaitStore.registerGoalWaitingWait(input);
          },
        },
      };
    },
  };
  const f = await createFixture({
    persistenceProvider,
    model: scriptedWaitModel(() => []),
    eventWaitSources: observationSources(async () => {
      sourceReads++;
      return { kind: 'pending' };
    }),
    onEvaluate: () =>
      ++evaluations === 1
        ? JSON.stringify({
            met: false,
            impossible: false,
            progress: true,
            waiting: true,
            reason: 'Wait for the source',
            waitingCondition: naturalCondition,
          })
        : '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"New user work completed"}',
  });
  try {
    await startEventWait(f);
    await registering.promise;
    const authority = (await f.goalStore.read(f.sessionId))!.record;
    assert.equal(authority.goal.status, 'waiting');
    assert.equal(authority.goal.iterations, 1);
    assert.equal(authority.pendingContinuation?.observationPreparation, undefined);
    assert.equal(authority.pendingContinuation?.observation?.deadlineAt, null);
    await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle');
    const reply = await f.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: 'goal-root-epoch',
        sessionId: f.sessionId,
        messageId: 'work-during-registration',
        content: { text: 'Use this newer result now' },
        placement: 'current_turn',
      },
      operationContext(),
    );
    assert.equal(reply.ok, true);
    await f.waitForGoalStatus('achieved');
    releaseRegistration.resolve();
    await f.goal.goalWaitingBridge!.reconcile();
    const admissions = await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId);
    assert.equal(admissions.length, 2);
    assert.ok(admissions.every((admission) => admission.execution.kind === 'external_message'));
    assert.equal(evaluations, 2);
    assert.equal(sourceReads, 0);
    assert.deepEqual(
      (await f.stores.eventWaitStore.listAny({ sessionId: f.sessionId, limit: 10 })).items,
      [],
    );
    assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
  } finally {
    releaseRegistration.resolve();
    await f.close();
  }
});

for (const [expired, phase] of [
  [false, 'prepared'],
  [true, 'prepared'],
  [true, 'raw'],
] as const)
  test(`natural preparation waits for its durable ${phase} commit before registration (expired=${expired})`, {
    timeout: 15_000,
  }, async () => {
    let evaluations = 0;
    const read = deferred();
    const committing = deferred(),
      releaseCommit = deferred();
    const backing = createMemoryExecutionPersistenceProvider();
    const persistenceProvider: ExecutionPersistenceProvider = {
      open: async (input) => {
        const stores = await backing.open(input);
        return {
          ...stores,
          goalStore: {
            ...stores.goalStore,
            commit: async (input) => {
              const pending = input.record?.pendingContinuation;
              if (
                pending?.observation &&
                pending.observationPreparation === (phase === 'raw' ? 'pending' : undefined) &&
                !pending.goalWaiting
              ) {
                committing.resolve();
                await releaseCommit.promise;
              }
              return stores.goalStore.commit(input);
            },
          },
        };
      },
    };
    const sources: HostEventWaitSources = {
      ...observationSources(async () => {
        const pending = (await f.goalStore.read(f.sessionId))!.record.pendingContinuation!;
        assert.equal(pending.observationPreparation, undefined);
        assert.deepEqual(pending.observation!.condition, naturalCondition.condition);
        read.resolve();
        return { kind: 'pending' };
      }),
    };
    const f = await createFixture({
      persistenceProvider,
      model: scriptedWaitModel(() => []),
      eventWaitSources: sources,
      onEvaluate: () =>
        ++evaluations > 1
          ? '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"verified"}'
          : JSON.stringify({
              met: false,
              impossible: false,
              progress: true,
              waiting: true,
              reason: 'Wait for a later event',
              waitingCondition: {
                ...naturalCondition,
                deadlineAt: expired ? Date.now() - 1 : null,
              },
            }),
    });
    try {
      await startEventWait(f);
      await committing.promise;
      const persisted = (await f.goalStore.read(f.sessionId))!.record.pendingContinuation;
      if (phase === 'raw') assert.equal(persisted, null);
      else assert.equal(persisted!.observationPreparation, 'pending');
      await f.goal.goalWaitingBridge!.reconcile();
      assert.deepEqual(
        (await f.stores.eventWaitStore.listAny({ sessionId: f.sessionId, limit: 10 })).items,
        [],
      );
      assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
      releaseCommit.resolve();
      if (expired) await f.waitForGoalStatus('achieved');
      else await read.promise;
      for (let i = 0; i < 3; i++) await f.goal.goalWaitingBridge!.reconcile();
      const records = (await f.stores.eventWaitStore.listAny({ sessionId: f.sessionId, limit: 10 }))
        .items;
      assert.equal(records.length, 1);
      if (expired) assert.equal(records[0]!.record.status, 'expired');
      else assert.deepEqual(records[0]!.record.condition, naturalCondition.condition);
      assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
    } finally {
      releaseCommit.resolve();
      await f.close();
    }
  });

test('natural waiting is superseded by a newer real Turn and does not hide its evaluator', {
  timeout: 15_000,
}, async () => {
  let evaluations = 0;
  const firstRead = deferred();
  const f = await createFixture({
    model: scriptedWaitModel(() => []),
    eventWaitSources: observationSources(async () => {
      firstRead.resolve();
      return { kind: 'pending' };
    }),
    onEvaluate: () =>
      ++evaluations === 1
        ? JSON.stringify({
            met: false,
            impossible: false,
            progress: true,
            waiting: true,
            reason: 'Wait',
            waitingCondition: naturalCondition,
          })
        : '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"New user work completed"}',
  });
  try {
    await startEventWait(f);
    await firstRead.promise;
    const waitId = (await f.goalStore.read(f.sessionId))!.record.pendingContinuation!.observation!
      .waitId;
    const reply = await f.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: 'goal-root-epoch',
        sessionId: f.sessionId,
        messageId: 'new-work',
        content: { text: 'Use my newer result' },
        placement: 'current_turn',
      },
      operationContext(),
    );
    assert.equal(reply.ok, true);
    await f.waitForGoalStatus('achieved');
    const old = (await f.stores.eventWaitStore.readAny({ sessionId: f.sessionId, waitId }))!.record;
    assert.equal(old.delivery?.kind, 'retired');
    assert.equal(evaluations, 2);
    const admissions = await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId);
    assert.equal(admissions.length, 2);
    assert.ok(admissions.every((a) => a.execution.kind === 'external_message'));
    assert.equal(f.drainRequested(), false);
  } finally {
    await f.close();
  }
});

for (const interrupt of ['steering', 'stop'] as const)
  test(`parallel in-turn waits preserve original operations on ${interrupt}`, {
    timeout: 15_000,
  }, async () => {
    let modelCalls = 0,
      evaluations = 0;
    const f = await createFixture({
      model: scriptedWaitModel(
        (call) => (call === 1 ? ['parallel-a', 'parallel-b'] : []),
        (call) => {
          modelCalls = call;
        },
      ),
      eventWaitSources: observationSources(async () => ({ kind: 'pending' })),
      onEvaluate: () => {
        evaluations++;
      },
    });
    try {
      await startEventWait(f);
      await waitFor(
        async () =>
          (
            await f.stores.eventWaitStore.listAny({
              sessionId: f.sessionId,
              consumerKind: 'tool_invocation',
              limit: 10,
            })
          ).items.length === 2,
        { timeoutMs: 5000 },
      );
      const registeredWaits = (
        await f.stores.eventWaitStore.listAny({
          sessionId: f.sessionId,
          consumerKind: 'tool_invocation',
          limit: 10,
        })
      ).items;
      assert.equal(registeredWaits.length, 2);
      const admissions = await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
        f.sessionId,
      );
      assert.equal(admissions.length, 1);
      const source = admissions[0]!;
      assert.equal(evaluations, 0);
      if (interrupt === 'stop') await f.coordinator.stopSession(f.sessionId);
      else {
        const reply = await f.messages.handlers['turn.message.submit'](
          {
            originHostEpoch: 'goal-root-epoch',
            sessionId: f.sessionId,
            messageId: 'steer-waits',
            content: { text: 'Here is newer context, continue now' },
            placement: 'current_turn',
          },
          operationContext(),
        );
        assert.equal(reply.ok, true);
      }
      await waitFor(
        async () =>
          !!(await f.stores.runtimeEventStore.readRunInvocation(f.sessionId, source.runId))
            ?.terminalEvent,
        { timeoutMs: 5000 },
      );
      await f.invocationWaits!.reconcile();
      await Promise.all(
        registeredWaits.map(({ record }) =>
          waitForInvocationDelivery(
            f,
            record.waitId,
            interrupt === 'stop' ? 'retired' : 'consumed',
          ),
        ),
      );
      const waits = (
        await f.stores.eventWaitStore.listAny({
          sessionId: f.sessionId,
          consumerKind: 'tool_invocation',
          limit: 10,
        })
      ).items.map((w) => w.record);
      assert.equal(waits.length, 2);
      assert.ok(waits.every((w) => w.sourceTurnId === source.turnId && w.status === 'cancelled'));
      assert.ok(
        waits.every((w) => w.delivery?.kind === (interrupt === 'stop' ? 'retired' : 'consumed')),
      );
      assert.equal(
        (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
        1,
      );
      assert.equal(modelCalls, interrupt === 'stop' ? 1 : 2);
      const proofs = await Promise.all(
        waits.map(async (w) =>
          w.schemaVersion === 2 && w.consumer.kind === 'tool_invocation'
            ? f.stores.runtimeEventStore.readToolProvenanceEvents(
                f.sessionId,
                w.consumer.runId,
                w.consumer.toolCallId,
                { maxRecords: 64, maxBytes: 1_048_576 },
              )
            : null,
        ),
      );
      assert.equal(
        f.drainRequested(),
        false,
        JSON.stringify({ errors: f.errors.map(String), proofs }),
      );
    } finally {
      await f.close();
    }
  });

test('a Goal Run paused before its first wait keeps its admitted waiting capability', {
  timeout: 15_000,
}, async () => {
  const providerEntered = deferred();
  const releaseProvider = deferred();
  let calls = 0;
  const f = await createFixture({
    model: scriptedWaitModel(
      (call) => (call === 1 ? ['first-after-pause'] : []),
      async (call) => {
        calls = call;
        if (call === 1) {
          providerEntered.resolve();
          await releaseProvider.promise;
        }
      },
    ),
    eventWaitSources: observationSources(async () => ({
      kind: 'satisfied',
      receiptKey: 'done',
      evidenceRefs: [],
    })),
  });
  try {
    await startEventWait(f);
    await providerEntered.promise;
    f.goal.manager.pause(f.sessionId, { reason: 'Pause autonomous continuation' });
    await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
    releaseProvider.resolve();
    await waitFor(
      async () =>
        (await f.stores.runtimeEventStore.listSessionInvocations(f.sessionId)).some(
          (i) => i.terminalEvent,
        ),
      { timeoutMs: 5000 },
    );
    const registeredWaits = (
      await f.stores.eventWaitStore.listAny({ sessionId: f.sessionId, limit: 10 })
    ).items;
    assert.equal(registeredWaits.length, 1);
    const waits = await Promise.all(
      registeredWaits.map(({ record }) => waitForInvocationDelivery(f, record.waitId, 'consumed')),
    );
    assert.equal(waits[0]!.record.delivery?.kind, 'consumed');
    assert.equal(calls, 2);
    assert.equal(f.goal.manager.get(f.sessionId)?.status, 'paused');
    assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
  } finally {
    releaseProvider.resolve();
    await f.close();
  }
});

test('invalid wait registration remains an ordinary tool error without draining the Host', {
  timeout: 15_000,
}, async () => {
  const f = await createFixture({
    model: scriptedWaitModel((call) => (call === 1 ? ['unsupported-wait'] : [])),
    eventWaitSources: {
      adapters: new EventWaitAdapterRegistry([]),
      authorize: async () => ({ kind: 'allowed', context: null }),
    },
  });
  try {
    await startEventWait(f);
    await waitFor(
      async () =>
        (await f.stores.runtimeEventStore.listSessionInvocations(f.sessionId)).some(
          (i) => i.terminalEvent,
        ),
      { timeoutMs: 5000 },
    );
    assert.equal(
      (await f.stores.eventWaitStore.listAny({ sessionId: f.sessionId, limit: 10 })).items.length,
      0,
    );
    assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
  } finally {
    await f.close();
  }
});

test('natural waiting preserves its deadline across a pending registration', {
  timeout: 15_000,
}, async () => {
  let evaluations = 0,
    sourceReads = 0;
  const registering = deferred(),
    releaseRegistration = deferred();
  let deadlineAt = 0;
  const backing = createMemoryExecutionPersistenceProvider();
  const persistenceProvider: ExecutionPersistenceProvider = {
    open: async (input) => {
      const stores = await backing.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          registerGoalWaitingWait: async (input) => {
            registering.resolve();
            await releaseRegistration.promise;
            return stores.eventWaitStore.registerGoalWaitingWait(input);
          },
        },
      };
    },
  };
  const f = await createFixture({
    persistenceProvider,
    model: scriptedWaitModel(() => []),
    eventWaitSources: observationSources(async () => {
      sourceReads++;
      return { kind: 'pending' };
    }),
    onEvaluate: () => {
      if (++evaluations > 1)
        return '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"verified"}';
      deadlineAt = Date.now() + 100;
      return JSON.stringify({
        met: false,
        impossible: false,
        progress: true,
        waiting: true,
        reason: 'Wait briefly',
        waitingCondition: { ...naturalCondition, deadlineAt },
      });
    },
  });
  try {
    await startEventWait(f);
    await registering.promise;
    assert.deepEqual(
      (await f.stores.eventWaitStore.listAny({ sessionId: f.sessionId, limit: 10 })).items,
      [],
    );
    await waitFor(() => Date.now() >= deadlineAt);
    releaseRegistration.resolve();
    await f.waitForGoalStatus('achieved');
    const rows = (
      await f.stores.eventWaitStore.listAny({
        sessionId: f.sessionId,
        consumerKind: 'goal_waiting',
        limit: 10,
      })
    ).items;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.record.deadlineAt, deadlineAt);
    assert.equal(rows[0]!.record.status, 'expired');
    assert.equal(rows[0]!.record.delivery?.kind, 'admitted');
    assert.equal(sourceReads, 0);
    assert.equal(evaluations, 2);
    assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
  } finally {
    releaseRegistration.resolve();
    await f.close();
  }
});

for (const control of ['new Turn', 'clear', 'drain'] as const)
  test(`natural initial authorization releases Root and respects ${control}`, {
    timeout: 15_000,
  }, async () => {
    const entered = deferred(),
      release = deferred();
    let evaluations = 0;
    const f = await createFixture({
      model: scriptedWaitModel(() => []),
      eventWaitSources: {
        ...observationSources(async () => assert.fail('The superseded source must not be read')),
        authorize: async () => {
          entered.resolve();
          await release.promise;
          return { kind: 'allowed', context: null };
        },
      },
      onEvaluate: () =>
        ++evaluations === 1
          ? JSON.stringify({
              met: false,
              impossible: false,
              progress: true,
              waiting: true,
              reason: 'Wait for the source',
              waitingCondition: naturalCondition,
            })
          : '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"New work completed"}',
    });
    try {
      await startEventWait(f);
      await entered.promise;
      await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle');
      const original = (await f.goalStore.read(f.sessionId))!.record.pendingContinuation;
      assert.equal(original?.observationPreparation, 'pending');
      if (control === 'new Turn') {
        const reply = await f.messages.handlers['turn.message.submit'](
          {
            originHostEpoch: 'goal-root-epoch',
            sessionId: f.sessionId,
            messageId: 'work-during-source-authorization',
            content: { text: 'Use this newer result' },
            placement: 'current_turn',
          },
          operationContext(),
        );
        assert.equal(reply.ok, true);
        await f.waitForGoalStatus('achieved');
      } else if (control === 'clear') {
        f.goal.manager.clear(f.sessionId);
        await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
      } else {
        f.goalExecutions.beginDrain();
        f.goal.beginDrain();
      }
      release.resolve();
      await f.goal.goalWaitingBridge!.close();
      const current = (await f.goalStore.read(f.sessionId))!.record;
      assert.equal(
        current.goal.status,
        control === 'new Turn' ? 'achieved' : control === 'clear' ? 'cleared' : 'waiting',
      );
      if (control === 'drain') assert.deepEqual(current.pendingContinuation, original);
      else assert.equal(current.pendingContinuation, null);
      assert.deepEqual(
        (await f.stores.eventWaitStore.listAny({ sessionId: f.sessionId, limit: 10 })).items,
        [],
      );
      const admissions = await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
        f.sessionId,
      );
      assert.equal(admissions.length, control === 'new Turn' ? 2 : 1);
      assert.ok(admissions.every((a) => a.execution.kind === 'external_message'));
      assert.equal(evaluations, control === 'new Turn' ? 2 : 1);
      assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
    } finally {
      release.resolve();
      await f.close();
    }
  });

for (const provider of ['local', 'memory'] as const)
  for (const rejection of ['missing', 'user visibility'] as const)
    test(`natural initial source rejection retains waiting backoff (${provider}, ${rejection})`, {
      timeout: 15_000,
    }, async () => {
      let f: Fixture;
      let shellStore: Awaited<ReturnType<typeof openInteractiveShellRunStoreForWrite>>;
      let evaluations = 0,
        evaluatedAt = 0,
        resumedAt = 0;
      const access = new ShellRunEventWaitAccess(
        { readShellRun: (...args) => shellStore.readShellRun(...args) },
        {
          readRunInvocation: (...args) => f.stores.runtimeEventStore.readRunInvocation(...args),
          readToolProvenanceEvents: (...args) =>
            f.stores.runtimeEventStore.readToolProvenanceEvents(...args),
        },
      );
      const adapter = new ShellRunEventWaitAdapter(access, {
        subscribeChanges() {
          assert.fail('A rejected initial source must not be observed');
        },
      });
      f = await createFixture({
        persistenceProvider:
          provider === 'local' ? 'local' : createMemoryExecutionPersistenceProvider(),
        model: scriptedWaitModel(() => []),
        eventWaitSources: {
          adapters: new EventWaitAdapterRegistry([adapter]),
          authorize: (wait, signal) => access.authorize(wait, signal),
        },
        onEvaluate: () => {
          if (++evaluations > 1) {
            resumedAt = Date.now();
            return '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"verified"}';
          }
          evaluatedAt = Date.now();
          return JSON.stringify({
            met: false,
            impossible: false,
            progress: true,
            waiting: true,
            reason: 'Wait for the referenced job',
            waitingCondition: {
              resource: {
                providerId: 'shell_run',
                resourceType: 'background_task',
                connectionId: null,
                resourceId: 'maka://runtime/background-tasks/rejected-task',
              },
              condition: { typeId: 'terminal', version: 1, parameters: {} },
              deadlineAt: null,
            },
          });
        },
      });
      shellStore = await openInteractiveShellRunStoreForWrite(f.owner.lease);
      try {
        if (rejection === 'user visibility') {
          const at = Date.now();
          await shellStore.createShellRun({
            sessionId: f.sessionId,
            shellRunId: 'rejected-task',
            sourceRunId: 'user-run',
            sourceTurnId: 'user-turn',
            sourceToolCallId: 'user-shell',
            visibility: 'user',
            cwd: f.owner.capability.canonicalPath,
            command: 'private user terminal',
            status: 'running',
            startedAt: at,
            updatedAt: at,
            revision: 1,
            output: {
              mode: 'pipes',
              stdout: 'private output',
              stderr: '',
              stdoutTruncated: false,
              stderrTruncated: false,
              redacted: false,
            },
          });
        }
        await startEventWait(f);
        await waitFor(async () => {
          const state = (await f.goalStore.read(f.sessionId))!.record;
          return (
            state.goal.status === 'achieved' ||
            (!!state.pendingContinuation &&
              !state.pendingContinuation.observation &&
              !state.currentExecution)
          );
        });
        const state = (await f.goalStore.read(f.sessionId))!.record;
        assert.equal(state.goal.status, 'waiting');
        assert.equal(state.goal.iterations, 1);
        assert.equal(evaluations, 1);
        assert.equal(state.pendingContinuation?.observation, undefined);
        assert.match(
          state.pendingContinuation!.prompt,
          rejection === 'missing' ? /shell_run_missing/ : /shell_run_access_revoked/,
        );
        assert.deepEqual(
          (await f.stores.eventWaitStore.listAny({ sessionId: f.sessionId, limit: 10 })).items,
          [],
        );
        assert.equal(
          (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
          1,
        );
        await f.waitForGoalStatus('achieved');
        assert.ok(resumedAt - evaluatedAt >= 5_000, 'Only the normal waiting timer may resume');
        assert.equal(evaluations, 2);
        assert.equal(
          (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
          2,
        );
        assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
      } finally {
        await f.close();
        await shellStore.close();
      }
    });

for (const unavailable of ['authorization unknown', 'shared capacity'] as const)
  test(`natural waiting keeps ${unavailable} in its preparation outbox`, {
    timeout: 15_000,
  }, async () => {
    let allowed = unavailable === 'shared capacity',
      evaluations = 0,
      sourceReads = 0;
    const sources: HostEventWaitSources = {
      ...observationSources(async () => {
        sourceReads++;
        return { kind: 'satisfied', receiptKey: 'done', evidenceRefs: [] };
      }),
      policy: {
        minIntervalMs: 1,
        pollIntervalMs: 5,
        jitterRatio: 0,
        maxConcurrent: 1,
        maxPerSource: 1,
      },
      authorize: async () =>
        allowed
          ? { kind: 'allowed', context: null }
          : { kind: 'unknown', reason: 'temporarily_unavailable' },
    };
    const f = await createFixture({
      model: scriptedWaitModel(() => []),
      eventWaitSources: sources,
      onEvaluate: () =>
        ++evaluations === 1
          ? JSON.stringify({
              met: false,
              impossible: false,
              progress: true,
              waiting: true,
              reason: 'Waiting for job',
              waitingCondition: naturalCondition,
            })
          : '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"verified"}',
    });
    const capacityEntered = deferred(),
      releaseCapacity = deferred();
    const accessAbort = new AbortController();
    let capacity: Promise<unknown> | undefined;
    try {
      if (unavailable === 'shared capacity') {
        const at = Date.now();
        const heldWait = decodeAnyEventWaitRecord({
          schemaVersion: 2,
          waitId: 'held-wait',
          sessionId: f.sessionId,
          sourceTurnId: 'held-turn',
          consumer: {
            kind: 'tool_invocation',
            runId: 'held-run',
            invocationId: 'held-invocation',
            operationId: 'held-operation',
            toolCallId: 'held-call',
          },
          ...naturalCondition,
          deliveryKey: 'event-wait/held-wait',
          createdAt: at,
          updatedAt: at,
          status: 'waiting',
        });
        capacity = f.waitObserver!.checkSourceAccess(heldWait, accessAbort.signal, async () => {
          capacityEntered.resolve();
          await releaseCapacity.promise;
          return { kind: 'allowed', context: null };
        });
        await capacityEntered.promise;
      }
      await startEventWait(f);
      await waitFor(async () => {
        const state = (await f.goalStore.read(f.sessionId))!.record;
        return (
          state.pendingContinuation?.observationPreparation === 'pending' &&
          f.coordinator.readRootState(f.sessionId).kind === 'idle'
        );
      });
      const authority = (await f.goalStore.read(f.sessionId))!.record;
      assert.equal(authority.goal.status, 'waiting');
      assert.ok(authority.pendingContinuation?.observation);
      const originalObservation = authority.pendingContinuation.observation;
      assert.deepEqual(
        (await f.stores.eventWaitStore.listAny({ sessionId: f.sessionId, limit: 10 })).items,
        [],
      );
      assert.equal(evaluations, 1);
      assert.equal(sourceReads, 0);
      assert.equal(
        (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
        1,
      );
      allowed = true;
      releaseCapacity.resolve();
      await capacity;
      await f.waitObserver!.reconcile();
      await f.waitForGoalStatus('achieved');
      const registered = (
        await f.stores.eventWaitStore.listAny({ sessionId: f.sessionId, limit: 10 })
      ).items;
      assert.equal(registered.length, 1);
      assert.equal(registered[0]!.record.waitId, originalObservation.waitId);
      assert.equal(registered[0]!.record.deadlineAt, originalObservation.deadlineAt);
      assert.equal(evaluations, 2);
      assert.equal(sourceReads, 1);
      assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
    } finally {
      releaseCapacity.resolve();
      accessAbort.abort();
      await capacity;
      await f.close();
    }
  });

test('Session cancel targets one original invocation after Goal clear and rejects stale proof', {
  timeout: 15_000,
}, async () => {
  let satisfied = false,
    modelCalls = 0;
  const f = await createFixture({
    model: scriptedWaitModel(
      (call) => (call === 1 ? ['wait-a', 'wait-b'] : []),
      (call) => {
        modelCalls = call;
      },
    ),
    eventWaitSources: observationSources(async () =>
      satisfied ? { kind: 'satisfied', receiptKey: 'done', evidenceRefs: [] } : { kind: 'pending' },
    ),
  });
  try {
    await startEventWait(f);
    await waitFor(async () => (await f.goal.readEventWaits(f.sessionId)).items.length === 2);
    f.goal.manager.clear(f.sessionId);
    await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
    const page = await f.goal.readEventWaits(f.sessionId);
    assert.equal(page.items.length, 2);
    const target = page.items[0]!;
    assert.equal(target.consumer.kind, 'tool_invocation');
    if (target.consumer.kind !== 'tool_invocation') throw new Error('wrong consumer');
    const stale = await f.goal.handlers['session.event-wait.cancel'](
      {
        sessionId: f.sessionId,
        waitId: target.waitId,
        consumer: { ...target.consumer, operationId: 'a-different-operation' },
      },
      operationContext(),
    );
    assert.ok(stale.ok && stale.result.outcome === 'conflict');
    const cancelled = await f.goal.handlers['session.event-wait.cancel'](
      {
        sessionId: f.sessionId,
        waitId: target.waitId,
        consumer: target.consumer,
      },
      operationContext(),
    );
    assert.ok(cancelled.ok && cancelled.result.outcome === 'cancelled');
    const other = page.items[1]!;
    assert.equal(
      (await f.stores.eventWaitStore.readAny({ sessionId: f.sessionId, waitId: other.waitId }))
        ?.record.status,
      'waiting',
    );
    assert.equal(modelCalls, 1, 'one cancelled wait does not finish its pending parallel peer');
    satisfied = true;
    await f.waitObserver!.reconcile();
    const admissions = await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId);
    await waitFor(
      async () =>
        !!(await f.stores.runtimeEventStore.readRunInvocation(f.sessionId, admissions[0]!.runId))
          ?.terminalEvent,
    );
    await f.invocationWaits!.reconcile();
    await Promise.all(
      page.items.map(({ waitId }) => waitForInvocationDelivery(f, waitId, 'consumed')),
    );
    const rows = (
      await f.stores.eventWaitStore.listAny({
        sessionId: f.sessionId,
        consumerKind: 'tool_invocation',
        limit: 10,
      })
    ).items;
    assert.equal(rows.length, 2);
    assert.equal(
      rows.find((row) => row.record.waitId === target.waitId)?.record.status,
      'cancelled',
    );
    assert.equal(rows.find((row) => row.record.waitId === other.waitId)?.record.status, 'resolved');
    assert.ok(rows.every((row) => row.record.delivery?.kind === 'consumed'));
    assert.equal(
      (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
      1,
    );
    assert.equal(f.goal.manager.get(f.sessionId)?.status, 'cleared');
    assert.equal(modelCalls, 2);
    assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
  } finally {
    await f.close();
  }
});

for (const provider of ['local', 'memory'] as const)
  test(`expired natural wait cancellation preserves pending admission (${provider})`, {
    timeout: 15_000,
  }, async () => {
    let now = Date.now();
    let deadlineAt = now + 500;
    let evaluations = 0;
    const firstRead = deferred();
    const f = await createFixture({
      persistenceProvider:
        provider === 'local' ? 'local' : createMemoryExecutionPersistenceProvider(),
      model: scriptedWaitModel(() => []),
      eventWaitSources: {
        ...observationSources(async () => {
          firstRead.resolve();
          return { kind: 'pending' };
        }),
        clock: {
          now: () => now,
          schedule(callback, delay) {
            const timer = setTimeout(callback, delay);
            timer.unref();
            return () => clearTimeout(timer);
          },
        },
      },
      onEvaluate: () => {
        now = Date.now();
        deadlineAt = now + 500;
        return ++evaluations === 1
          ? JSON.stringify({
              met: false,
              impossible: false,
              progress: true,
              waiting: true,
              reason: 'Wait briefly',
              waitingCondition: { ...naturalCondition, deadlineAt },
            })
          : '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"verified"}';
      },
    });
    let reservation: ReturnType<RootTurnCoordinator['prepare']> | undefined;
    try {
      await startEventWait(f);
      await firstRead.promise;
      await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle');
      reservation = f.coordinator.prepare(f.sessionId);
      assert.equal(reservation.kind, 'prepared');
      now = deadlineAt;
      await f.waitObserver!.reconcile();
      await waitFor(
        async () =>
          (
            await f.stores.eventWaitStore.listAny({
              sessionId: f.sessionId,
              limit: 10,
            })
          ).items[0]?.record.status === 'expired',
      );
      await f.goal.goalWaitingBridge!.reconcile();
      const { sessionId, waitId, consumer } = (await f.goal.readEventWaits(f.sessionId)).items[0]!;
      const result = await f.goal.handlers['session.event-wait.cancel'](
        { sessionId, waitId, consumer },
        operationContext(),
      );
      assert.ok(result.ok && result.result.outcome === 'conflict');
      const expired = (await f.stores.eventWaitStore.readAny({ sessionId, waitId }))!.record;
      assert.equal(expired.status, 'expired');
      assert.equal(expired.delivery, undefined);
      if (reservation.kind === 'prepared') reservation.admission.release();
      await f.waitForGoalStatus('achieved');
      const admitted = (await f.stores.eventWaitStore.readAny({ sessionId, waitId }))!.record;
      assert.equal(admitted.status, 'expired');
      assert.equal(admitted.delivery?.kind, 'admitted');
      assert.equal(
        (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(sessionId)).length,
        2,
      );
      assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
    } finally {
      if (reservation?.kind === 'prepared') reservation.admission.release();
      await f.close();
    }
  });

for (const count of [2, 66])
  test(`durable wait consumption invalidates the collection with ${count} parallel waits`, {
    timeout: 30_000,
  }, async () => {
    let completedOperation: string | undefined;
    const notifications = new Map<string, () => void>();
    const observed = new Set<string>();
    const deliveryGate = deferred<void>();
    const f = await createFixture({
      onEventWaitChanged: (wait) => {
        if (wait.observation?.lastObservedAt != null) observed.add(wait.waitId);
      },
      model: scriptedWaitModel((call) =>
        call === 1 ? Array.from({ length: count }, (_, i) => `page-call-${i}`) : [],
      ),
      eventWaitSources: {
        authorize: async (wait) => {
          if (wait.status === 'resolved') await deliveryGate.promise;
          return { kind: 'allowed', context: null };
        },
        policy: { scanIntervalMs: 1, minIntervalMs: 1, pollIntervalMs: 60_000, jitterRatio: 0 },
        adapters: new EventWaitAdapterRegistry([
          {
            providerId: 'test',
            resourceType: 'job',
            conditionType: 'done',
            conditionVersion: 1,
            reconciliation: 'snapshot',
            validate() {},
            async subscribe({ wait }, changed) {
              notifications.set(wait.waitId, changed);
              return {
                close() {
                  notifications.delete(wait.waitId);
                },
              };
            },
            async read({ wait }) {
              return wait.schemaVersion === 2 &&
                wait.consumer.kind === 'tool_invocation' &&
                wait.consumer.operationId === completedOperation
                ? { kind: 'satisfied', receiptKey: 'done', evidenceRefs: ['done-ref'] }
                : { kind: 'pending' };
            },
          },
        ]),
      },
    });
    const frames: SubscriptionFrame[] = [];
    const connection = f.continuity.attachConnection('connection-1', {
      async send(frame) {
        frames.push(frame);
      },
    });
    try {
      await startEventWait(f);
      await waitFor(() => observed.size === count, { timeoutMs: 10_000 });
      const context = { ...operationContext(), principalKind: 'local_owner' as const };
      const opened = await f.continuity.handlers['subscription.open'](
        { sessionId: f.sessionId, transcript: { kind: 'none' } },
        context,
      );
      assert.ok(opened.ok);
      await f.continuity.handlers['subscription.ready'](
        { subscriptionId: opened.result.subscriptionId },
        context,
      );
      const first = opened.result.snapshot.eventWaits!;
      const last = first.nextCursor
        ? await f.goal.readEventWaits(f.sessionId, first.nextCursor)
        : first;
      const target = last.items.at(-1)!;
      assert.equal(target.consumer.kind, 'tool_invocation');
      if (target.consumer.kind !== 'tool_invocation') return;
      completedOperation = target.consumer.operationId;
      assert.ok(notifications.has(target.waitId));
      notifications.get(target.waitId)!();
      const snapshots = () =>
        frames
          .filter((frame) => frame.kind === 'subscription.session_projection')
          .map((frame) => frame.snapshot);
      await waitFor(
        async () =>
          (await f.stores.eventWaitStore.readAny({ sessionId: f.sessionId, waitId: target.waitId }))
            ?.record.status === 'resolved',
      );
      if (count === 2)
        await waitFor(() =>
          snapshots().some((s) =>
            s.eventWaits?.items.some(
              (w) => w.waitId === target.waitId && w.phase === 'result_ready',
            ),
          ),
        );
      // Drain the pre-T2 publication lane, so the next invalidation must cover consumption.
      await f.continuity.refreshCanonical(f.sessionId);
      frames.length = 0;
      deliveryGate.resolve();
      await waitFor(
        async () =>
          (await f.stores.eventWaitStore.readAny({ sessionId: f.sessionId, waitId: target.waitId }))
            ?.record.delivery?.kind === 'consumed',
      );
      await waitFor(() =>
        frames.some(
          (frame) =>
            frame.kind === 'subscription.session_domain_changed' && frame.domain === 'event_wait',
        ),
      );
      const after = await f.goal.readEventWaits(f.sessionId);
      if (count === 66) {
        assert.deepEqual(
          { items: after.items, nextCursor: after.nextCursor },
          first,
          'later-page changes leave the bounded continuity page unchanged',
        );
        assert.equal((await f.goal.readEventWaits(f.sessionId, after.nextCursor!)).items.length, 1);
      } else {
        await waitFor(() => snapshots().at(-1)?.eventWaits?.items.length === 1);
        assert.equal(
          snapshots()
            .at(-1)!
            .eventWaits!.items.some((w) => w.waitId === target.waitId),
          false,
        );
      }
      assert.equal(
        (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
        1,
      );
      assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
    } finally {
      deliveryGate.resolve();
      connection.close();
      await f.coordinator.stopSession(f.sessionId);
      await f.close();
    }
  });

for (const provider of ['local', 'memory'] as const)
  test(`pending waits preserve an accepted queue when the continuity preview exceeds capacity (${provider})`, {
    timeout: 30_000,
  }, async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const f = await createFixture({
      persistenceProvider:
        provider === 'local' ? 'local' : createMemoryExecutionPersistenceProvider(),
      model: scriptedWaitModel(
        (call) => (call === 1 ? Array.from({ length: 64 }, (_, i) => `capacity-${i}`) : []),
        async (call) => {
          if (call === 1) {
            entered.resolve();
            await release.promise;
          }
        },
      ),
      eventWaitSources: observationSources(async () => ({ kind: 'pending' })),
    });
    const frames: SubscriptionFrame[] = [];
    const connection = f.continuity.attachConnection('connection-1', {
      async send(frame) {
        frames.push(frame);
      },
    });
    try {
      await startEventWait(f);
      await entered.promise;
      const text = 'x'.repeat(33_000);
      const queued = await f.messages.handlers['turn.message.submit'](
        {
          originHostEpoch: 'goal-root-epoch',
          sessionId: f.sessionId,
          messageId: 'large-next-turn',
          placement: 'next_turn',
          content: { text },
        },
        operationContext(),
      );
      assert.ok(queued.ok);
      const context = { ...operationContext(), principalKind: 'local_owner' as const };
      const opened = await f.continuity.handlers['subscription.open'](
        { sessionId: f.sessionId, transcript: { kind: 'none' } },
        context,
      );
      assert.ok(opened.ok);
      await f.continuity.handlers['subscription.ready'](
        { subscriptionId: opened.result.subscriptionId },
        context,
      );
      release.resolve();
      await waitFor(async () => (await f.goal.readEventWaits(f.sessionId)).items.length === 64, {
        timeoutMs: 10_000,
        pollMs: 10,
      });
      await f.continuity.refreshCanonical(f.sessionId);
      const latest = frames
        .filter((frame) => frame.kind === 'subscription.session_projection')
        .at(-1)!.snapshot;
      assert.equal(latest.eventWaits, undefined, 'only the optional cache is omitted');
      assert.equal(latest.queue.followup[0]?.content.text, text);
      const queried = await f.goal.handlers['session.event-waits.query'](
        { sessionId: f.sessionId },
        context,
      );
      assert.ok(queried.ok);
      assert.equal(queried.result.items.length, 64, 'all consumers remain independently queryable');
      const target = queried.result.items.at(-1)!;
      const cancelled = await f.goal.handlers['session.event-wait.cancel'](
        { sessionId: f.sessionId, waitId: target.waitId, consumer: target.consumer },
        context,
      );
      assert.ok(cancelled.ok && cancelled.result.outcome === 'cancelled');
      await waitFor(
        async () =>
          (await f.stores.eventWaitStore.readAny({ sessionId: f.sessionId, waitId: target.waitId }))
            ?.record.delivery?.kind === 'consumed',
      );
      await f.continuity.refreshCanonical(f.sessionId);
      assert.equal((await f.goal.readEventWaits(f.sessionId)).items.length, 63);
      assert.equal(
        (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
        1,
      );
      assert.equal(f.drainRequested(), false, f.errors.map(String).join('\n'));
    } finally {
      release.resolve();
      connection.close();
      await f.coordinator.stopSession(f.sessionId);
      await f.close();
    }
  });
