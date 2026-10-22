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

import { createRunCompositionSnapshot } from '@maka/core/run-composition';
import { readLogicalRuntimeExecution } from '@maka/core/runtime-logical-execution';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import { createMemoryExecutionPersistenceProvider } from '@maka/storage/test-only/memory-execution-persistence';
import type { ExecutionPersistenceProvider } from '@maka/storage/execution-persistence-provider';
import type { RootTurnAdmission } from '@maka/storage/agent-run-store';
import { openInteractiveEventWaitAuthorityForWrite } from '@maka/storage/event-wait-authority';
import { deferred, withTimeout } from '@maka/core/test-only/async-primitives';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { AiSdkBackend } from '@maka/runtime/ai-sdk-backend';
import { buildBuiltinTools } from '@maka/runtime/builtin-tools';
import { ShellRunProcessManager } from '@maka/runtime/shell-run-manager';
import { defaultShellPlan } from '@maka/runtime/shell-detect';
import { openInteractiveShellRunStoreForWrite } from '@maka/storage/shell-run-authority';
import { ShellRunEventWaitAccess } from '../server/shell-run-event-wait-access.js';
import { ShellRunEventWaitAdapter } from '../server/shell-run-event-wait-adapter.js';
import { createExternalExecutionBoundary } from '@maka/core/sandbox-boundary';
import { EventWaitAdapterRegistry } from '../server/event-wait-adapter.js';
import type { HostGoalEventWaitSources } from '../server/goal-event-waits.js';
import { waitFor } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';
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
  readonly shellRuns?: ShellRunProcessManager;
  readonly shellStore?: Awaited<ReturnType<typeof openInteractiveShellRunStoreForWrite>>;
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
    sessionId?: string;
    recoverAdmissions?: boolean;
    persistenceProvider?: ExecutionPersistenceProvider | 'local';
    registerBackend?: (backends: BackendRegistry) => void;
    model?: MockLanguageModelV4;
    eventWaitSources?: HostGoalEventWaitSources;
    shellRuns?: boolean;
    shellRunWaitReader?: Pick<NonNullable<Fixture['shellStore']>, 'readShellRun'>;
    onEvaluate?: () => unknown;
    onGoalProjection?: (goal: HostGoalCoordinator, sessionId: string) => void;
    afterWaitMutation?: (stage: 'register' | 'settle' | 'queue') => Promise<void>;
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
    options.persistenceProvider === 'local'
      ? undefined
      : (options.persistenceProvider ??
        (options.afterWaitMutation ? createMemoryExecutionPersistenceProvider() : undefined));
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
  const shellStore = options.shellRuns
    ? await openInteractiveShellRunStoreForWrite(owner.lease)
    : undefined;
  const shellRuns = shellStore
    ? new ShellRunProcessManager({ store: shellStore, newId: randomUUID, now: Date.now })
    : undefined;
  const shellAccess = shellStore
    ? new ShellRunEventWaitAccess(
        options.shellRunWaitReader ?? shellStore,
        stores.runtimeEventStore,
      )
    : undefined;
  const waitSources =
    options.eventWaitSources ??
    (shellRuns && shellAccess
      ? {
          adapters: new EventWaitAdapterRegistry([
            new ShellRunEventWaitAdapter(shellAccess, shellRuns),
          ]),
          authorize: (wait: import('@maka/core/event-wait').EventWaitRecord, signal: AbortSignal) =>
            shellAccess.authorize(wait, signal),
          policy: { minIntervalMs: 10, pollIntervalMs: 30, jitterRatio: 0 },
        }
      : undefined);
  const waits = stores.eventWaitStore;
  const goalStores = options.afterWaitMutation
    ? {
        ...stores,
        eventWaitStore: await openInteractiveEventWaitAuthorityForWrite(owner.lease, {
          read: waits.read.bind(waits),
          listPending: waits.listPending.bind(waits),
          listSession: waits.listSession.bind(waits),
          listForObservation: waits.listForObservation.bind(waits),
          listByStatus: waits.listByStatus.bind(waits),
          readSourceCooldown: waits.readSourceCooldown.bind(waits),
          extendSourceCooldown: waits.extendSourceCooldown.bind(waits),
          reserveSourceDispatch: waits.reserveSourceDispatch.bind(waits),
          completeSourceDispatch: waits.completeSourceDispatch.bind(waits),
          commit: waits.commit.bind(waits),
          close() {},
          registerGoalWait: async (registration) => {
            const result = await waits.registerGoalWait(registration);
            await options.afterWaitMutation!('register');
            return result;
          },
          settleGoalWait: async (settlement) => {
            const result = await waits.settleGoalWait(settlement);
            await options.afterWaitMutation!('settle');
            return result;
          },
          queueGoalWait: async (queue) => {
            const result = await waits.queueGoalWait(queue);
            await options.afterWaitMutation!('queue');
            return result;
          },
        }),
      }
    : stores;
  const goalStore = await openInteractiveGoalAuthorityForWrite(owner.lease);
  const session = options.sessionId
    ? await stores.sessionStore.readHeaderSnapshot(options.sessionId)
    : await stores.sessionStore.create({
        cwd: capability.canonicalPath,
        llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: options.shellRuns ? 'bypass' : 'ask',
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
  let requestedDrain = false;
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
              ...(shellRuns
                ? buildBuiltinTools({
                    shellRuns,
                    runtimeResources: shellRuns,
                    backgroundTasks: shellRuns,
                    ptyControls: shellRuns,
                    declareSandboxBoundary: false,
                  })
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
    bindRun: (identity) => messages.bindRun(identity),
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
    authorizeEventWait: async (sessionId, pending) =>
      (await requireGoal(goal).eventWaitBridge?.authorizeAdmission(sessionId, pending)) ?? false,
    executions: rootCoordinator,
    runtime: manager,
    matchesActive: (sessionId, checkpoint, controlLease) =>
      requireGoal(goal).matchesActive(sessionId, checkpoint, controlLease),
    newId: randomUUID,
  });
  goal = new HostGoalCoordinator({
    ...(waitSources ? { eventWaitSources: waitSources } : {}),
    store: goalStore,
    stores: goalStores,
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
    admitTurn: (sessionId, text, checkpoint, controlLease, eventWait) =>
      goalExecutions.admitTurn(sessionId, text, checkpoint, controlLease, eventWait),
    acquireResidency,
    onProjectionChanged: (sessionId) => {
      requireContinuity(continuity).enqueueCanonicalRefresh(sessionId);
      for (const listener of goalChangeListeners) listener();
      if (goal) options.onGoalProjection?.(goal, sessionId);
    },
    requestDrain: () => {
      requestedDrain = true;
    },
  });
  await goal.prepareRecovery();
  const goalCoordinator = goal;

  return {
    ...(shellRuns ? { shellRuns, shellStore: shellStore! } : {}),
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
      } finally {
        if (goalStores !== stores) await goalStores.eventWaitStore.close();
        await rootCoordinator.close();
        await messages.close();
        await interactions.close();
        continuity?.close();
        await shellRuns?.terminateAll();
        await shellStore?.close();
        await goalStore.close();
        await stores.sessionStore.close?.();
        await owner.close();
        await rm(base, { recursive: true, force: true });
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

for (const [alreadySatisfied, busy, deferAccess, cancel] of [
  [false, false, false, false],
  [true, false, false, false],
  [false, true, false, false],
  [false, false, true, false],
  [false, false, false, true],
])
  test(`event wait yields through real Root admission (alreadySatisfied=${alreadySatisfied}, busy=${busy}, deferred=${deferAccess}, cancel=${cancel})`, {
    timeout: 15000,
  }, async () => {
    let modelCalls = 0,
      evaluatorCalls = 0,
      observations = 0;
    let releaseUser!: () => void;
    const userBarrier = new Promise<void>((resolve) => {
      releaseUser = resolve;
    });
    let resultAuthorizations = 0;
    const sources: HostGoalEventWaitSources = {
      adapters: new EventWaitAdapterRegistry([
        {
          providerId: 'test',
          resourceType: 'job',
          conditionType: 'done',
          conditionVersion: 1,
          reconciliation: 'snapshot',
          validate() {},
          read: async () => {
            observations++;
            return alreadySatisfied
              ? { kind: 'satisfied', receiptKey: 'receipt', evidenceRefs: ['ref'] }
              : { kind: 'pending' };
          },
        },
      ]),
      authorize: async (wait) => {
        if (deferAccess && wait.status === 'resolved' && ++resultAuthorizations === 2)
          return { kind: 'unknown', reason: 'temporarily unavailable' };
        return { kind: 'allowed', context: null };
      },
    };
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCalls++;
        if (busy && modelCalls === 2) await userBarrier;
        return {
          stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
            { type: 'stream-start', warnings: [] },
            ...(modelCalls === 1
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'wait-call',
                    toolName: 'WaitForEvent',
                    input: JSON.stringify({
                      resource: {
                        providerId: 'test',
                        connectionId: null,
                        resourceType: 'job',
                        resourceId: 'job',
                      },
                      condition: { typeId: 'done', version: 1, parameters: {} },
                      reason: 'Waiting for the job',
                      timeoutMs: 60000,
                    }),
                  },
                ]
              : []),
            {
              type: 'finish',
              finishReason: { unified: modelCalls === 1 ? 'tool-calls' : 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 2, text: 2, reasoning: 0 },
              },
            },
          ]),
        };
      },
    });
    let sourceSettlement: { iterations: number; models: number; evaluations: number } | undefined;
    const f = await createFixture({
      onGoalProjection: (coordinator, sessionId) => {
        const g = coordinator.manager.get(sessionId);
        if (g?.iterations === 1 && !sourceSettlement)
          sourceSettlement = {
            iterations: g.iterations,
            models: modelCalls,
            evaluations: evaluatorCalls,
          };
      },
      model,
      eventWaitSources: sources,
      onEvaluate: () => evaluatorCalls++,
    });
    try {
      await f.goal.recover();
      f.goal.manager.create(f.sessionId, 'Wait for the job and verify its result', { armed: true });
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
      await waitFor(
        async () => {
          if (sourceSettlement) return true;
          const a = await f.goalStore.read(f.sessionId);
          if (a?.record.goal.status === 'paused' || a?.record.goal.status === 'achieved')
            throw new Error(
              JSON.stringify({
                authority: a,
                modelCalls,
                runs: await f.stores.runtimeEventStore.listSessionInvocations(f.sessionId),
              }),
            );
          return !!a?.record.activeEventWait?.settled;
        },
        { timeoutMs: 5000 },
      );
      assert.deepEqual(sourceSettlement, { iterations: 1, models: 1, evaluations: 0 });
      if (!alreadySatisfied) {
        assert.equal(modelCalls, 1);
        assert.equal(evaluatorCalls, 0);
      }
      assert.equal(f.goal.manager.get(f.sessionId)?.iterations, 1);
      await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle', {
        timeoutMs: 5000,
      });
      const wait = (
        await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 })
      ).items[0]!;
      const source = (await f.stores.runtimeEventStore.listSessionInvocations(f.sessionId)).find(
        (r) => r.turnId === wait.record.sourceTurnId,
      )!;
      assert.equal(source.terminalEvent?.actions?.stateDelta?.stopReason, 'event_wait');
      if (cancel) {
        const goal = f.goal.manager.get(f.sessionId)!;
        const result = await f.goal.handlers['goal.event-wait.cancel'](
          {
            sessionId: f.sessionId,
            goalId: goal.id,
            expectedGoalRevision: goal.revision,
            waitId: wait.record.waitId,
            controlGeneration: wait.record.goalControlLease.generation,
          },
          operationContext(),
        );
        assert.equal(result.ok && result.result.outcome, 'cancelled');
        for (let i = 0; i < 3; i++) await f.goal.eventWaitBridge!.reconcile();
        assert.equal(f.goal.manager.get(f.sessionId)?.status, 'paused');
        assert.equal(
          (
            await f.stores.eventWaitStore.read({
              sessionId: f.sessionId,
              waitId: wait.record.waitId,
            })
          )?.record.delivery?.kind,
          'suppressed',
        );
        assert.equal(modelCalls, 1);
        assert.equal(evaluatorCalls, 0);
        assert.equal(f.drainRequested(), false);
        return;
      }
      if (!alreadySatisfied) {
        await waitFor(() => observations > 0, { timeoutMs: 5000 });
        for (let i = 0; i < 4; i++) await f.goal.eventWaitBridge!.reconcile();
        assert.equal(modelCalls, 1);
        assert.equal(evaluatorCalls, 0);
        if (busy) {
          const user = await f.messages.handlers['turn.message.submit'](
            {
              originHostEpoch: 'goal-root-epoch',
              sessionId: f.sessionId,
              messageId: 'new-user-work',
              content: { text: 'New user work' },
              placement: 'current_turn',
            },
            operationContext(),
          );
          assert.equal(user.ok, true);
          await waitFor(() => modelCalls === 2, { timeoutMs: 5000 });
        }
        const current = (await f.stores.eventWaitStore.read({
          sessionId: f.sessionId,
          waitId: wait.record.waitId,
        }))!;
        const at = Math.max(Date.now(), current.record.updatedAt);
        await f.stores.eventWaitStore.commit({
          sessionId: f.sessionId,
          waitId: wait.record.waitId,
          expectedAuthorityRevision: current.authorityRevision,
          record: {
            ...current.record,
            status: 'resolved',
            updatedAt: at,
            resolvedAt: at,
            resolution: {
              outcome: 'satisfied',
              receiptKey: 'receipt',
              observedAt: at,
              evidenceRefs: ['ref'],
            },
          },
        });
      }
      await f.goal.eventWaitBridge!.reconcile();
      if (busy) {
        // Result authorization observes the source cooldown left by the last read.
        await waitFor(
          async () => !!(await f.goalStore.read(f.sessionId))?.record.pendingContinuation,
          { timeoutMs: 5000 },
        );
        const queued = (await f.goalStore.read(f.sessionId))!.record.pendingContinuation;
        assert.ok(queued?.eventWait);
        for (let i = 0; i < 3; i++) await f.goal.eventWaitBridge!.reconcile();
        assert.deepEqual((await f.goalStore.read(f.sessionId))!.record.pendingContinuation, queued);
        assert.equal(modelCalls, 2);
        assert.equal(evaluatorCalls, 0);
        releaseUser();
      }
      try {
        await f.waitForGoalStatus('achieved');
      } catch (error) {
        throw new Error(
          JSON.stringify({
            goal: await f.goalStore.read(f.sessionId),
            modelCalls,
            evaluatorCalls,
            observations,
            waits: await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 }),
            runs: await f.stores.runtimeEventStore.listSessionInvocations(f.sessionId),
            drain: f.drainRequested(),
          }),
          { cause: error },
        );
      }
      assert.equal(modelCalls, busy ? 3 : 2);
      assert.equal(evaluatorCalls, 1);
      if (deferAccess) assert.ok(resultAuthorizations >= 4);
      const delivered = (await f.stores.eventWaitStore.read({
        sessionId: f.sessionId,
        waitId: wait.record.waitId,
      }))!.record;
      assert.equal(delivered.delivery?.kind, 'admitted');
      for (let i = 0; i < 3; i++) await f.goal.eventWaitBridge!.reconcile();
      assert.equal(modelCalls, busy ? 3 : 2);
      const admissions = await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
        f.sessionId,
      );
      assert.equal(admissions.length, busy ? 3 : 2);
      const successor = admissions.find((a) => a.execution.kind === 'goal')!;
      assert.equal(
        successor.execution.kind === 'goal' && successor.execution.eventWait?.waitId,
        wait.record.waitId,
      );
      const next = await f.stores.runtimeEventStore.readRunInvocation(f.sessionId, successor.runId);
      assert.equal(
        next?.opening.root.kind === 'goal' && next.opening.root.eventWait?.waitId,
        wait.record.waitId,
      );
      assert.ok(observations > 0);
      assert.equal(f.drainRequested(), false);
    } finally {
      releaseUser();
      await f.close();
    }
  });

function eventWaitModel(onCall: () => unknown = () => {}, firstOnly = false, inputTokens = 10) {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const waits = !firstOnly || ++calls === 1;
      await onCall();
      return {
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'stream-start', warnings: [] },
          ...(waits
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: 'wait-call',
                  toolName: 'WaitForEvent',
                  input: JSON.stringify({
                    resource: {
                      providerId: 'test',
                      connectionId: null,
                      resourceType: 'job',
                      resourceId: 'job',
                    },
                    condition: { typeId: 'done', version: 1, parameters: {} },
                    reason: 'Waiting for the job',
                    timeoutMs: 60000,
                  }),
                },
              ]
            : []),
          {
            type: 'finish',
            finishReason: { unified: waits ? 'tool-calls' : 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: inputTokens,
                noCache: inputTokens,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
            },
          },
        ]),
      };
    },
  });
}
function eventWaitSources(
  authorize: HostGoalEventWaitSources['authorize'],
): HostGoalEventWaitSources {
  return {
    adapters: new EventWaitAdapterRegistry([
      {
        providerId: 'test',
        resourceType: 'job',
        conditionType: 'done',
        conditionVersion: 1,
        reconciliation: 'snapshot',
        validate() {},
        read: async () => ({ kind: 'pending' }),
      },
    ]),
    authorize,
  };
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

test('Goal drain stops event wait observation before waiting for close', async () => {
  const readEntered = deferred();
  const releaseRead = deferred();
  let readSignal: AbortSignal | undefined;
  let subscriptionsClosed = 0;
  let reads = 0;
  let modelCalls = 0;
  const f = await createFixture({
    model: eventWaitModel(() => modelCalls++),
    eventWaitSources: {
      authorize: async () => ({ kind: 'allowed', context: null }),
      adapters: new EventWaitAdapterRegistry([
        {
          providerId: 'test',
          resourceType: 'job',
          conditionType: 'done',
          conditionVersion: 1,
          reconciliation: 'snapshot',
          validate() {},
          subscribe: async () => ({
            close() {
              subscriptionsClosed++;
            },
          }),
          read: async ({ signal }) => {
            reads++;
            readSignal = signal;
            readEntered.resolve();
            await releaseRead.promise;
            return { kind: 'satisfied', receiptKey: 'late-terminal', evidenceRefs: [] };
          },
        },
      ]),
    },
  });
  try {
    await startEventWait(f);
    await readEntered.promise;
    await waitFor(
      async () => (await f.goalStore.read(f.sessionId))?.record.activeEventWait?.settled === true,
      { timeoutMs: 5000 },
    );
    await f.coordinator.whenIdle(f.sessionId);
    const before = (
      await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 })
    ).items[0]!;
    const callsBeforeDrain = modelCalls;

    // Host operation draining can delay close. Observation must stop at this
    // synchronous boundary, without turning shutdown into business cancellation.
    f.goal.beginDrain();
    f.goal.beginDrain();
    assert.equal(readSignal?.aborted, true);
    assert.equal(subscriptionsClosed, 1);
    releaseRead.resolve();
    await f.goal.close();

    const after = (await f.stores.eventWaitStore.read({
      sessionId: f.sessionId,
      waitId: before.record.waitId,
    }))!;
    assert.equal(after.record.status, 'waiting');
    assert.equal(after.record.observation?.attempts, before.record.observation?.attempts);
    assert.equal(after.record.delivery, undefined);
    assert.equal(reads, 1);
    assert.equal(modelCalls, callsBeforeDrain);
    assert.equal(subscriptionsClosed, 1);
  } finally {
    releaseRead.resolve();
    await f.close();
  }
});

test('observer cancellation releases the Goal gate without restarting work', async () => {
  let calls = 0,
    authorizations = 0;
  const f = await createFixture({
    model: eventWaitModel(() => calls++),
    eventWaitSources: eventWaitSources(async () =>
      ++authorizations === 1
        ? { kind: 'allowed', context: null }
        : { kind: 'revoked', reason: 'resource permission revoked' },
    ),
  });
  try {
    await startEventWait(f);
    await waitFor(
      async () =>
        (
          await f.stores.eventWaitStore.listSession({
            sessionId: f.sessionId,
            limit: 10,
          })
        ).items[0]?.record.status === 'cancelled',
      { timeoutMs: 5000 },
    );
    await f.goal.eventWaitBridge!.reconcile();
    const authority = (await f.goalStore.read(f.sessionId))!.record;
    assert.equal(authority.goal.status, 'paused');
    assert.equal(authority.activeEventWait, undefined);
    const wait = (await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 }))
      .items[0]!;
    assert.equal(wait.record.delivery?.kind, 'suppressed');
    for (let i = 0; i < 3; i++) await f.goal.eventWaitBridge!.reconcile();
    assert.equal(calls, 1);
    assert.equal(f.drainRequested(), false);
  } finally {
    await f.close();
  }
});

for (const action of ['pause', 'clear'] as const)
  test(`Goal ${action} acknowledgement waits for deferred durable control`, async () => {
    const entered = deferred(),
      release = deferred();
    const f = await createFixture({
      model: eventWaitModel(),
      eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
      afterWaitMutation: async (stage) => {
        if (stage !== 'register') return;
        entered.resolve();
        await release.promise;
      },
    });
    try {
      await startEventWait(f);
      await entered.promise;
      const before = f.goal.manager.get(f.sessionId)!;
      let returned = false;
      const control = f.goal.handlers['goal.control'](
        {
          sessionId: f.sessionId,
          goalId: before.id,
          expectedRevision: before.revision,
          action,
        },
        operationContext(),
      ).then((result) => {
        returned = true;
        return result;
      });
      // The control request is ordered after registration, including its live state change.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(returned, false, 'Control must not acknowledge while its write is deferred');
      assert.equal(f.goal.manager.get(f.sessionId)?.status, 'active');
      release.resolve();
      const response = await control;
      assert.equal(response.ok, true);
      const durable = (await f.goalStore.read(f.sessionId))!.record;
      assert.equal(durable.goal.status, action === 'pause' ? 'paused' : 'cleared');
      assert.equal(durable.controlLease.generation, 1);
      assert.equal(durable.activeEventWait, undefined);
      assert.equal(f.drainRequested(), false);
    } finally {
      release.resolve();
      await f.close();
    }
  });

test('bridge result scans honor source Retry-After without admitting or charging work', {
  timeout: 10000,
}, async () => {
  let calls = 0,
    resultAuthorizations = 0,
    throttledAt = 0;
  const f = await createFixture({
    model: eventWaitModel(() => calls++),
    eventWaitSources: eventWaitSources(async (wait) => {
      if (wait.status !== 'resolved') return { kind: 'allowed', context: null };
      resultAuthorizations++;
      throttledAt = Date.now();
      return { kind: 'unknown', reason: 'throttled', retryAfterMs: 60000 };
    }),
  });
  try {
    await startEventWait(f);
    await waitFor(
      async () => !!(await f.goalStore.read(f.sessionId))?.record.activeEventWait?.settled,
      { timeoutMs: 5000 },
    );
    const wait = (await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 }))
      .items[0]!;
    const at = Math.max(Date.now(), wait.record.updatedAt);
    await f.stores.eventWaitStore.commit({
      sessionId: f.sessionId,
      waitId: wait.record.waitId,
      expectedAuthorityRevision: wait.authorityRevision,
      record: {
        ...wait.record,
        status: 'resolved',
        updatedAt: at,
        resolvedAt: at,
        resolution: {
          outcome: 'satisfied',
          receiptKey: 'receipt',
          observedAt: at,
          evidenceRefs: [],
        },
      },
    });
    await waitFor(
      async () => {
        await f.goal.eventWaitBridge!.reconcile();
        return resultAuthorizations > 0;
      },
      { timeoutMs: 5000 },
    );
    for (let i = 0; i < 4; i++) await f.goal.eventWaitBridge!.reconcile();
    assert.equal(resultAuthorizations, 1);
    const cooldown = await f.stores.eventWaitStore.readSourceCooldown({
      providerId: 'test',
      connectionId: null,
    });
    assert.ok(cooldown! >= throttledAt + 60000);
    assert.equal(calls, 1);
    assert.equal(f.goal.manager.get(f.sessionId)?.iterations, 1);
    assert.equal((await f.goalStore.read(f.sessionId))?.record.pendingContinuation, null);
    assert.equal(f.drainRequested(), false);
  } finally {
    await f.close();
  }
});

for (const action of ['pause', 'clear'] as const)
  for (const maxIterations of [1, 50])
    test(`Goal ${action} cannot overwrite committed wait settlement (limit=${maxIterations})`, {
      timeout: 10000,
    }, async () => {
      const entered = deferred(),
        release = deferred();
      let calls = 0;
      const f = await createFixture({
        model: eventWaitModel(() => calls++),
        eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
        afterWaitMutation: async (stage) => {
          if (stage !== 'settle') return;
          entered.resolve();
          await release.promise;
        },
      });
      try {
        await startEventWait(f, maxIterations);
        await entered.promise;
        const stale = f.goal.manager.get(f.sessionId)!;
        const committed = (await f.goalStore.read(f.sessionId))!.record.goal;
        assert.equal(committed.iterations, 1);
        assert.equal(committed.tokensNow, 12);
        assert.equal(committed.tokensBaselinePending, false);
        const control = f.goal.handlers['goal.control'](
          {
            sessionId: f.sessionId,
            goalId: stale.id,
            expectedRevision: stale.revision,
            action,
          },
          operationContext(),
        );
        release.resolve();
        const response = await control;
        assert.equal(response.ok, false, 'A stale control revision must not overwrite settlement');
        if (!response.ok) assert.equal(response.error.code, 'operation_conflict');
        assert.deepEqual((await f.goalStore.read(f.sessionId))!.record.goal, committed);
        assert.deepEqual(f.goal.manager.get(f.sessionId), committed);
        if (maxIterations === 50) {
          const retry = await f.goal.handlers['goal.control'](
            {
              sessionId: f.sessionId,
              goalId: committed.id,
              expectedRevision: committed.revision,
              action,
            },
            operationContext(),
          );
          assert.equal(retry.ok, true);
          const controlled = (await f.goalStore.read(f.sessionId))!.record.goal;
          assert.equal(controlled.iterations, 1);
          assert.equal(controlled.tokensNow, 12);
          assert.equal(controlled.tokensAtStart, committed.tokensAtStart);
          assert.equal(controlled.tokensBaselinePending, false);
        } else {
          assert.equal(committed.status, 'max_iterations');
        }
        assert.equal(calls, 1);
        assert.equal(f.drainRequested(), false);
      } finally {
        release.resolve();
        await f.close();
      }
    });

test('late queue acknowledgement cannot restore a gate after Root admission', {
  timeout: 15000,
}, async () => {
  const admissionAccess = deferred(),
    releaseAdmission = deferred(),
    queueEntered = deferred(),
    releaseQueue = deferred(),
    successorEntered = deferred(),
    releaseSuccessor = deferred();
  let calls = 0,
    authorizations = 0,
    queues = 0;
  const sources = eventWaitSources(async (wait) => {
    if (wait.status === 'resolved' && ++authorizations === 2) {
      admissionAccess.resolve();
      await releaseAdmission.promise;
    }
    return { kind: 'allowed', context: null };
  });
  const f = await createFixture({
    model: eventWaitModel(async () => {
      if (++calls === 2) {
        successorEntered.resolve();
        await releaseSuccessor.promise;
      }
    }, true),
    eventWaitSources: { ...sources, policy: { maxPerSource: 2 } },
    afterWaitMutation: async (stage) => {
      if (stage === 'queue' && ++queues === 2) {
        queueEntered.resolve();
        await releaseQueue.promise;
      }
    },
  });
  try {
    await startEventWait(f);
    await waitFor(
      async () => !!(await f.goalStore.read(f.sessionId))?.record.activeEventWait?.settled,
      { timeoutMs: 5000 },
    );
    await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle', {
      timeoutMs: 5000,
    });
    const wait = (await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 }))
      .items[0]!;
    const at = Math.max(Date.now(), wait.record.updatedAt);
    await f.stores.eventWaitStore.commit({
      sessionId: f.sessionId,
      waitId: wait.record.waitId,
      expectedAuthorityRevision: wait.authorityRevision,
      record: {
        ...wait.record,
        status: 'resolved',
        updatedAt: at,
        resolvedAt: at,
        resolution: {
          outcome: 'satisfied',
          receiptKey: 'receipt',
          observedAt: at,
          evidenceRefs: [],
        },
      },
    });
    // The bridge's rescan timer is unref'd. Keep this wait alive until the
    // admission authorization barrier is reached, and fail if it never arrives.
    await withTimeout(admissionAccess.promise, 5000, 'Root admission authorization did not start');
    const scan = f.goal.eventWaitBridge!.reconcile();
    await queueEntered.promise;
    releaseAdmission.resolve();
    await successorEntered.promise;
    const admitted = (await f.goalStore.read(f.sessionId))!;
    assert.equal(admitted.record.activeEventWait, undefined);
    assert.equal(admitted.record.pendingContinuation, null);
    assert.ok(admitted.record.currentExecution);
    releaseQueue.resolve();
    await scan;
    releaseSuccessor.resolve();
    await f.waitForGoalStatus('achieved');
    assert.equal(f.drainRequested(), false);
    await waitFor(
      async () => (await f.goalStore.read(f.sessionId))?.record.currentExecution === null,
      { timeoutMs: 5000 },
    );
    const finished = (await f.goalStore.read(f.sessionId))!;
    assert.ok(finished.authorityRevision > admitted.authorityRevision);
    assert.equal(finished.record.activeEventWait, undefined);
    assert.equal(finished.record.currentExecution, null);
    assert.equal(
      (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
      2,
    );
    assert.equal(
      (await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: wait.record.waitId }))
        ?.record.delivery?.kind,
      'admitted',
    );
    assert.equal(calls, 2);
  } finally {
    releaseAdmission.resolve();
    releaseQueue.resolve();
    releaseSuccessor.resolve();
    await f.close();
  }
});

for (const provider of ['memory', 'local'] as const)
  test(`event wait admission with a lost store acknowledgement stays fenced (${provider})`, {
    timeout: 15000,
  }, async () => {
    let storageCalls = 0,
      modelCalls = 0,
      gateCalls = 0;
    let committed: RootTurnAdmission | undefined;
    const f = await createFixture({
      persistenceProvider:
        provider === 'memory' ? createMemoryExecutionPersistenceProvider() : 'local',
      model: eventWaitModel(() => modelCalls++, true),
      eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
      afterRootAdmission: async (admission) => {
        if (admission.execution.kind === 'goal' && admission.execution.eventWait) {
          storageCalls++;
          committed = admission;
          // The real transaction committed; only its acknowledgement is lost.
          throw new Error('Acknowledgement lost after event wait admission commit');
        }
      },
    });
    try {
      await startEventWait(f);
      await waitFor(
        async () => (await f.goalStore.read(f.sessionId))?.record.activeEventWait?.settled === true,
        { timeoutMs: 5000 },
      );
      await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle', {
        timeoutMs: 5000,
      });
      const wait = (
        await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 })
      ).items[0]!;
      const at = Math.max(Date.now(), wait.record.updatedAt);
      await f.stores.eventWaitStore.commit({
        sessionId: f.sessionId,
        waitId: wait.record.waitId,
        expectedAuthorityRevision: wait.authorityRevision,
        record: {
          ...wait.record,
          status: 'resolved',
          updatedAt: at,
          resolvedAt: at,
          resolution: {
            outcome: 'satisfied',
            receiptKey: 'receipt',
            observedAt: at,
            evidenceRefs: [],
          },
        },
      });
      await waitFor(
        async () => {
          await f.goal.eventWaitBridge!.reconcile();
          return f.drainRequested();
        },
        { timeoutMs: 5000 },
      );
      assert.ok(committed);
      const successor = committed;
      assert.equal(
        (await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: wait.record.waitId }))
          ?.record.delivery?.kind,
        'admitted',
      );
      assert.throws(
        () => f.rootAdmissions.assertKnownAdmission(successor),
        /identity changed within one Host Epoch/,
      );
      // Even an explicit same-identity retry is rejected before the execution gate.
      await assert.rejects(
        () =>
          f.coordinator.admit({
            sessionId: f.sessionId,
            turnId: successor.turnId,
            runId: successor.runId,
            userMessageId: successor.userMessageId,
            execution: successor.execution,
            content: successor.normalizedInput,
            admitExecution: async () => {
              gateCalls++;
              return 'executing';
            },
            start: () => assert.fail('An unacknowledged admission must not start'),
          }),
        /identity changed within one Host Epoch/,
      );
      assert.equal(gateCalls, 0);
      assert.equal(storageCalls, 1);
      assert.equal(modelCalls, 1);
      assert.equal(
        await f.stores.runtimeEventStore.readRunInvocation(f.sessionId, successor.runId),
        undefined,
      );
      assert.equal(
        (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
        2,
      );
    } finally {
      if (f.drainRequested()) {
        // Cleanup cannot overwrite the committed Goal state with the unconfirmed revision.
        await assert.rejects(() => f.close(), /Goal authority revision conflict/);
      } else {
        await f.close();
      }
    }
  });

test('handoff successor registers and settles a wait through the existing Goal and Root owners', {
  timeout: 15000,
}, async () => {
  const entered = deferred<void>(),
    boundary = deferred<void>(),
    registered = deferred<void>(),
    yieldSource = deferred<void>();
  const composition = createRunCompositionSnapshot({
    composerId: 'test.handoff',
    composerRevision: '1',
    sourceRevisions: [],
    baseSystemPromptHash: `sha256:${'0'.repeat(64)}`,
    toolCatalogHash: `sha256:${'0'.repeat(64)}`,
    toolAvailabilityHash: `sha256:${'0'.repeat(64)}`,
    baseProviderOptionsHash: `sha256:${'0'.repeat(64)}`,
    toolNames: [],
    contextWindow: null,
  });
  let f!: Fixture,
    source!: { runId: string; turnId: string },
    calls = 0,
    evaluations = 0;
  f = await createFixture({
    onEvaluate: () => {
      evaluations++;
    },
    eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
    registerBackend: (backends) =>
      backends.register(
        'ai-sdk',
        (context) =>
          new (class extends FakeBackend {
            async prepareRunComposition(input: { runId: string; turnId: string }) {
              await context.recordRunComposition!(input.runId, composition);
            }
            override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
              await this.prepareRunComposition({ runId: input.runId!, turnId: input.turnId });
              calls++;
              yield {
                type: 'token_usage',
                id: randomUUID(),
                turnId: input.turnId,
                ts: Date.now(),
                input: calls * 10,
                output: 0,
                total: calls * 10,
              };
              if (calls === 1) {
                source = { runId: input.runId!, turnId: input.turnId };
                entered.resolve();
                await boundary.promise;
                if ((await input.handoffBoundary!(new AbortController().signal, 2)) === 'pause')
                  return;
              }
              if (input.continuation) {
                await f.goal.eventWaitBridge!.register(
                  {
                    resource: {
                      providerId: 'test',
                      connectionId: null,
                      resourceType: 'job',
                      resourceId: 'job',
                    },
                    condition: { typeId: 'done', version: 1, parameters: {} },
                    reason: 'Wait after handoff',
                    timeoutMs: 60000,
                  },
                  {
                    sessionId: f.sessionId,
                    turnId: input.turnId,
                    runId: input.runId!,
                    toolCallId: 'handoff-wait',
                    cwd: f.base,
                    abortSignal: new AbortController().signal,
                    emitOutput: () => {},
                  },
                );
                registered.resolve();
                await yieldSource.promise;
              }
              yield {
                type: 'complete',
                id: randomUUID(),
                turnId: input.turnId,
                ts: Date.now(),
                stopReason: input.continuation ? 'event_wait' : 'end_turn',
              };
            }
          })(context),
      ),
  });
  try {
    await startEventWait(f);
    await entered.promise;
    const handoff = f.manager.requestRunHandoff(
      f.sessionId,
      source.runId,
      {
        protocol: 'runtime_handoff_pause_v1',
        handoffId: 'handoff',
        hostEpoch: 'goal-root-epoch',
        rootRunId: source.runId,
        successorRunId: 'physical-successor',
        successorInvocationId: 'physical-successor',
        claimId: 'handoff-claim',
      },
      new AbortController().signal,
    );
    assert.ok(handoff);
    boundary.resolve();
    assert.equal(await handoff.ready, true);
    assert.equal(handoff.commit(), true);
    assert.equal(await handoff.sealed, true);
    await registered.promise;
    const before = (await f.goalStore.read(f.sessionId))!.record;
    assert.equal(before.currentExecution?.execution.runId, source.runId);
    assert.equal(before.activeEventWait?.sourceExecution.runId, 'physical-successor');
    assert.equal(before.activeEventWait?.settled, false);
    yieldSource.resolve();
    await f.coordinator.whenIdle(f.sessionId);
    await waitFor(
      async () => (await f.goalStore.read(f.sessionId))?.record.activeEventWait?.settled === true,
      { timeoutMs: 5000 },
    );
    assert.equal(f.goal.manager.get(f.sessionId)?.iterations, 1);
    assert.equal(f.goal.manager.get(f.sessionId)?.tokensAtStart, 30);
    assert.equal(f.goal.manager.get(f.sessionId)?.tokensNow, 30);
    assert.equal(evaluations, 0);
    assert.equal(calls, 2);
    const wait = (await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 }))
      .items[0]!;
    const now = Date.now();
    await f.stores.eventWaitStore.commit({
      sessionId: f.sessionId,
      waitId: wait.record.waitId,
      expectedAuthorityRevision: wait.authorityRevision,
      record: {
        ...wait.record,
        status: 'resolved',
        updatedAt: now,
        resolvedAt: now,
        resolution: {
          outcome: 'satisfied',
          receiptKey: 'ready',
          observedAt: now,
          evidenceRefs: [],
        },
      },
    });
    await f.goal.eventWaitBridge!.reconcile();
    await f.waitForGoalStatus('achieved');
    await waitFor(
      async () => (await f.goalStore.read(f.sessionId))?.record.currentExecution === null,
      { timeoutMs: 5000 },
    );
    assert.equal(calls, 3);
    assert.equal(f.drainRequested(), false);
    assert.equal(
      (await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: wait.record.waitId }))
        ?.record.delivery?.kind,
      'admitted',
    );
  } finally {
    boundary.resolve();
    yieldSource.resolve();
    await f.close();
  }
});

for (const maxIterations of [3, 4])
  test(`recovery preserves accounting when a wait replaces a completed Goal Turn (limit=${maxIterations})`, {
    timeout: 15000,
  }, async () => {
    const evaluating = deferred<void>(),
      releaseEvaluation = deferred<void>();
    const accounting = deferred<void>(),
      releaseAccounting = deferred<void>();
    let calls = 0,
      evaluations = 0,
      admissions = 0;
    let hasGate = async () => false;
    const waiting = eventWaitModel();
    const ordinary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'stream-start', warnings: [] },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
            },
          },
        ]),
      }),
    });
    const f = await createFixture({
      model: new MockLanguageModelV4({
        doStream: (input) => (++calls === 3 ? waiting : ordinary).doStream(input),
      }),
      eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
      beforeReadContext: async () => {
        if (await hasGate()) {
          accounting.resolve();
          await releaseAccounting.promise;
        }
      },
      onEvaluate: async () => {
        if (++evaluations === 2) {
          evaluating.resolve();
          await releaseEvaluation.promise;
        }
        return JSON.stringify({
          met: false,
          impossible: false,
          progress: true,
          waiting: false,
          reason: 'More work',
        });
      },
    });
    hasGate = async () => !!(await f.goalStore.read(f.sessionId))?.record.activeEventWait;
    let recovered: HostGoalCoordinator | undefined;
    let copied: InteractiveExecutionStoresWriter | undefined;
    let copiedOwner: InteractiveRootOwner | null | undefined;
    const submit = (messageId: string) =>
      f.messages.handlers['turn.message.submit'](
        {
          originHostEpoch: 'goal-root-epoch',
          sessionId: f.sessionId,
          messageId,
          content: { text: messageId },
          placement: 'current_turn',
        },
        operationContext(),
      );
    try {
      await f.goal.recover();
      f.goal.manager.create(f.sessionId, 'Count all real work before waking', {
        armed: true,
        maxIterations,
      });
      await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
      assert.equal((await submit('first')).ok, true);
      await evaluating.promise;
      await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle', {
        timeoutMs: 5000,
      });
      const prior = (await f.goalStore.read(f.sessionId))!.record;
      assert.equal(prior.goal.iterations, 1);
      assert.equal(
        (
          await f.stores.runtimeEventStore.readRunInvocation(
            f.sessionId,
            prior.currentExecution!.execution.runId,
          )
        )?.terminalEvent?.status,
        'completed',
      );
      assert.equal((await submit('new-user')).ok, true);
      await accounting.promise;
      await waitFor(
        async () => {
          const runs = await f.stores.runtimeEventStore.listSessionInvocations(f.sessionId);
          return (
            runs.length === 3 && runs.every((run) => run.terminalEvent?.status === 'completed')
          );
        },
        { timeoutMs: 5000 },
      );
      const before = (await f.goalStore.read(f.sessionId))!.record;
      assert.equal(before.activeEventWait?.settled, false);
      assert.notEqual(
        before.currentExecution?.execution.turnId,
        prior.currentExecution!.execution.turnId,
      );
      const copyRoot = join(f.base, 'recovery-root');
      await mkdir(copyRoot);
      const db = new DatabaseSync(join(f.base, 'root', 'runtime.sqlite'));
      try {
        await backup(db, join(copyRoot, 'runtime.sqlite'));
      } finally {
        db.close();
      }
      copiedOwner = await tryAcquireInteractiveRootOwner(
        await resolveStorageRoot({ path: copyRoot, kind: 'interactive' }),
      );
      assert.ok(copiedOwner);
      copied = await openInteractiveExecutionStoresForWrite(copiedOwner.lease);
      const stores = copied;
      const wait = (await stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 }))
        .items[0]!;
      const at = Math.max(Date.now(), wait.record.updatedAt);
      await stores.eventWaitStore.commit({
        sessionId: f.sessionId,
        waitId: wait.record.waitId,
        expectedAuthorityRevision: wait.authorityRevision,
        record: {
          ...wait.record,
          status: 'resolved',
          updatedAt: at,
          resolvedAt: at,
          resolution: {
            outcome: 'satisfied',
            receiptKey: 'ready',
            observedAt: at,
            evidenceRefs: [],
          },
        },
      });
      recovered = new HostGoalCoordinator({
        store: stores.goalStore,
        stores,
        readSessionContext: async () => ({
          messages: await readLedgerMessages(stores.runtimeEventStore, f.sessionId),
        }),
        executions: {
          reconcile: async (identity) => {
            const run = await stores.runtimeEventStore.readRunInvocation(
              identity.sessionId,
              identity.runId,
            );
            assert.equal(run?.terminalEvent?.status, 'completed');
            return { ...identity, status: 'completed', terminalEventId: run!.terminalEvent!.id };
          },
          subscribe: () => () => {},
        },
        sessionAdmission: new SessionAdmissionGate(),
        evaluator: {
          evaluate: async () => assert.fail('Explicit wait recovery must not evaluate'),
          close: async () => {},
        },
        admitTurn: () => {
          admissions++;
          return { kind: 'busy', whenIdle: new Promise<void>(() => {}) };
        },
        acquireResidency: () => ({ release() {} }),
        onProjectionChanged() {},
        requestDrain: () => assert.fail('Unexpected drain'),
        eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
      });
      await recovered.prepareRecovery();
      await recovered.recover();
      await waitFor(
        async () => {
          const record = (await stores.goalStore.read(f.sessionId))!.record;
          return record.activeEventWait?.settled === true || record.goal.status !== 'active';
        },
        { timeoutMs: 5000 },
      );
      await recovered.eventWaitBridge!.reconcile();
      releaseEvaluation.resolve();
      releaseAccounting.resolve();
      await waitFor(
        async () => (await f.goalStore.read(f.sessionId))?.record.goal.iterations === 3,
        { timeoutMs: 5000 },
      );
      const live = (await f.goalStore.read(f.sessionId))!.record;
      const after = (await stores.goalStore.read(f.sessionId))!.record;
      assert.equal(after.goal.iterations, live.goal.iterations);
      assert.equal(after.goal.tokensAtStart, 12);
      assert.equal(after.goal.tokensNow, 36);
      assert.equal(after.goal.status, maxIterations === 3 ? 'max_iterations' : 'active');
      if (maxIterations === 3) {
        assert.equal(after.activeEventWait, undefined);
        assert.equal(after.pendingContinuation, null);
        assert.equal(admissions, 0);
        assert.equal(
          (await stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: wait.record.waitId }))
            ?.record.delivery?.kind,
          'suppressed',
        );
      } else {
        await waitFor(() => admissions > 0, { timeoutMs: 5000 });
        assert.equal(
          (await stores.goalStore.read(f.sessionId))?.record.pendingContinuation?.eventWait
            ?.provenance.waitId,
          wait.record.waitId,
        );
      }
    } finally {
      await recovered?.close();
      await copied?.goalStore.close();
      await copied?.sessionStore.close?.();
      await copiedOwner?.close();
      releaseEvaluation.resolve();
      releaseAccounting.resolve();
      await f.close();
    }
  });

for (const previous of ['waiting', 'pending', 'current'] as const)
  test(`a user Turn registers an explicit wait over older ordinary ${previous}`, {
    timeout: 15000,
  }, async () => {
    const evaluating = deferred<void>(),
      releaseEvaluation = deferred<void>();
    const sourceStarted = deferred<void>(),
      releaseSource = deferred<void>();
    let calls = 0,
      evaluations = 0;
    const sourceCall = previous === 'current' ? 3 : 2;
    const ordinary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'stream-start', warnings: [] },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
            },
          },
        ]),
      }),
    });
    const waiting = eventWaitModel();
    const f = await createFixture({
      model: new MockLanguageModelV4({
        doStream: async (input) => {
          if (++calls !== sourceCall) return ordinary.doStream(input);
          sourceStarted.resolve();
          if (previous === 'pending') await releaseSource.promise;
          return waiting.doStream(input);
        },
      }),
      eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
      onEvaluate: async () => {
        evaluations++;
        if (previous !== 'waiting' && evaluations === sourceCall - 1) {
          evaluating.resolve();
          await releaseEvaluation.promise;
        }
        return JSON.stringify({
          met: false,
          impossible: false,
          progress: true,
          waiting: previous === 'waiting',
          reason: 'External work remains outstanding',
        });
      },
    });
    const submit = (messageId: string) =>
      f.messages.handlers['turn.message.submit'](
        {
          originHostEpoch: 'goal-root-epoch',
          sessionId: f.sessionId,
          messageId,
          content: { text: messageId },
          placement: 'current_turn',
        },
        operationContext(),
      );
    try {
      await f.goal.recover();
      f.goal.manager.create(f.sessionId, 'Wait after ordinary work', { armed: true });
      await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
      assert.equal((await submit('first')).ok, true);
      if (previous === 'waiting') await f.waitForGoalStatus('waiting');
      else await evaluating.promise;
      await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle', {
        timeoutMs: 5000,
      });
      await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
      if (previous === 'current') {
        const old = (await f.goalStore.read(f.sessionId))!.record.currentExecution!;
        assert.equal(
          (await f.stores.runtimeEventStore.readRunInvocation(f.sessionId, old.execution.runId))
            ?.terminalEvent?.status,
          'completed',
        );
      }
      assert.equal((await submit('new-user')).ok, true);
      await sourceStarted.promise;
      if (previous === 'pending') {
        releaseEvaluation.resolve();
        await waitFor(
          async () => !!(await f.goalStore.read(f.sessionId))?.record.pendingContinuation,
          { timeoutMs: 5000 },
        );
        releaseSource.resolve();
      }
      await waitFor(
        async () =>
          (await f.manager.getMessages(f.sessionId)).some(
            (message) => message.type === 'tool_result',
          ),
        { timeoutMs: 5000 },
      );
      const waits = await f.stores.eventWaitStore.listSession({
        sessionId: f.sessionId,
        limit: 10,
      });
      assert.equal(waits.items.length, 1);
      releaseEvaluation.resolve();
      await waitFor(
        async () => (await f.goalStore.read(f.sessionId))?.record.activeEventWait?.settled === true,
        { timeoutMs: 5000 },
      );
      const after = (await f.goalStore.read(f.sessionId))!.record;
      assert.equal(after.goal.status, 'active');
      assert.equal(after.goal.iterations, sourceCall);
      assert.equal(after.goal.tokensAtStart, 12);
      assert.equal(after.goal.tokensNow, 12 * sourceCall);
      assert.equal(after.currentExecution, null);
      assert.equal(after.pendingContinuation, null);
      assert.equal(calls, sourceCall);
      assert.equal(evaluations, sourceCall - 1);
    } finally {
      releaseSource.resolve();
      releaseEvaluation.resolve();
      await f.close();
    }
  });

test('recovery settles a wait source after an older Turn advances the Goal revision', {
  timeout: 15000,
}, async () => {
  const firstRead = deferred<void>(),
    releaseFirst = deferred<void>(),
    sourceRead = deferred<void>(),
    releaseSource = deferred<void>();
  let calls = 0,
    reads = 0,
    admissions = 0,
    evaluations = 0;
  const waiting = eventWaitModel();
  const ordinary = new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
        { type: 'stream-start', warnings: [] },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
        },
      ]),
    }),
  });
  const f = await createFixture({
    model: new MockLanguageModelV4({
      doStream: (input) => (++calls === 2 ? waiting : ordinary).doStream(input),
    }),
    eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
    beforeReadContext: async () => {
      if (++reads === 1) {
        firstRead.resolve();
        await releaseFirst.promise;
      }
      if (reads === 3) {
        sourceRead.resolve();
        await releaseSource.promise;
      }
    },
  });
  let recovered: HostGoalCoordinator | undefined;
  let copied: InteractiveExecutionStoresWriter | undefined;
  let copiedOwner: InteractiveRootOwner | null | undefined;
  const submit = (messageId: string) =>
    f.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: 'goal-root-epoch',
        sessionId: f.sessionId,
        messageId,
        content: { text: messageId },
        placement: 'current_turn',
      },
      operationContext(),
    );
  try {
    await f.goal.recover();
    f.goal.manager.create(f.sessionId, 'Wait after older work', { armed: true });
    await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
    assert.equal((await submit('first')).ok, true);
    await firstRead.promise;
    await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle', {
      timeoutMs: 5000,
    });
    assert.equal((await submit('second')).ok, true);
    await waitFor(
      async () => {
        const runs = await f.stores.runtimeEventStore.listSessionInvocations(f.sessionId);
        return runs.length === 2 && runs.every((run) => run.terminalEvent?.status === 'completed');
      },
      { timeoutMs: 5000 },
    );
    releaseFirst.resolve();
    await sourceRead.promise;
    const before = (await f.goalStore.read(f.sessionId))!.record;
    assert.equal(before.goal.revision, 1);
    assert.equal(before.currentExecution?.checkpoint.revision, 0);
    assert.equal(before.activeEventWait?.settled, false);

    // Preserve a real reachable crash window without letting the original Host settle it.
    const copyRoot = join(f.base, 'recovery-root');
    await mkdir(copyRoot);
    const database = new DatabaseSync(join(f.base, 'root', 'runtime.sqlite'));
    try {
      await backup(database, join(copyRoot, 'runtime.sqlite'));
    } finally {
      database.close();
    }
    copiedOwner = await tryAcquireInteractiveRootOwner(
      await resolveStorageRoot({ path: copyRoot, kind: 'interactive' }),
    );
    assert.ok(copiedOwner);
    copied = await openInteractiveExecutionStoresForWrite(copiedOwner.lease);
    const stores = copied;
    const wait = (await stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 }))
      .items[0]!;
    const now = Math.max(Date.now(), wait.record.updatedAt);
    await stores.eventWaitStore.commit({
      sessionId: f.sessionId,
      waitId: wait.record.waitId,
      expectedAuthorityRevision: wait.authorityRevision,
      record: {
        ...wait.record,
        status: 'resolved',
        updatedAt: now,
        resolvedAt: now,
        resolution: {
          outcome: 'satisfied',
          receiptKey: 'ready',
          observedAt: now,
          evidenceRefs: [],
        },
      },
    });
    recovered = new HostGoalCoordinator({
      store: stores.goalStore,
      stores,
      readSessionContext: async () => ({
        messages: await readLedgerMessages(stores.runtimeEventStore, f.sessionId),
      }),
      // Terminal status matches the real immutable source facts above; the bridge rechecks its yield.
      executions: {
        reconcile: async (identity) => {
          const invocation = await stores.runtimeEventStore.readRunInvocation(
            identity.sessionId,
            identity.runId,
          );
          assert.equal(invocation?.terminalEvent?.status, 'completed');
          return {
            ...identity,
            status: 'completed',
            terminalEventId: invocation!.terminalEvent!.id,
          };
        },
        subscribe: () => () => {},
      },
      sessionAdmission: new SessionAdmissionGate(),
      evaluator: {
        evaluate: async () => {
          evaluations++;
          return '{"met":true}';
        },
        close: async () => {},
      },
      admitTurn: () => {
        admissions++;
        return { kind: 'busy', whenIdle: new Promise<void>(() => {}) };
      },
      acquireResidency: () => ({ release() {} }),
      onProjectionChanged() {},
      requestDrain: () => assert.fail('Recovery must not drain'),
      eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
    });
    await recovered.prepareRecovery();
    await recovered.recover();
    await waitFor(
      async () =>
        (await stores.goalStore.read(f.sessionId))?.record.activeEventWait?.settled === true,
      { timeoutMs: 5000 },
    );
    await recovered.eventWaitBridge!.reconcile();
    await waitFor(() => admissions > 0, { timeoutMs: 5000 });
    const after = (await stores.goalStore.read(f.sessionId))!.record;
    assert.equal(after.goal.iterations, 2);
    assert.equal(after.goal.tokensAtStart, 12);
    assert.equal(after.goal.tokensNow, 24);
    assert.equal(after.currentExecution, null);
    assert.equal(after.pendingContinuation?.eventWait?.provenance.waitId, wait.record.waitId);
    assert.equal(evaluations, 0);
  } finally {
    await recovered?.close();
    await copied?.goalStore.close();
    await copied?.sessionStore.close?.();
    await copiedOwner?.close();
    releaseFirst.resolve();
    releaseSource.resolve();
    await f.close();
  }
});

for (const sourceFirst of [false, true])
  for (const tokenBudget of [undefined, 1000])
    test(`event wait accounting keeps completed Turn boundaries across delayed reads (sourceFirst=${sourceFirst}, budget=${tokenBudget})`, {
      timeout: 15000,
    }, async () => {
      const reading = deferred<void>(),
        releaseRead = deferred<void>();
      let calls = 0,
        reads = 0,
        evaluations = 0;
      const laterTokens = tokenBudget === undefined ? 12 : 1002;
      const waiting = eventWaitModel(() => {}, false, sourceFirst ? 10 : laterTokens - 2);
      const ordinaryTokens = sourceFirst ? laterTokens : 12;
      const ordinary = new MockLanguageModelV4({
        doStream: async () => ({
          stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
            { type: 'stream-start', warnings: [] },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: ordinaryTokens - 2,
                  noCache: ordinaryTokens - 2,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 2, text: 2, reasoning: 0 },
              },
            },
          ]),
        }),
      });
      const model = new MockLanguageModelV4({
        doStream: (input) =>
          (++calls === (sourceFirst ? 1 : 2) ? waiting : ordinary).doStream(input),
      });
      const f = await createFixture({
        model,
        eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
        beforeReadContext: async () => {
          if (++reads === 1) {
            reading.resolve();
            await releaseRead.promise;
          }
        },
        onEvaluate: () => evaluations++,
      });
      const submit = (messageId: string) =>
        f.messages.handlers['turn.message.submit'](
          {
            originHostEpoch: 'goal-root-epoch',
            sessionId: f.sessionId,
            messageId,
            content: { text: messageId },
            placement: 'current_turn',
          },
          operationContext(),
        );
      try {
        await f.goal.recover();
        f.goal.manager.create(f.sessionId, 'Wait without losing earlier usage', {
          armed: true,
          ...(tokenBudget === undefined ? {} : { tokenBudget }),
        });
        await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
        assert.equal((await submit('first')).ok, true);
        await reading.promise;
        await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle', {
          timeoutMs: 5000,
        });
        assert.equal((await submit('second')).ok, true);
        await waitFor(
          async () => {
            const runs = await f.stores.runtimeEventStore.listSessionInvocations(f.sessionId);
            return (
              runs.length === 2 && runs.every((run) => run.terminalEvent?.status === 'completed')
            );
          },
          { timeoutMs: 5000 },
        );
        releaseRead.resolve();
        await waitFor(
          async () => {
            const state = (await f.goalStore.read(f.sessionId))?.record.goal;
            return state?.tokensNow === 12 + laterTokens;
          },
          { timeoutMs: 5000 },
        );
        const current = (await f.goalStore.read(f.sessionId))!.record;
        assert.equal(current.goal.tokensAtStart, 12);
        assert.equal(current.goal.tokensNow, 12 + laterTokens);
        assert.equal(current.goal.status, tokenBudget === undefined ? 'active' : 'budget_limited');
        // GoalManager stops incrementing work iterations once the token limit is reached.
        assert.equal(current.goal.iterations, tokenBudget === undefined ? 2 : 1);
        assert.equal(evaluations, 0);
        assert.equal(calls, 2);
        assert.equal(f.drainRequested(), false);
        const wait = (
          await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 })
        ).items[0]!;
        assert.equal(
          wait.record.delivery?.kind,
          tokenBudget === undefined ? undefined : 'suppressed',
        );
        assert.equal(
          current.activeEventWait?.settled,
          tokenBudget === undefined ? true : undefined,
        );
        assert.equal(current.pendingContinuation, null);
      } finally {
        releaseRead.resolve();
        await f.close();
      }
    });

for (const [otherSession, gateFirst, verdict, maxIterations] of [
  [false, false, 'continue', 50],
  [false, true, 'continue', 50],
  [false, false, 'achieved', 50],
  [false, false, 'waiting', 50],
  [false, true, 'continue', 2],
  [true, false, 'continue', 1],
  [true, false, 'waiting', 50],
] as const)
  test(`wait registration serializes prior evaluation (other=${otherSession}, gateFirst=${gateFirst}, verdict=${verdict}, budget=${maxIterations})`, {
    timeout: 15000,
  }, async () => {
    const evaluating = deferred<void>(),
      releaseEvaluation = deferred<void>(),
      registered = deferred<void>(),
      releaseRegistration = deferred<void>();
    let calls = 0,
      evaluations = 0;
    const waiting = eventWaitModel();
    const ordinary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'stream-start', warnings: [] },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
            },
          },
        ]),
      }),
    });
    const model = new MockLanguageModelV4({
      doStream: (input) => (++calls === 2 ? waiting.doStream(input) : ordinary.doStream(input)),
    });
    const f = await createFixture({
      model,
      eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
      onEvaluate: async () => {
        evaluations++;
        evaluating.resolve();
        await releaseEvaluation.promise;
        return JSON.stringify({
          met: verdict === 'achieved',
          impossible: false,
          progress: true,
          waiting: verdict === 'waiting',
          reason: 'earlier evaluation',
        });
      },
      afterWaitMutation: async (stage) => {
        if (stage === 'register') {
          registered.resolve();
          await releaseRegistration.promise;
        }
      },
    });
    const submit = (sessionId: string, messageId: string) =>
      f.messages.handlers['turn.message.submit'](
        {
          originHostEpoch: 'goal-root-epoch',
          sessionId,
          messageId,
          content: { text: messageId },
          placement: 'current_turn',
        },
        operationContext(),
      );
    try {
      await f.goal.recover();
      const firstSession = otherSession
        ? (
            await f.stores.sessionStore.create({
              cwd: f.base,
              llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              llmConnectionSlug: 'fake',
              model: 'fake-model',
              permissionMode: 'ask',
            })
          ).id
        : f.sessionId;
      if (otherSession) {
        await f.rootAdmissions.recoverSession(firstSession);
        f.goal.manager.create(firstSession, 'Earlier Goal', { armed: true, maxIterations });
      }
      f.goal.manager.create(f.sessionId, 'Wait for result', {
        armed: true,
        maxIterations: otherSession ? 50 : maxIterations,
      });
      await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
      assert.equal((await submit(firstSession, 'first')).ok, true);
      await evaluating.promise;
      await waitFor(() => f.coordinator.readRootState(firstSession).kind === 'idle', {
        timeoutMs: 5000,
      });
      assert.equal((await submit(f.sessionId, 'second')).ok, true);
      await registered.promise;
      if (!gateFirst) {
        releaseEvaluation.resolve();
        // Drain evaluator promise callbacks while the registration acknowledgement is held.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      releaseRegistration.resolve();
      await f.coordinator.whenIdle(f.sessionId);
      await waitFor(
        async () => {
          const goal = (await f.goalStore.read(f.sessionId))?.record;
          return (
            goal?.activeEventWait?.settled === true ||
            (!!goal && !['active', 'waiting'].includes(goal.goal.status))
          );
        },
        { timeoutMs: 5000 },
      );
      const current = (await f.goalStore.read(f.sessionId))!.record;
      assert.equal(
        current.goal.status,
        !otherSession && maxIterations === 2 ? 'max_iterations' : 'active',
      );
      assert.equal(current.goal.iterations, otherSession ? 1 : 2);
      assert.equal(current.goal.tokensAtStart, 12);
      assert.equal(current.goal.tokensNow, otherSession ? 12 : 24);
      assert.equal(evaluations, 1);
      assert.equal(calls, 2);
      assert.equal(f.drainRequested(), false);
      if (otherSession) {
        const earlier = (await f.goalStore.read(firstSession))!.record.goal;
        assert.equal(earlier.status, maxIterations === 1 ? 'max_iterations' : 'waiting');
        assert.equal(earlier.iterations, 1);
      }
      const wait = (
        await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 })
      ).items[0]!.record;
      assert.equal(
        wait.delivery?.kind,
        !otherSession && maxIterations === 2 ? 'suppressed' : undefined,
      );
    } finally {
      releaseEvaluation.resolve();
      releaseRegistration.resolve();
      await f.close();
    }
  });

for (const provider of ['memory', 'sqlite'] as const)
  for (const acknowledgeFirst of [true, false])
    test(`revoked Goal completion preserves a new wait (${provider}, registration ack ${acknowledgeFirst ? 'before' : 'after'} old callback)`, {
      timeout: 20_000,
    }, async (t) => {
      const oldObservation = deferred();
      const releaseOldObservation = deferred();
      const oldObservationReturned = deferred();
      const registerCommitted = deferred();
      const releaseRegisterAck = deferred();
      let modelCalls = 0;
      let evaluatorCalls = 0;
      let heldOldObservation = false;
      const finish: Extract<LanguageModelV4StreamPart, { type: 'finish' }> = {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
      };
      const waiting = eventWaitModel();
      const f = await createFixture({
        persistenceProvider:
          provider === 'memory' ? createMemoryExecutionPersistenceProvider() : 'local',
        model: new MockLanguageModelV4({
          doStream: async (input) => {
            modelCalls++;
            assert.ok(modelCalls <= 4, 'The gate must prevent additional model work');
            if (modelCalls <= 2)
              return {
                stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
                  { type: 'stream-start', warnings: [] },
                  finish,
                ]),
              };
            if (modelCalls === 3)
              return {
                stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'resume-goal',
                    toolName: 'GoalResume',
                    input: '{}',
                  },
                  { ...finish, finishReason: { unified: 'tool-calls', raw: 'tool-calls' } },
                ]),
              };
            return waiting.doStream(input);
          },
        }),
        eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
        onEvaluate: () => {
          evaluatorCalls++;
          return '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"Continue"}';
        },
        afterWaitMutation: async (stage) => {
          if (stage !== 'register') return;
          registerCommitted.resolve();
          await releaseRegisterAck.promise;
        },
      });
      const reconcile = f.coordinator.reconcile.bind(f.coordinator);
      f.coordinator.reconcile = async (execution) => {
        const snapshot = await reconcile(execution);
        const admission = await f.stores.agentRunStore.readRootTurnAdmission(
          execution.sessionId,
          execution.turnId,
        );
        if (!heldOldObservation && admission?.execution.kind === 'goal') {
          heldOldObservation = true;
          oldObservation.resolve();
          await releaseOldObservation.promise;
          oldObservationReturned.resolve();
        }
        return snapshot;
      };
      const submit = (messageId: string) =>
        f.messages.handlers['turn.message.submit'](
          {
            originHostEpoch: 'goal-root-epoch',
            sessionId: f.sessionId,
            messageId,
            content: { text: messageId },
            placement: 'current_turn',
          },
          operationContext(),
        );
      let verified = false;
      try {
        await f.goal.recover();
        f.goal.manager.create(f.sessionId, 'Continue after control changes', { armed: true });
        await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
        assert.equal((await submit('initial')).ok, true);
        await oldObservation.promise;
        await f.coordinator.whenIdle(f.sessionId);
        const before = (await f.goalStore.read(f.sessionId))!.record;
        assert.ok(before.currentExecution);
        assert.equal(before.goal.iterations, 1);
        assert.equal(before.goal.tokensAtStart, 12);
        assert.equal(
          (
            await f.goal.handlers['goal.control'](
              {
                sessionId: f.sessionId,
                goalId: before.goal.id,
                expectedRevision: before.goal.revision,
                action: 'pause',
              },
              operationContext(),
            )
          ).ok,
          true,
        );
        assert.equal((await submit('resume-and-wait')).ok, true);
        await registerCommitted.promise;
        const committed = (await f.goalStore.read(f.sessionId))!.record;
        assert.ok(committed.activeEventWait);
        assert.equal(committed.activeEventWait.settled, false);
        assert.deepEqual(
          committed.currentExecution?.execution,
          committed.activeEventWait.sourceExecution,
        );
        assert.notEqual(
          committed.currentExecution?.execution.turnId,
          before.currentExecution.execution.turnId,
        );
        assert.equal(committed.controlLease.generation, before.controlLease.generation + 2);
        if (acknowledgeFirst) {
          releaseRegisterAck.resolve();
          // Query flushes the joint lane, so the new authority has been adopted before cleanup.
          await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
        }
        releaseOldObservation.resolve();
        await oldObservationReturned.promise;
        // The old Root is already idle. Flush its resolved completion/settlement callbacks
        // while the late-ack case still holds the registration acknowledgement.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const afterCleanup = (await f.goalStore.read(f.sessionId))!.record;
        assert.deepEqual(
          afterCleanup.activeEventWait?.sourceExecution,
          committed.activeEventWait.sourceExecution,
        );
        assert.equal(afterCleanup.activeEventWait?.waitId, committed.activeEventWait.waitId);
        if (!acknowledgeFirst)
          assert.deepEqual(afterCleanup.currentExecution, committed.currentExecution);
        releaseRegisterAck.resolve();
        await waitFor(
          async () =>
            f.drainRequested() ||
            (await f.goalStore.read(f.sessionId))?.record.activeEventWait?.settled === true,
          { timeoutMs: 5000 },
        );
        assert.equal(
          f.drainRequested(),
          false,
          'Late cleanup must not fence the Host or discard the new wait',
        );
        await f.coordinator.whenIdle(f.sessionId);
        await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
        const settled = (await f.goalStore.read(f.sessionId))!.record;
        assert.deepEqual(settled.activeEventWait, {
          ...committed.activeEventWait,
          settled: true,
        });
        assert.equal(settled.currentExecution, null);
        assert.equal(settled.pendingContinuation, null);
        assert.equal(settled.goal.status, 'active');
        assert.equal(settled.goal.iterations, 2);
        assert.equal(settled.goal.tokensAtStart, 12);
        assert.equal(settled.goal.tokensNow, 48);
        const invocations = await f.stores.runtimeEventStore.listSessionInvocations(f.sessionId);
        const source = invocations.find(
          (invocation) => invocation.runId === committed.activeEventWait!.sourceExecution.runId,
        );
        assert.ok(source);
        assert.equal(runtimeInvocationOutcome(source), 'completed');
        assert.equal(source.terminalEvent?.actions?.stateDelta?.stopReason, 'event_wait');
        assert.equal(invocations.length, 3);
        for (let i = 0; i < 2; i++) await f.goal.eventWaitBridge!.reconcile();
        assert.equal(modelCalls, 4);
        assert.equal(evaluatorCalls, 1);
        assert.equal(f.drainRequested(), false);
        verified = true;
      } finally {
        releaseOldObservation.resolve();
        releaseRegisterAck.resolve();
        try {
          await f.close();
        } catch (error) {
          if (verified) throw error;
          t.diagnostic(`Cleanup after the failed assertion: ${String(error)}`);
        }
      }
    });

// Match the actual platform shell while preserving Node paths containing spaces.
function shellNodeCommand(script: string): string {
  const payload = Buffer.from(script).toString('base64');
  const bootstrap = `eval(Buffer.from('${payload}','base64').toString('utf8'))`;
  const shell = defaultShellPlan();
  if (shell.kind === 'powershell' || shell.kind === 'pwsh') {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return `& ${quote(process.execPath)} -e ${quote(bootstrap)}`;
  }
  if (shell.kind === 'cmd') return `"${process.execPath}" -e "${bootstrap}"`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(process.execPath)} -e ${quote(bootstrap)}`;
}

for (const scenario of ['success', 'failure', 'timeout', 'stop', 'cancel-wait', 'pty'] as const) {
  test(`builtin background Bash event wait: ${scenario}`, { timeout: 20000 }, async () => {
    let calls = 0,
      evaluations = 0;
    let f: Fixture;
    let ref = '';
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        let name: string | undefined, args: unknown;
        if (calls === 1) {
          name = 'Bash';
          const script = `const fs=require("fs");fs.appendFileSync("starts","1");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);console.log("task-output");process.exit(${scenario === 'failure' ? 7 : 0})}},10)`;
          args = {
            command: shellNodeCommand(script),
            run_in_background: true,
            ...(scenario === 'pty' ? { pty: true } : {}),
            timeout_ms: scenario === 'timeout' ? 1000 : 10000,
          };
        } else if (calls === 2) {
          ref = (await f.shellStore!.listSessionShellRuns(f.sessionId))[0]!.shellRunId;
          ref = `maka://runtime/background-tasks/${ref}`;
          name = 'WaitForEvent';
          args = {
            resource: {
              providerId: 'shell_run',
              resourceType: 'background_task',
              connectionId: null,
              resourceId: ref,
            },
            condition: { typeId: 'terminal', version: 1, parameters: {} },
            reason: 'Inspect the finished tests',
            timeoutMs: 60000,
          };
        } else if (calls === 3) {
          name = 'Read';
          args = { path: ref };
        }
        return {
          stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
            { type: 'stream-start', warnings: [] },
            ...(name
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: `call-${calls}`,
                    toolName: name,
                    input: JSON.stringify(args),
                  },
                ]
              : []),
            {
              type: 'finish',
              finishReason: { unified: name ? 'tool-calls' : 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 2, text: 2, reasoning: 0 },
              },
            },
          ]),
        };
      },
    });
    f = await createFixture({ shellRuns: true, model, onEvaluate: () => evaluations++ });
    try {
      await f.goal.recover();
      f.goal.manager.create(f.sessionId, 'Run tests and inspect the result', { armed: true });
      await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
      const started = await f.messages.handlers['turn.message.submit'](
        {
          originHostEpoch: 'goal-root-epoch',
          sessionId: f.sessionId,
          messageId: 'shell-wait-start',
          content: { text: 'Start tests and wait' },
          placement: 'current_turn',
        },
        operationContext(),
      );
      assert.equal(started.ok, true);
      await waitFor(
        async () => {
          const a = await f.goalStore.read(f.sessionId);
          if (a?.record.goal.status === 'paused' || a?.record.goal.status === 'achieved')
            throw new Error(JSON.stringify(a));
          return a?.record.activeEventWait?.settled === true;
        },
        { timeoutMs: 10000 },
      );
      const projection = await f.goal.readProjection(f.sessionId);
      assert.ok(projection?.eventWait);
      assert.equal(calls, 2);
      assert.equal(evaluations, 0);
      await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle', {
        timeoutMs: 5000,
      });
      const waitId = projection.eventWait.waitId;
      if (scenario === 'success' || scenario === 'pty' || scenario === 'cancel-wait') {
        await waitFor(
          async () => {
            const wait = await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId });
            return (wait?.record.observation?.attempts ?? 0) >= 3;
          },
          { timeoutMs: 5000 },
        );
        assert.equal(calls, 2, 'Repeated observation cannot invoke the work model');
        assert.equal(evaluations, 0, 'Repeated observation cannot invoke the Goal evaluator');
        assert.equal(f.coordinator.readRootState(f.sessionId).kind, 'idle');
      }
      const originalTarget = {
        sessionId: f.sessionId,
        goalId: projection.goalId,
        controlGeneration: projection.eventWait.controlGeneration,
        waitId,
        expectedGoalRevision: projection.revision,
      };
      const stale = await f.goal.handlers['goal.event-wait.cancel'](
        { ...originalTarget, expectedGoalRevision: projection.revision + 1 },
        operationContext(),
      );
      assert.equal(stale.ok && stale.result.outcome, 'conflict');
      assert.equal(f.goal.manager.get(f.sessionId)?.status, 'active');
      if (scenario === 'cancel-wait') {
        const target = {
          sessionId: f.sessionId,
          goalId: projection.goalId,
          controlGeneration: projection.eventWait.controlGeneration,
          waitId,
          expectedGoalRevision: projection.revision,
        };
        const cancelled = await f.goal.handlers['goal.event-wait.cancel'](
          target,
          operationContext(),
        );
        assert.equal(cancelled.ok && cancelled.result.outcome, 'cancelled');
        const repeat = await f.goal.handlers['goal.event-wait.cancel'](target, operationContext());
        assert.equal(repeat.ok && repeat.result.outcome, 'already_cancelled');
        assert.equal(f.shellRuns!.liveCount(), 1);
      } else if (scenario === 'stop')
        await f.shellRuns!.stopBackgroundTask(f.sessionId, ref, new AbortController().signal);
      if (scenario !== 'timeout' && scenario !== 'stop')
        await writeFile(join(f.owner.capability.canonicalPath, 'release'), 'ready');
      await waitFor(
        async () =>
          (await f.shellStore!.listSessionShellRuns(f.sessionId)).every(
            (r) => !['starting', 'running'].includes(r.status),
          ),
        { timeoutMs: 10000 },
      );
      if (scenario !== 'cancel-wait') {
        await f.waitForGoalStatus('achieved');
        assert.equal(calls, 4);
        const wait = await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId });
        assert.equal(wait?.record.status, 'resolved');
        assert.equal(wait?.record.delivery?.kind, 'admitted');
        const already = await f.goal.handlers['goal.event-wait.cancel'](
          originalTarget,
          operationContext(),
        );
        assert.equal(already.ok && already.result.outcome, 'already_admitted');
        assert.equal(f.goal.manager.get(f.sessionId)?.status, 'achieved');
        const task = (await f.shellStore!.listSessionShellRuns(f.sessionId))[0]!;
        assert.equal(
          task.status,
          scenario === 'failure'
            ? 'failed'
            : scenario === 'timeout'
              ? 'timed_out'
              : scenario === 'stop'
                ? 'cancelled'
                : 'completed',
        );
        const events = await f.stores.runtimeEventStore.readSessionRuntimeEvents(f.sessionId);
        const result = events.find(
          (e) => e.content?.kind === 'function_response' && e.content.name === 'Read',
        )?.content;
        assert.ok(result?.kind === 'function_response' && !result.isError, JSON.stringify(result));
        await f.goal.eventWaitBridge!.reconcile();
        assert.equal(calls, 4);
      } else {
        await f.goal.eventWaitBridge!.reconcile();
        assert.equal(calls, 2);
      }
      assert.equal(await readFile(join(f.owner.capability.canonicalPath, 'starts'), 'utf8'), '1');
      assert.equal(f.drainRequested(), false);
    } finally {
      await f.close();
    }
  });
}

// This subprocess owns the real Root, Goal, SQLite and process manager. SIGKILL
// bypasses graceful cleanup; the durable marker detects command redispatch.
test('ShellRun crash fixture', { skip: !process.env.MAKA_SHELL_WAIT_CRASH_ROOT }, async () => {
  const base = process.env.MAKA_SHELL_WAIT_CRASH_ROOT!;
  let f: Fixture,
    calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      const script =
        'const fs=require("fs");fs.appendFileSync("starts","1");fs.writeFileSync("process-id",String(process.pid));const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);fs.writeFileSync("done","1");console.log("recovered-result")}},10)';
      const task =
        calls === 2 ? (await f.shellStore!.listSessionShellRuns(f.sessionId))[0] : undefined;
      const name = calls === 1 ? 'Bash' : 'WaitForEvent';
      const args =
        calls === 1
          ? {
              command: shellNodeCommand(script),
              run_in_background: true,
              timeout_ms: 120000,
            }
          : {
              resource: {
                providerId: 'shell_run',
                resourceType: 'background_task',
                connectionId: null,
                resourceId: `maka://runtime/background-tasks/${task!.shellRunId}`,
              },
              condition: { typeId: 'terminal', version: 1, parameters: {} },
              reason: 'Verify after recovery',
              timeoutMs: 120000,
            };
      assert.ok(calls <= 2, 'The child must not continue before the crash');
      return modelToolStep(name, args, `crash-call-${calls}`);
    },
  });
  f = await createFixture({ base, shellRuns: true, model });
  await f.goal.recover();
  f.goal.manager.create(f.sessionId, 'Verify the original task', { armed: true });
  await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
  assert.equal(
    (
      await f.messages.handlers['turn.message.submit'](
        {
          originHostEpoch: 'goal-root-epoch',
          sessionId: f.sessionId,
          messageId: 'crash-start',
          content: { text: 'Start once' },
          placement: 'current_turn',
        },
        operationContext(),
      )
    ).ok,
    true,
  );
  await waitFor(
    async () => (await f.goalStore.read(f.sessionId))?.record.activeEventWait?.settled === true,
    { timeoutMs: 10000 },
  );
  await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle', {
    timeoutMs: 5000,
  });
  const task = (await f.shellStore!.listSessionShellRuns(f.sessionId))[0]!;
  const wait = (await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 }))
    .items[0]!.record;
  // Hold observation at a real durable boundary, before terminal notification.
  await f.goal.eventWaitBridge!.close();
  if (process.env.MAKA_SHELL_WAIT_CRASH_PHASE === 'terminal') {
    await writeFile(join(f.owner.capability.canonicalPath, 'release'), 'ready');
    await waitFor(
      async () =>
        (await f.shellStore!.readShellRun(f.sessionId, task.shellRunId)).status === 'completed',
      { timeoutMs: 5000 },
    );
  }
  await writeFile(
    join(base, 'ready.json'),
    JSON.stringify({
      sessionId: f.sessionId,
      waitId: wait.waitId,
      ref: `maka://runtime/background-tasks/${task.shellRunId}`,
      taskId: task.shellRunId,
    }),
  );
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await new Promise<void>(() => {});
  } finally {
    clearInterval(keepAlive);
  }
});

for (const phase of ['running', 'terminal'] as const)
  test(`ShellRun process crash recovery from ${phase} does not redispatch`, {
    timeout: 25000,
  }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-shell-crash-'));
    const child = spawn(
      process.execPath,
      [
        '--test',
        // Node 22 exposes the same isolation mode under its experimental flag.
        process.versions.node.startsWith('22.')
          ? '--experimental-test-isolation=none'
          : '--test-isolation=none',
        '--test-name-pattern=^ShellRun crash fixture$',
        fileURLToPath(import.meta.url),
      ],
      {
        env: {
          ...process.env,
          MAKA_SHELL_WAIT_CRASH_ROOT: base,
          MAKA_SHELL_WAIT_CRASH_PHASE: phase,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    let f: Fixture | undefined;
    try {
      let marker: { sessionId: string; waitId: string; ref: string; taskId: string } | undefined;
      await waitFor(
        async () => {
          if (child.exitCode !== null) throw new Error(output);
          try {
            marker = JSON.parse(await readFile(join(base, 'ready.json'), 'utf8'));
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
          }
        },
        { timeoutMs: 12000 },
      );
      assert.ok(marker);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      let calls = 0;
      f = await createFixture({
        base,
        sessionId: marker.sessionId,
        shellRuns: true,
        recoverAdmissions: false,
        model: new MockLanguageModelV4({
          doStream: async () =>
            ++calls === 1
              ? modelToolStep('Read', { path: marker!.ref }, 'recovery-read')
              : modelToolStep(),
        }),
      });
      assert.equal(
        await f.shellRuns!.recoverOrphanedSession(f.sessionId),
        phase === 'running' ? 1 : 0,
      );
      await f.coordinator.prepareRecovery();
      await f.manager.recoverInterruptedSessionsStrict(f.stores);
      await f.coordinator.recover();
      await f.messages.recoverPendingAfterHostRestart([f.sessionId]);
      await f.goal.recover();
      await f.waitForGoalStatus('achieved');
      const wait = (await f.stores.eventWaitStore.read({
        sessionId: f.sessionId,
        waitId: marker.waitId,
      }))!.record;
      assert.equal(wait.status, 'resolved');
      assert.equal(
        wait.status === 'resolved' && wait.resolution.outcome,
        phase === 'running' ? 'source_unavailable' : 'satisfied',
      );
      assert.equal(wait.delivery?.kind, 'admitted');
      assert.equal(calls, 2);
      assert.equal(
        (await f.shellStore!.readShellRun(f.sessionId, marker.taskId)).status,
        phase === 'running' ? 'orphaned' : 'completed',
      );
      await f.goal.eventWaitBridge!.reconcile();
      assert.equal(calls, 2);
      assert.equal(await readFile(join(base, 'root', 'starts'), 'utf8'), '1');
      // An orphan may still be alive: release the original process using its fixture
      // signal, not Runtime PID takeover. The test process may have died with its
      // parent; either its own completion marker or ESRCH establishes test cleanup.
      await writeFile(join(base, 'root', 'release'), 'ready');
      const processId = Number(await readFile(join(base, 'root', 'process-id'), 'utf8'));
      await waitFor(
        async () => {
          try {
            if ((await readFile(join(base, 'root', 'done'), 'utf8')) === '1') return true;
          } catch {
            /* Not finished. */
          }
          try {
            process.kill(processId, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
            throw error;
          }
        },
        { timeoutMs: 5000 },
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      if (f) await f.close();
      else {
        await writeFile(join(base, 'root', 'release'), 'ready').catch(() => {});
        await rm(base, { recursive: true, force: true });
      }
    }
  });

function modelToolStep(name?: string, args?: unknown, id = 'call') {
  return {
    stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
      { type: 'stream-start', warnings: [] },
      ...(name
        ? [
            {
              type: 'tool-call' as const,
              toolCallId: id,
              toolName: name,
              input: JSON.stringify(args),
            },
          ]
        : []),
      {
        type: 'finish',
        finishReason: { unified: name ? 'tool-calls' : 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
      },
    ]),
  };
}

test('a real background completion without wait registration does not invoke a model or evaluator', {
  timeout: 15000,
}, async () => {
  let calls = 0,
    evaluations = 0;
  const f = await createFixture({
    shellRuns: true,
    onEvaluate: () => evaluations++,
    model: new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        return calls === 1
          ? modelToolStep('Bash', {
              command: shellNodeCommand(
                'const fs=require("fs");fs.appendFileSync("starts","1");const t=setInterval(()=>{if(fs.existsSync("release"))clearInterval(t)},10)',
              ),
              run_in_background: true,
              timeout_ms: 10000,
            })
          : modelToolStep();
      },
    }),
  });
  try {
    await f.goal.recover();
    assert.equal(
      (
        await f.messages.handlers['turn.message.submit'](
          {
            originHostEpoch: 'goal-root-epoch',
            sessionId: f.sessionId,
            messageId: 'ordinary-background',
            content: { text: 'Run a task' },
            placement: 'current_turn',
          },
          operationContext(),
        )
      ).ok,
      true,
    );
    await f.coordinator.whenIdle(f.sessionId);
    assert.equal(calls, 2);
    await writeFile(join(f.owner.capability.canonicalPath, 'release'), 'ready');
    await waitFor(
      async () =>
        (await f.shellStore!.listSessionShellRuns(f.sessionId))[0]?.status === 'completed',
      { timeoutMs: 5000 },
    );
    await f.goal.eventWaitBridge!.reconcile();
    assert.equal(calls, 2);
    assert.equal(evaluations, 0);
    assert.equal(
      (await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 })).items
        .length,
      0,
    );
    assert.equal(await readFile(join(f.owner.capability.canonicalPath, 'starts'), 'utf8'), '1');
  } finally {
    await f.close();
  }
});

test('a stale wait cancellation cannot pause a replacement Goal and wait', {
  timeout: 15000,
}, async () => {
  let calls = 0;
  const f = await createFixture({
    model: new MockLanguageModelV4({
      doStream: async () =>
        modelToolStep(
          'WaitForEvent',
          {
            resource: {
              providerId: 'test',
              connectionId: null,
              resourceType: 'job',
              resourceId: 'job',
            },
            condition: { typeId: 'done', version: 1, parameters: {} },
            reason: 'Wait for this Goal',
            timeoutMs: 60000,
          },
          `replacement-wait-${++calls}`,
        ),
    }),
    eventWaitSources: eventWaitSources(async () => ({ kind: 'allowed', context: null })),
  });
  try {
    await startEventWait(f);
    await waitFor(
      async () => (await f.goalStore.read(f.sessionId))?.record.activeEventWait?.settled === true,
      { timeoutMs: 5000 },
    );
    await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle', {
      timeoutMs: 5000,
    });
    const before = (await f.goal.readProjection(f.sessionId))!;
    const target = {
      sessionId: f.sessionId,
      goalId: before.goalId,
      expectedGoalRevision: before.revision,
      controlGeneration: before.eventWait!.controlGeneration,
      waitId: before.eventWait!.waitId,
    };
    assert.equal(
      (await f.goal.handlers['goal.event-wait.cancel'](target, operationContext())).ok,
      true,
    );
    const paused = f.goal.manager.get(f.sessionId)!;
    assert.equal(
      (
        await f.goal.handlers['goal.control'](
          {
            sessionId: f.sessionId,
            goalId: paused.id,
            expectedRevision: paused.revision,
            action: 'clear',
          },
          operationContext(),
        )
      ).ok,
      true,
    );
    assert.equal(
      f.goal.manager.create(f.sessionId, 'Replacement work', { armed: true }).kind,
      'created',
    );
    await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
    // Registration shares the observer's source budget. The prior observation
    // reserves a minimum interval even when its wait is cancelled.
    await waitFor(
      async () =>
        Date.now() >=
        ((await f.stores.eventWaitStore.readSourceCooldown({
          providerId: 'test',
          connectionId: null,
        })) ?? 0),
      { timeoutMs: 5000 },
    );
    assert.equal(
      (
        await f.messages.handlers['turn.message.submit'](
          {
            originHostEpoch: 'goal-root-epoch',
            sessionId: f.sessionId,
            messageId: 'replacement-wait',
            content: { text: 'Wait again' },
            placement: 'current_turn',
          },
          operationContext(),
        )
      ).ok,
      true,
    );
    await waitFor(
      async () => {
        const gate = (await f.goalStore.read(f.sessionId))?.record.activeEventWait;
        return !!gate?.settled && gate.waitId !== target.waitId;
      },
      { timeoutMs: 5000 },
    );
    const current = await f.goal.readProjection(f.sessionId);
    const retry = await f.goal.handlers['goal.event-wait.cancel'](target, operationContext());
    assert.equal(retry.ok && retry.result.outcome, 'already_cancelled');
    assert.equal(f.goal.manager.get(f.sessionId)?.status, 'active');
    assert.equal(
      (await f.goal.readProjection(f.sessionId))?.eventWait?.waitId,
      current?.eventWait?.waitId,
    );
  } finally {
    await f.close();
  }
});

test('an already failed background task from an earlier Turn can register and deliver', {
  timeout: 15000,
}, async () => {
  let f: Fixture,
    calls = 0,
    ref = '';
  f = await createFixture({
    shellRuns: true,
    model: new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        if (calls === 1)
          return modelToolStep(
            'Bash',
            { command: shellNodeCommand('process.exit(7)'), run_in_background: true },
            'earlier-bash',
          );
        if (calls === 3)
          return modelToolStep(
            'WaitForEvent',
            {
              resource: {
                providerId: 'shell_run',
                resourceType: 'background_task',
                connectionId: null,
                resourceId: ref,
              },
              condition: { typeId: 'terminal', version: 1, parameters: {} },
              reason: 'Inspect earlier failure',
              timeoutMs: 60000,
            },
            'later-wait',
          );
        if (calls === 4) return modelToolStep('Read', { path: ref }, 'read-failure');
        return modelToolStep();
      },
    }),
  });
  try {
    await f.goal.recover();
    const submit = (messageId: string) =>
      f.messages.handlers['turn.message.submit'](
        {
          originHostEpoch: 'goal-root-epoch',
          sessionId: f.sessionId,
          messageId,
          content: { text: messageId },
          placement: 'current_turn',
        },
        operationContext(),
      );
    assert.equal((await submit('earlier-task')).ok, true);
    await f.coordinator.whenIdle(f.sessionId);
    await waitFor(
      async () => (await f.shellStore!.listSessionShellRuns(f.sessionId))[0]?.status === 'failed',
      { timeoutMs: 5000 },
    );
    const task = (await f.shellStore!.listSessionShellRuns(f.sessionId))[0]!;
    ref = `maka://runtime/background-tasks/${task.shellRunId}`;
    f.goal.manager.create(f.sessionId, 'Read the earlier result', { armed: true });
    await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
    assert.equal((await submit('later-wait')).ok, true);
    await f.waitForGoalStatus('achieved');
    const wait = (await f.stores.eventWaitStore.listSession({ sessionId: f.sessionId, limit: 10 }))
      .items[0]!.record;
    assert.notEqual(wait.sourceTurnId, task.sourceTurnId);
    assert.equal(wait.status, 'resolved');
    assert.equal(wait.status === 'resolved' && wait.resolution.outcome, 'satisfied');
    assert.equal(wait.delivery?.kind, 'admitted');
    assert.equal(calls, 5);
    const source = (await f.stores.runtimeEventStore.listSessionInvocations(f.sessionId)).find(
      (r) => r.turnId === wait.sourceTurnId,
    )!;
    assert.equal(source.terminalEvent?.actions?.stateDelta?.stopReason, 'event_wait');
    assert.equal((await f.shellStore!.listSessionShellRuns(f.sessionId)).length, 1);
  } finally {
    await f.close();
  }
});

for (const outcome of ['pending', 'unknown'] as const) {
  test(`ShellRun reconnect during ${outcome} recheck retains the last observation without polling frames`, {
    timeout: 15000,
  }, async () => {
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    let f: Fixture;
    let calls = 0,
      projections = 0,
      projectionFrames = 0;
    let mode: 'normal' | 'fault' | 'held' = 'normal';
    f = await createFixture({
      shellRuns: true,
      shellRunWaitReader: {
        readShellRun: async (sessionId, shellRunId) => {
          if (mode === 'held') {
            readStarted.resolve();
            await releaseRead.promise;
          }
          if (mode !== 'normal') throw new Error('Transient source read failure');
          return f.shellStore!.readShellRun(sessionId, shellRunId);
        },
      },
      onGoalProjection: () => projections++,
      model: new MockLanguageModelV4({
        doStream: async () => {
          calls++;
          if (calls === 1)
            return modelToolStep(
              'Bash',
              {
                command: shellNodeCommand(
                  'const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync("release"))clearInterval(t)},10)',
                ),
                run_in_background: true,
                timeout_ms: 30000,
              },
              'recheck-bash',
            );
          if (calls === 2) {
            const task = (await f.shellStore!.listSessionShellRuns(f.sessionId))[0]!;
            return modelToolStep(
              'WaitForEvent',
              {
                resource: {
                  providerId: 'shell_run',
                  connectionId: null,
                  resourceType: 'background_task',
                  resourceId: `maka://runtime/background-tasks/${task.shellRunId}`,
                },
                condition: { typeId: 'terminal', version: 1, parameters: {} },
                reason: 'Inspect the background result',
                timeoutMs: 60000,
              },
              'recheck-wait',
            );
          }
          return modelToolStep();
        },
      }),
    });
    try {
      await startEventWait(f);
      await waitFor(
        async () => (await f.goalStore.read(f.sessionId))?.record.activeEventWait?.settled === true,
        { timeoutMs: 5000 },
      );
      await waitFor(() => f.coordinator.readRootState(f.sessionId).kind === 'idle', {
        timeoutMs: 5000,
      });
      mode = outcome === 'unknown' ? 'fault' : 'normal';
      await waitFor(
        async () =>
          (await f.goal.readProjection(f.sessionId))?.eventWait?.observation?.state === outcome,
        { timeoutMs: 5000 },
      );
      const first = (await f.goal.readProjection(f.sessionId))!.eventWait!;
      assert.equal(
        first.observation?.reasonCode,
        outcome === 'unknown' ? 'observation_failed' : null,
      );
      mode = 'held';
      await withTimeout(readStarted.promise, 5000, 'recheck did not start');
      const reserved = (await f.stores.eventWaitStore.read({
        sessionId: f.sessionId,
        waitId: first.waitId,
      }))!;
      assert.equal(reserved.record.observation?.outcome, 'checking');
      f.continuity.attachConnection('recheck-client', {
        send: async (frame) => {
          if (frame.kind === 'subscription.session_projection') projectionFrames++;
        },
      });
      const context = {
        ...operationContext(),
        connectionId: 'recheck-client',
        principal: 'local_owner',
        principalKind: 'local_owner' as const,
      };
      const opened = await f.continuity.handlers['subscription.open'](
        { sessionId: f.sessionId, transcript: { kind: 'none' } },
        context,
      );
      assert.ok(opened.ok);
      assert.deepEqual(opened.result.snapshot.goal?.eventWait?.observation, first.observation);
      await f.continuity.handlers['subscription.ready'](
        { subscriptionId: opened.result.subscriptionId },
        context,
      );
      const count = projections;
      mode = outcome === 'unknown' ? 'fault' : 'normal';
      releaseRead.resolve();
      await waitFor(
        async () => {
          const row = await f.stores.eventWaitStore.read({
            sessionId: f.sessionId,
            waitId: first.waitId,
          });
          return (
            row?.record.observation?.attempts === reserved.record.observation!.attempts &&
            row.record.observation.outcome === outcome
          );
        },
        { timeoutMs: 5000 },
      );
      const current = (await f.goal.readProjection(f.sessionId))!.eventWait!;
      assert.equal(current.observation?.state, outcome);
      assert.equal(current.observation?.reasonCode, first.observation?.reasonCode);
      assert.equal(projections, count);
      assert.equal(projectionFrames, 0);
      assert.equal(calls, 2);
      assert.equal(f.shellRuns!.liveCount(), 1);
      assert.equal(f.drainRequested(), false);
    } finally {
      releaseRead.resolve();
      await writeFile(join(f.owner.capability.canonicalPath, 'release'), 'ready');
      await f.close();
    }
  });
}

for (const [sourceChange, expectedReason] of [
  ['missing', 'The awaited background task record is missing. The command was not restarted.'],
  ['revoked', 'Access to the awaited background task was revoked.'],
  ['provenance', 'The awaited background Bash source can no longer be verified.'],
] as const) {
  test(`final ShellRun admission preserves the ${sourceChange} source diagnostic`, {
    timeout: 15000,
  }, async () => {
    let f: Fixture;
    let calls = 0,
      evaluations = 0,
      sourceChanged = false;
    let successorTurnId: string | undefined;
    f = await createFixture({
      shellRuns: true,
      shellRunWaitReader: {
        readShellRun: async (sessionId, shellRunId) => {
          if (sourceChanged && sourceChange === 'missing')
            throw Object.assign(new Error('Task row disappeared'), { code: 'ENOENT' });
          const record = await f.shellStore!.readShellRun(sessionId, shellRunId);
          if (!sourceChanged) return record;
          return sourceChange === 'revoked'
            ? { ...record, visibility: 'user' }
            : { ...record, sourceToolCallId: 'unverifiable-call' };
        },
      },
      onEvaluate: () => evaluations++,
      model: new MockLanguageModelV4({
        doStream: async () => {
          calls++;
          if (calls === 1)
            return modelToolStep(
              'Bash',
              {
                command: shellNodeCommand('process.exit(0)'),
                run_in_background: true,
              },
              'source-bash',
            );
          if (calls === 2) {
            const task = (await f.shellStore!.listSessionShellRuns(f.sessionId))[0]!;
            return modelToolStep(
              'WaitForEvent',
              {
                resource: {
                  providerId: 'shell_run',
                  connectionId: null,
                  resourceType: 'background_task',
                  resourceId: `maka://runtime/background-tasks/${task.shellRunId}`,
                },
                condition: { typeId: 'terminal', version: 1, parameters: {} },
                reason: 'Inspect the background result',
                timeoutMs: 60000,
              },
              'source-wait',
            );
          }
          return modelToolStep();
        },
      }),
    });
    const bridge = f.goal.eventWaitBridge!;
    const authorize = bridge.authorizeAdmission.bind(bridge);
    bridge.authorizeAdmission = async (sessionId, pending) => {
      // The result is already queued. Synchronize with the durable read budget,
      // then change only the source reader before the real final access check.
      await waitFor(
        async () =>
          Date.now() >=
          ((await f.stores.eventWaitStore.readSourceCooldown({
            providerId: 'shell_run',
            connectionId: null,
          })) ?? 0),
        { timeoutMs: 5000 },
      );
      successorTurnId = pending.execution.turnId;
      sourceChanged = true;
      return authorize(sessionId, pending);
    };
    try {
      await f.goal.recover();
      f.goal.manager.create(f.sessionId, 'Inspect background command', { armed: true });
      await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
      const submitted = await f.messages.handlers['turn.message.submit'](
        {
          originHostEpoch: 'goal-root-epoch',
          sessionId: f.sessionId,
          messageId: 'admission-source-change',
          content: { text: 'Run and wait' },
          placement: 'current_turn',
        },
        operationContext(),
      );
      assert.equal(submitted.ok, true);
      await f.waitForGoalStatus('paused');
      await f.goal.handlers['goal.query']({ sessionId: f.sessionId }, operationContext());
      const persisted = (await f.goalStore.read(f.sessionId))!.record;
      assert.equal(sourceChanged, true);
      assert.equal(persisted.goal.lastReason, expectedReason);
      assert.equal(persisted.goal.iterations, 1);
      assert.equal(persisted.activeEventWait, undefined);
      assert.equal(persisted.pendingContinuation, null);
      const wait = (
        await f.stores.eventWaitStore.listSession({
          sessionId: f.sessionId,
          limit: 10,
        })
      ).items[0]!.record;
      assert.equal(wait.delivery?.kind, 'suppressed');
      assert.ok(successorTurnId);
      assert.equal(
        await f.stores.agentRunStore.readRootTurnAdmission(f.sessionId, successorTurnId),
        undefined,
      );
      assert.equal(calls, 2);
      assert.equal(evaluations, 0);
      assert.equal(f.drainRequested(), false);
    } finally {
      await f.close();
    }
  });
}
