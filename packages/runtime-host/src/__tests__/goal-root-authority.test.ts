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
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentRunHeader } from '@maka/core/agent-run';
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

test('Goal continuation uses the canonical root admission and durable origin', {
  timeout: 10_000,
}, async () => {
  const fixture = await createFixture();
  try {
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
    const run = await fixture.stores.agentRunStore.readRun(
      fixture.sessionId,
      durableAdmission.runId,
    );
    assert.equal(run.goalId, created.id);
    const user = (await fixture.stores.sessionStore.readMessages(fixture.sessionId)).find(
      (message) => message.type === 'user' && message.turnId === admission.turnId,
    );
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
      (await fixture.stores.agentRunStore.listSessionRuns(fixture.sessionId)).some(
        (run) => run.goalId === created.id,
      ),
      false,
    );
    assert.equal(
      (await fixture.stores.sessionStore.readMessages(fixture.sessionId)).some(
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
      (await fixture.stores.agentRunStore.listSessionRuns(fixture.sessionId)).some(
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
    assert.equal(run.goalId, resumed.id);
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
    const run = await fixture.stores.agentRunStore.readRun(fixture.sessionId, runId);
    assert.equal(run.goalId, 'goal-restart');
    assert.equal(run.status, 'failed');
    assert.equal(run.failureClass, 'app_restarted');
    const user = (await fixture.stores.sessionStore.readMessages(fixture.sessionId)).find(
      (message) => message.type === 'user' && message.turnId === turnId,
    );
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
    const userMessageId = randomUUID();
    await fixture.stores.agentRunStore.admitRootTurn({
      sessionId: fixture.sessionId,
      turnId,
      proposedRunId: randomUUID(),
      proposedUserMessageId: userMessageId,
      execution: { kind: 'goal', goalId: 'goal-corrupt-origin' },
      previousRootTurnId: null,
      normalizedInput: { text: 'Preserve durable Goal provenance' },
      sourceMessages: [],
      admittedAt: 1,
    });
    await fixture.stores.sessionStore.appendMessage(fixture.sessionId, {
      type: 'user',
      id: userMessageId,
      turnId,
      ts: 1,
      text: 'Preserve durable Goal provenance',
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
    await fixture.stores.agentRunStore.createRun(
      runHeader({
        sessionId: fixture.sessionId,
        turnId,
        runId,
        goalId,
        parentRunId: 'foreign-parent-run',
      }),
    );

    await assert.rejects(
      () => fixture.coordinator.prepareRecovery(),
      /changed its root execution identity/,
    );
  } finally {
    await fixture.close();
  }
});

interface Fixture {
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
  readonly drainRequested: () => boolean;
  waitForGoalStatus(status: GoalStatus): Promise<GoalState>;
  close(): Promise<void>;
}

type GoalState = NonNullable<ReturnType<HostGoalCoordinator['manager']['get']>>;
type GoalStatus = GoalState['status'];

async function createFixture(options: { recoverAdmissions?: boolean } = {}): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'maka-goal-root-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire test root');
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const goalStore = await openInteractiveGoalAuthorityForWrite(owner.lease);
  const session = await stores.sessionStore.create({
    cwd: capability.canonicalPath,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
  });
  const admission = new SessionAdmissionGate();
  const rootAdmissions = new RootAdmissionOwner(stores.agentRunStore);
  if (options.recoverAdmissions !== false) await rootAdmissions.recoverSession(session.id);
  const acquireResidency = (): RuntimeHostResidency => ({ release() {} });
  let coordinator: RootTurnCoordinator | undefined;
  let continuity: SessionContinuityCoordinator | undefined;
  let projection: CanonicalSessionProjectionReader | undefined;
  let goal: HostGoalCoordinator | undefined;
  let requestedDrain = false;
  const goalChangeListeners = new Set<() => void>();
  const rootPort: HostMessageRootPort = {
    readSessionHeader: (sessionId) => requireCoordinator(coordinator).readSessionHeader(sessionId),
    readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
    claimStopFence: (input, commitQueueFence, lease) =>
      requireCoordinator(coordinator).claimStopFence(input, commitQueueFence, lease),
    startFromMessage: (input, lease) =>
      requireCoordinator(coordinator).startFromMessage(input, lease),
    prepareMessage: (input) => requireCoordinator(coordinator).prepareMessage(input),
    claimStop: (input, commitQueueFence, lease) =>
      requireCoordinator(coordinator).claimStop(input, commitQueueFence, lease),
  };
  const hostEpoch = 'goal-root-epoch';
  await stores.messageReceiptStore.beginHostEpoch(hostEpoch);
  const messages = new HostMessageCoordinator({
    hostEpoch,
    root: rootPort,
    durableProof: {
      readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
        stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
      readImmutableSteeringMessageProof: (sessionId, messageId) =>
        stores.runtimeEventStore.readImmutableSteeringMessageProof(sessionId, messageId),
    },
    receipts: stores.messageReceiptStore,
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
    onSandboxBoundarySettled: async () => {},
  });
  const backends = new BackendRegistry();
  backends.register('ai-sdk', (context) => new FakeBackend(context));
  const authority: RuntimeHostedRootAuthority = {
    bindRun: (identity) => messages.bindRun(identity),
    executeRoot: (input) =>
      executeHostedExecutionToSettlement(requireCoordinator(coordinator), input),
    stopRoot: (identity, input) => requireCoordinator(coordinator).stopRoot(identity, input),
    stopSession: (sessionId, input) =>
      requireCoordinator(coordinator).stopSession(sessionId, input),
  };
  const manager = new SessionManager({
    store: stores.sessionStore,
    runStore: stores.agentRunStore,
    runtimeEventStore: stores.runtimeEventStore,
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
    executions: rootCoordinator,
    runtime: manager,
    matchesActive: (sessionId, checkpoint, controlLease) =>
      requireGoal(goal).matchesActive(sessionId, checkpoint, controlLease),
    newId: randomUUID,
  });
  goal = new HostGoalCoordinator({
    store: goalStore,
    stores,
    executions: rootCoordinator,
    sessionAdmission: admission,
    evaluator: {
      evaluate: async () =>
        '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"verified"}',
      close: async () => {},
    },
    admitTurn: (sessionId, text, checkpoint, controlLease) =>
      goalExecutions.admitTurn(sessionId, text, checkpoint, controlLease),
    listActionableTaskKeys: async () => [],
    acquireResidency,
    onProjectionChanged: (sessionId) => {
      requireContinuity(continuity).enqueueCanonicalRefresh(sessionId);
      for (const listener of goalChangeListeners) listener();
    },
    requestDrain: () => {
      requestedDrain = true;
    },
  });
  await goal.prepareRecovery();
  const goalCoordinator = goal;

  return {
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
      await goalCoordinator.close();
      await rootCoordinator.close();
      await messages.close();
      await interactions.close();
      continuity?.close();
      await goalStore.close();
      await stores.sessionStore.close?.();
      await owner.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitForGoalRun(
  fixture: Fixture,
  goalId: string,
): Promise<Awaited<ReturnType<Fixture['stores']['agentRunStore']['readRun']>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = (await fixture.stores.agentRunStore.listSessionRuns(fixture.sessionId)).find(
      (candidate) => candidate.goalId === goalId,
    );
    if (run) return run;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Goal continuation did not reach the root authority');
}

function runHeader(overrides: Partial<AgentRunHeader>): AgentRunHeader {
  return {
    runId: 'run-1',
    invocationId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
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
