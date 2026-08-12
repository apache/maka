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
      backend: 'fake',
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
      backend: 'fake',
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
    await stores.sessionStore.setSessionsLifecycleVersioned(
      [{ sessionId: session.id, expectedVersion: header.revision }],
      'archived',
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
      backend: 'fake',
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
      backend: 'fake',
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

function operationContext(connectionId: string) {
  return {
    hostEpoch: 'epoch-1',
    connectionId,
    surface: 'tui' as const,
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
