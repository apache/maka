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
import type { GoalAuthorityRecord } from '@maka/core/goal';
import type { GoalTurnOutcome } from '@maka/runtime/goal-continuation';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveGoalAuthorityForWrite } from '@maka/storage/goal-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { HostGoalCoordinator } from '../server/goal-coordinator.js';
import { HostedExecutionProjectionReader } from '../server/hosted-execution-projection.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('one Host Goal is shared across clients with CAS control and crash-clear residency', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-goal-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const goalStore = await openInteractiveGoalAuthorityForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    let acquired = 0;
    let released = 0;
    let admittedText: string | undefined;
    let settleGoalTurn!: (outcome: GoalTurnOutcome) => void;
    const goalTurn = new Promise<GoalTurnOutcome>((resolve) => {
      settleGoalTurn = resolve;
    });
    const coordinator = new HostGoalCoordinator({
      store: goalStore,
      stores,
      executions: {
        reconcile: async () => assert.fail('No Goal execution recovery is expected'),
        subscribe: () => () => undefined,
      },
      sessionAdmission: new SessionAdmissionGate(),
      evaluator: {
        evaluate: async () =>
          '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"continue"}',
        close: async () => {},
      },
      admitTurn: (_sessionId, text) => {
        admittedText = text;
        return {
          kind: 'prepared',
          turnId: 'goal-turn-1',
          execution: {
            sessionId: session.id,
            turnId: 'goal-turn-1',
            runId: 'goal-run-1',
          },
          start: () => goalTurn,
        };
      },
      listActionableTaskKeys: async () => [],
      acquireResidency: () => {
        acquired++;
        return { release: () => released++ };
      },
      onProjectionChanged: () => {},
      requestDrain: () => {},
      newId: () => 'goal-1',
      now: () => 10,
    });
    await coordinator.prepareRecovery();

    const external = coordinator.beginObservedTurn(session.id, 'turn-1');
    assert.equal(external.kind, 'registered');
    if (external.kind !== 'registered') return;
    const created = coordinator.continuation.activateGoal(
      session.id,
      'turn-1',
      () => coordinator.manager.create(session.id, 'Finish the whole slice').goal,
    );
    assert.equal(created?.status, 'active');
    assert.equal(coordinator.hasLiveGoal(session.id), true);
    assert.equal(acquired, 1);

    const firstClient = await coordinator.handlers['goal.query'](
      { sessionId: session.id },
      operationContext('connection-1'),
    );
    const secondClient = await coordinator.handlers['goal.query'](
      { sessionId: session.id },
      operationContext('connection-2'),
    );
    assert.deepEqual(firstClient, secondClient);
    assert.equal(firstClient.ok && firstClient.result.goal?.goalId, 'goal-1');

    const paused = await coordinator.handlers['goal.control'](
      {
        sessionId: session.id,
        goalId: 'goal-1',
        expectedRevision: 0,
        action: 'pause',
      },
      operationContext('connection-1'),
    );
    assert.equal(paused.ok && paused.result.goal.status, 'paused');
    assert.equal(released, 0, 'paused Goal must retain Host residency');

    const staleResume = await coordinator.handlers['goal.control'](
      {
        sessionId: session.id,
        goalId: 'goal-1',
        expectedRevision: 0,
        action: 'resume',
      },
      operationContext('connection-2'),
    );
    assert.equal(staleResume.ok, false);
    if (!staleResume.ok) assert.equal(staleResume.error.code, 'operation_conflict');

    const resumed = await coordinator.handlers['goal.control'](
      {
        sessionId: session.id,
        goalId: 'goal-1',
        expectedRevision: 1,
        action: 'resume',
      },
      operationContext('connection-2'),
    );
    assert.equal(resumed.ok && resumed.result.goal.status, 'active');
    await waitFor(() => admittedText !== undefined);
    assert.match(admittedText ?? '', /Goal resumed by a connected client/);
    await waitForAsync(
      async () =>
        (await goalStore.read(session.id))?.record.currentExecution?.execution.turnId ===
        'goal-turn-1',
    );
    const durableExecution = (await goalStore.read(session.id))?.record.currentExecution;
    assert.deepEqual(durableExecution, {
      execution: {
        sessionId: session.id,
        turnId: 'goal-turn-1',
        runId: 'goal-run-1',
      },
      checkpoint: { goalId: 'goal-1', revision: 2 },
      controlLease: coordinator.manager.getControlLease(session.id),
    });

    const cleared = await coordinator.handlers['goal.control'](
      {
        sessionId: session.id,
        goalId: 'goal-1',
        expectedRevision: 2,
        action: 'clear',
      },
      operationContext('connection-1'),
    );
    assert.equal(cleared.ok && cleared.result.goal.status, 'cleared');
    assert.equal(coordinator.hasLiveGoal(session.id), false);
    assert.equal(released, 1);
    settleGoalTurn({ kind: 'completed', turnId: 'goal-turn-1' });
    await waitForAsync(
      async () => (await goalStore.read(session.id))?.record.currentExecution === null,
    );
    assert.equal(coordinator.manager.get(session.id)?.status, 'cleared');

    coordinator.manager.create(session.id, 'A second Host-epoch Goal');
    assert.equal(acquired, 2);
    coordinator.beginDrain();
    assert.equal(released, 2);
    assert.equal(coordinator.readProjection(session.id), null);
    await coordinator.close();
    assert.equal(released, 2, 'close must not release Goal residency twice');

    const recovered = new HostGoalCoordinator({
      store: goalStore,
      stores,
      executions: {
        reconcile: async () => assert.fail('Recovered Goal has no current execution'),
        subscribe: () => () => undefined,
      },
      sessionAdmission: new SessionAdmissionGate(),
      evaluator: {
        evaluate: async () =>
          '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"continue"}',
        close: async () => {},
      },
      admitTurn: () => ({
        kind: 'unavailable',
        reason: 'Recovery assertion only',
      }),
      listActionableTaskKeys: async () => [],
      acquireResidency: () => ({ release() {} }),
      onProjectionChanged: () => {},
      requestDrain: () => {},
    });
    await recovered.prepareRecovery();
    assert.equal(recovered.manager.get(session.id)?.condition, 'A second Host-epoch Goal');
    await recovered.close();
    await goalStore.close();
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('session retirement forgets a terminal Goal without recreating deleted authority', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-goal-retirement-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const goalStore = await openInteractiveGoalAuthorityForWrite(owner.lease);
  try {
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const active = activeGoalRecord(session.id, {
      sessionId: session.id,
      turnId: 'retired_goal_turn',
      runId: 'retired_goal_run',
    });
    const terminal: GoalAuthorityRecord = {
      ...active,
      goal: { ...active.goal, status: 'cleared' },
      currentExecution: null,
    };
    assert.equal(
      (
        await goalStore.commit({
          sessionId: session.id,
          expectedAuthorityRevision: null,
          record: terminal,
        })
      ).kind,
      'committed',
    );

    let drainRequests = 0;
    const projectionChanges: string[] = [];
    const coordinator = new HostGoalCoordinator({
      store: goalStore,
      stores,
      executions: {
        reconcile: async () => assert.fail('A terminal Goal has no execution to recover'),
        subscribe: () => () => undefined,
      },
      sessionAdmission: new SessionAdmissionGate(),
      evaluator: {
        evaluate: async () => assert.fail('A terminal Goal must not be evaluated'),
        close: async () => {},
      },
      admitTurn: () => assert.fail('A terminal Goal must not admit a continuation'),
      listActionableTaskKeys: async () => [],
      acquireResidency: () => assert.fail('A terminal Goal must not retain Host residency'),
      onProjectionChanged: (sessionId) => projectionChanges.push(sessionId),
      requestDrain: () => drainRequests++,
    });
    await coordinator.prepareRecovery();

    const retirement = await coordinator.beginSessionRetirement([session.id], 'archive');
    const header = await stores.sessionStore.readHeaderRecordSnapshot(session.id);
    await stores.sessionStore.setSessionsArchivedVersioned(
      [{ sessionId: session.id, expectedVersion: header.revision }],
      true,
    );
    retirement.commit();

    assert.equal(coordinator.readProjection(session.id), null);
    assert.equal(await goalStore.read(session.id), null);
    await coordinator.close();
    assert.equal(drainRequests, 0);
    assert.deepEqual(projectionChanges, [session.id]);
  } finally {
    await goalStore.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('restart settles the durable current Goal execution through Hosted Execution authority', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-goal-recovery-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const goalStore = await openInteractiveGoalAuthorityForWrite(owner.lease);
  try {
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const execution = {
      sessionId: session.id,
      turnId: 'goal_recovery_turn',
      runId: 'goal_recovery_run',
    };
    const record = activeGoalRecord(session.id, execution);
    const committed = await goalStore.commit({
      sessionId: session.id,
      expectedAuthorityRevision: null,
      record,
    });
    assert.equal(committed.kind, 'committed');
    const admission = await stores.agentRunStore.admitRootTurn({
      sessionId: session.id,
      turnId: execution.turnId,
      proposedRunId: execution.runId,
      proposedUserMessageId: 'goal_recovery_message',
      execution: { kind: 'goal', goalId: record.goal.id },
      previousRootTurnId: null,
      normalizedInput: { text: 'Finish the recovered Goal.' },
      sourceMessages: [],
      admittedAt: 1,
    });
    assert.equal(admission.kind, 'admitted');
    await stores.agentRunStore.createRun({
      runId: execution.runId,
      invocationId: execution.runId,
      sessionId: session.id,
      turnId: execution.turnId,
      status: 'created',
      backendKind: 'fake',
      llmConnectionSlug: 'fake',
      modelId: 'fake-model',
      cwd: capability.canonicalPath,
      permissionMode: 'ask',
      goalId: record.goal.id,
      createdAt: 2,
      updatedAt: 2,
    });
    await stores.runtimeEventStore.appendRuntimeEvent(session.id, execution.runId, {
      id: 'goal_recovery_terminal',
      invocationId: execution.runId,
      sessionId: session.id,
      turnId: execution.turnId,
      runId: execution.runId,
      ts: 3,
      partial: false,
      status: 'completed',
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'done' },
    });
    await stores.agentRunStore.updateRun(session.id, execution.runId, {
      status: 'completed',
      updatedAt: 3,
      completedAt: 3,
    });

    let drainRequested = false;
    const executionProjection = new HostedExecutionProjectionReader(stores);
    const coordinator = new HostGoalCoordinator({
      store: goalStore,
      stores,
      executions: {
        reconcile: (requested) => executionProjection.read(requested),
        subscribe: () => () => undefined,
      },
      sessionAdmission: new SessionAdmissionGate(),
      evaluator: {
        evaluate: async () =>
          '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"done"}',
        close: async () => {},
      },
      admitTurn: () => assert.fail('A terminal recovered execution must not be admitted again'),
      listActionableTaskKeys: async () => [],
      acquireResidency: () => ({ release() {} }),
      onProjectionChanged: () => {},
      requestDrain: () => {
        drainRequested = true;
      },
    });

    await coordinator.prepareRecovery();
    await coordinator.recover();
    await waitFor(() => coordinator.manager.get(session.id)?.status === 'achieved');

    assert.equal(coordinator.manager.get(session.id)?.status, 'achieved');
    await coordinator.close();
    assert.equal((await goalStore.read(session.id))?.record.currentExecution, null);
    assert.equal(drainRequested, false);
  } finally {
    await goalStore.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('restart replaces a stale current execution with the current durable Goal intent', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-goal-stale-execution-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const goalStore = await openInteractiveGoalAuthorityForWrite(owner.lease);
  try {
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const execution = {
      sessionId: session.id,
      turnId: 'stale_goal_turn',
      runId: 'stale_goal_run',
    };
    const initial = activeGoalRecord(session.id, execution);
    const record: GoalAuthorityRecord = {
      ...initial,
      goal: { ...initial.goal, revision: 1, iterations: 1 },
    };
    const committed = await goalStore.commit({
      sessionId: session.id,
      expectedAuthorityRevision: null,
      record,
    });
    assert.equal(committed.kind, 'committed');
    const admission = await stores.agentRunStore.admitRootTurn({
      sessionId: session.id,
      turnId: execution.turnId,
      proposedRunId: execution.runId,
      proposedUserMessageId: 'stale_goal_message',
      execution: { kind: 'goal', goalId: record.goal.id },
      previousRootTurnId: null,
      normalizedInput: { text: 'Continue the stale Goal execution.' },
      sourceMessages: [],
      admittedAt: 1,
    });
    assert.equal(admission.kind, 'admitted');

    let recoveredIntent = false;
    const coordinator = new HostGoalCoordinator({
      store: goalStore,
      stores,
      executions: {
        reconcile: async () => assert.fail('A stale execution must not be reconciled'),
        subscribe: () => () => undefined,
      },
      sessionAdmission: new SessionAdmissionGate(),
      evaluator: {
        evaluate: async () =>
          '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"continue"}',
        close: async () => {},
      },
      admitTurn: () => {
        recoveredIntent = true;
        return { kind: 'unavailable', reason: 'Recovery assertion only' };
      },
      listActionableTaskKeys: async () => [],
      acquireResidency: () => ({ release() {} }),
      onProjectionChanged: () => {},
      requestDrain: () => {},
    });

    await coordinator.prepareRecovery();
    await coordinator.recover();
    await waitFor(() => recoveredIntent);

    assert.equal((await goalStore.read(session.id))?.record.currentExecution, null);
    assert.equal(coordinator.manager.get(session.id)?.revision, 2);
    await coordinator.close();
  } finally {
    await goalStore.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

function activeGoalRecord(
  sessionId: string,
  execution: NonNullable<GoalAuthorityRecord['currentExecution']>['execution'],
): GoalAuthorityRecord {
  const goalId = 'goal_recovered';
  const controlLease = { goalId, generation: 0 };
  return {
    schemaVersion: 1,
    goal: {
      id: goalId,
      revision: 0,
      sessionId,
      condition: 'Finish the recovered Goal.',
      status: 'active',
      setAt: 1,
      iterations: 0,
      maxIterations: 50,
      consecutiveNoProgress: 0,
      blockCap: 8,
      tokensAtStart: 0,
      tokensNow: 0,
      tokensBaselinePending: true,
    },
    controlLease,
    currentExecution: {
      execution,
      checkpoint: { goalId, revision: 0 },
      controlLease,
    },
  };
}

test('goal.arm creates one Goal per Session and refuses a second while it is unfinished', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-goal-arm-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const goalStore = await openInteractiveGoalAuthorityForWrite(owner.lease);
  try {
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const coordinator = new HostGoalCoordinator({
      store: goalStore,
      stores,
      executions: {
        reconcile: async () => assert.fail('Arming alone has no execution to recover'),
        subscribe: () => () => undefined,
      },
      sessionAdmission: new SessionAdmissionGate(),
      evaluator: {
        evaluate: async () => assert.fail('Arming alone must not evaluate the Goal'),
        close: async () => {},
      },
      // Arming schedules nothing: the Goal takes hold on the next Turn.
      admitTurn: () => assert.fail('Arming must not admit a continuation Turn'),
      listActionableTaskKeys: async () => [],
      acquireResidency: () => ({ release: () => {} }),
      onProjectionChanged: () => {},
      requestDrain: () => {},
      newId: () => 'goal-armed',
      now: () => 10,
    });
    await coordinator.prepareRecovery();

    const armed = await coordinator.handlers['goal.arm'](
      {
        sessionId: session.id,
        condition: 'All tests pass',
        maxIterations: 20,
        tokenBudget: 50_000,
      },
      operationContext('connection-1'),
    );
    assert.equal(armed.ok, true);
    if (!armed.ok) return;
    assert.equal(armed.result.goal.goalId, 'goal-armed');
    assert.equal(armed.result.goal.status, 'active');
    assert.equal(armed.result.goal.maxIterations, 20);
    assert.equal(armed.result.goal.tokenBudget, 50_000);
    assert.deepEqual(
      await coordinator.handlers['goal.query'](
        { sessionId: session.id },
        operationContext('connection-2'),
      ),
      armed,
      'every client reads the Goal the Host just armed',
    );
    await waitForAsync(async () => (await goalStore.read(session.id)) !== null);

    const second = await coordinator.handlers['goal.arm'](
      {
        sessionId: session.id,
        condition: 'Something else',
        maxIterations: null,
        tokenBudget: null,
      },
      operationContext('connection-1'),
    );
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.error.code, 'operation_conflict');

    const missing = await coordinator.handlers['goal.arm'](
      {
        sessionId: 'session-that-never-existed',
        condition: 'All tests pass',
        maxIterations: null,
        tokenBudget: null,
      },
      operationContext('connection-1'),
    );
    assert.equal(missing.ok === false && missing.error.code, 'not_found');

    const header = await stores.sessionStore.readHeaderRecordSnapshot(session.id);
    await stores.sessionStore.setSessionsArchivedVersioned(
      [{ sessionId: session.id, expectedVersion: header.revision }],
      true,
    );
    const archived = await coordinator.handlers['goal.arm'](
      {
        sessionId: session.id,
        condition: 'All tests pass',
        maxIterations: null,
        tokenBudget: null,
      },
      operationContext('connection-1'),
    );
    assert.equal(archived.ok === false && archived.error.code, 'session_archived');

    await coordinator.close();
  } finally {
    await goalStore.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('a Goal armed but never carried by a Turn does not start itself after a restart', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-goal-armed-restart-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const goalStore = await openInteractiveGoalAuthorityForWrite(owner.lease);
  try {
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const armingHost = new HostGoalCoordinator({
      store: goalStore,
      stores,
      executions: {
        reconcile: async () => assert.fail('Arming alone has no execution to recover'),
        subscribe: () => () => undefined,
      },
      sessionAdmission: new SessionAdmissionGate(),
      evaluator: {
        evaluate: async () => assert.fail('Arming alone must not evaluate the Goal'),
        close: async () => {},
      },
      admitTurn: () => assert.fail('Arming must not admit a continuation Turn'),
      listActionableTaskKeys: async () => [],
      acquireResidency: () => ({ release: () => {} }),
      onProjectionChanged: () => {},
      requestDrain: () => {},
      newId: () => 'goal-armed-across-restart',
    });
    await armingHost.prepareRecovery();
    const armed = await armingHost.handlers['goal.arm'](
      {
        sessionId: session.id,
        condition: 'All tests pass',
        maxIterations: null,
        tokenBudget: null,
      },
      operationContext('connection-1'),
    );
    assert.equal(armed.ok, true);
    await waitForAsync(async () => (await goalStore.read(session.id)) !== null);
    await armingHost.close();

    // The Host that comes back up reads the same durable Goal. Arming started
    // nothing before the restart, so it must start nothing because of one.
    // Both hooks record rather than throw: a throw inside admission is caught
    // by the drain and only surfaces as a paused Goal, which names the wrong
    // failure.
    let evaluated = false;
    let admitted = false;
    const restarted = new HostGoalCoordinator({
      store: goalStore,
      stores,
      executions: {
        reconcile: async () => assert.fail('An armed Goal has no execution to recover'),
        subscribe: () => () => undefined,
      },
      sessionAdmission: new SessionAdmissionGate(),
      evaluator: {
        evaluate: async () => {
          evaluated = true;
          return '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"x"}';
        },
        close: async () => {},
      },
      admitTurn: () => {
        admitted = true;
        return { kind: 'unavailable', reason: 'Recovery assertion only' };
      },
      listActionableTaskKeys: async () => [],
      acquireResidency: () => ({ release: () => {} }),
      onProjectionChanged: () => {},
      requestDrain: () => {},
    });
    await restarted.prepareRecovery();
    await restarted.recover();
    // Settle every microtask a scheduled continuation would have needed.
    for (let tick = 0; tick < 20; tick += 1) await new Promise((r) => setImmediate(r));

    assert.equal(admitted, false, 'the restart admitted a Turn for a Goal no Turn had carried');
    assert.equal(evaluated, false, 'the restart evaluated a Goal no Turn had carried');
    const goal = restarted.readProjection(session.id);
    assert.equal(goal?.status, 'active', 'the armed Goal survives the restart untouched');
    assert.equal(goal?.iterations, 0, 'and no Turn ran for it');
    await restarted.close();
  } finally {
    await goalStore.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('resuming an armed Goal drives it, and a restart puts that drive back', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-goal-armed-resume-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const goalStore = await openInteractiveGoalAuthorityForWrite(owner.lease);
  try {
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    let admitted = 0;
    let evaluated = 0;
    const host = new HostGoalCoordinator({
      store: goalStore,
      stores,
      executions: {
        reconcile: async () => assert.fail('Arming alone has no execution to recover'),
        subscribe: () => () => undefined,
      },
      sessionAdmission: new SessionAdmissionGate(),
      evaluator: {
        evaluate: async () => {
          evaluated += 1;
          return '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"x"}';
        },
        close: async () => {},
      },
      // Busy leaves the Goal exactly where resume put it: driving, with no
      // execution recorded. Any other admission would write durable state and
      // hide what the restart below has to rebuild from the Goal alone.
      admitTurn: () => {
        admitted += 1;
        return { kind: 'busy', whenIdle: new Promise<void>(() => {}) };
      },
      listActionableTaskKeys: async () => [],
      acquireResidency: () => ({ release: () => {} }),
      onProjectionChanged: () => {},
      requestDrain: () => {},
      newId: () => 'goal-armed-and-resumed',
    });
    await host.prepareRecovery();
    const armed = await host.handlers['goal.arm'](
      {
        sessionId: session.id,
        condition: 'All tests pass',
        maxIterations: null,
        tokenBudget: null,
      },
      operationContext('connection-1'),
    );
    assert.ok(armed.ok);
    if (!armed.ok) return;
    for (let tick = 0; tick < 20; tick += 1) await new Promise((r) => setImmediate(r));
    assert.equal(admitted, 0, 'arming alone must start nothing');

    const paused = await host.handlers['goal.control'](
      {
        sessionId: session.id,
        goalId: armed.result.goal.goalId,
        expectedRevision: armed.result.goal.revision,
        action: 'pause',
      },
      operationContext('connection-1'),
    );
    assert.ok(paused.ok && paused.result.goal.status === 'paused');
    if (!paused.ok) return;

    // Resume is the user saying go, and the control that sends it promises
    // continuation starts immediately. From here the Goal drives itself,
    // whether or not a Turn ever carried it.
    const resumed = await host.handlers['goal.control'](
      {
        sessionId: session.id,
        goalId: paused.result.goal.goalId,
        expectedRevision: paused.result.goal.revision,
        action: 'resume',
      },
      operationContext('connection-1'),
    );
    assert.ok(resumed.ok && resumed.result.goal.status === 'active');
    if (!resumed.ok) return;
    for (let tick = 0; tick < 20; tick += 1) await new Promise((r) => setImmediate(r));
    assert.equal(admitted, 1, 'resume promised continuation and started none');
    assert.equal(evaluated, 0, 'resume drives the next Turn without evaluating one');
    await waitForAsync(
      async () =>
        (await goalStore.read(session.id))?.record.goal.revision === resumed.result.goal.revision,
    );
    assert.equal(
      (await goalStore.read(session.id))?.record.currentExecution,
      null,
      'a busy admission records no execution, so only the Goal carries the drive',
    );
    await host.close();

    // The resume outlived the process that took it: nothing else is left to
    // say the user asked for continuation.
    let admittedAfterRestart = 0;
    let evaluatedAfterRestart = 0;
    const restarted = new HostGoalCoordinator({
      store: goalStore,
      stores,
      executions: {
        reconcile: async () => assert.fail('A busy admission left no execution to recover'),
        subscribe: () => () => undefined,
      },
      sessionAdmission: new SessionAdmissionGate(),
      evaluator: {
        evaluate: async () => {
          evaluatedAfterRestart += 1;
          return '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"x"}';
        },
        close: async () => {},
      },
      admitTurn: () => {
        admittedAfterRestart += 1;
        return { kind: 'busy', whenIdle: new Promise<void>(() => {}) };
      },
      listActionableTaskKeys: async () => [],
      acquireResidency: () => ({ release: () => {} }),
      onProjectionChanged: () => {},
      requestDrain: () => {},
    });
    await restarted.prepareRecovery();
    await restarted.recover();
    for (let tick = 0; tick < 20; tick += 1) await new Promise((r) => setImmediate(r));
    assert.equal(admittedAfterRestart, 1, 'the restart dropped a resume the user had already made');
    assert.equal(evaluatedAfterRestart, 0, 'recovery drives the next Turn without evaluating one');
    await restarted.close();
  } finally {
    await goalStore.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('an arm admitted before the drain creates no Goal after it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-goal-arm-drain-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const goalStore = await openInteractiveGoalAuthorityForWrite(owner.lease);
  try {
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const sessionAdmission = new SessionAdmissionGate();
    const host = new HostGoalCoordinator({
      store: goalStore,
      stores,
      executions: {
        reconcile: async () => assert.fail('A refused arm has no execution'),
        subscribe: () => () => undefined,
      },
      sessionAdmission,
      evaluator: {
        evaluate: async () => assert.fail('A refused arm must not evaluate a Goal'),
        close: async () => {},
      },
      admitTurn: () => assert.fail('A refused arm must not admit a Turn'),
      listActionableTaskKeys: async () => [],
      acquireResidency: () => ({ release: () => {} }),
      onProjectionChanged: () => {},
      requestDrain: () => {},
      newId: () => 'goal-arm-after-drain',
    });
    await host.prepareRecovery();

    // Hold this Session's admission so the arm is admitted but still queued
    // when the composition begins to drain — the one window in which the
    // Goal manager is already cleared and the callback has yet to run.
    let releaseHolder = () => {};
    const holder = sessionAdmission.run(
      session.id,
      () =>
        new Promise<void>((resolve) => {
          releaseHolder = () => resolve();
        }),
    );
    const arming = host.handlers['goal.arm'](
      {
        sessionId: session.id,
        condition: 'All tests pass',
        maxIterations: null,
        tokenBudget: null,
      },
      operationContext('connection-1'),
    );
    for (let tick = 0; tick < 5; tick += 1) await new Promise((r) => setImmediate(r));
    host.beginDrain();
    releaseHolder();
    await holder;

    const outcome = await arming;
    assert.equal(outcome.ok, false, 'a draining Host answered an arm with success');
    assert.equal(outcome.ok === false && outcome.error.code, 'host_draining');
    assert.equal(host.readProjection(session.id), null, 'the drained Host holds a new Goal');
    for (let tick = 0; tick < 20; tick += 1) await new Promise((r) => setImmediate(r));
    assert.equal(await goalStore.read(session.id), null, 'the drain persisted a new Goal');
    await host.close();
  } finally {
    await goalStore.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

function operationContext(connectionId: string) {
  return {
    hostEpoch: 'epoch-1',
    connectionId,
    principal: 'local_os_user' as const,
    acquireResidency: () => ({ release() {} }),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Goal continuation');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitForAsync(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for durable Goal state');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
