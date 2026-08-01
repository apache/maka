import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { GoalTurnOutcome } from '@maka/runtime';
import { HostGoalCoordinator } from '../server/goal-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('one Host Goal is shared across clients with CAS control and crash-clear residency', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-goal-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;

  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
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
      stores,
      sessionAdmission: new SessionAdmissionGate(),
      evaluator: {
        evaluate: async () =>
          '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"continue"}',
        close: async () => {},
      },
      admitTurn: (_sessionId, text) => {
        admittedText = text;
        return { kind: 'prepared', turnId: 'goal-turn-1', start: () => goalTurn };
      },
      listActionableTaskKeys: async () => [],
      acquireResidency: () => {
        acquired++;
        return { release: () => released++ };
      },
      onProjectionChanged: () => {},
      newId: () => 'goal-1',
      now: () => 10,
    });

    const external = coordinator.beginObservedTurn(session.id, 'turn-1');
    assert.equal(external.kind, 'registered');
    if (external.kind !== 'registered') return;
    const created = coordinator.continuation.activateGoal(
      session.id,
      'turn-1',
      () => coordinator.manager.create(session.id, 'Finish the whole slice').goal,
    );
    assert.equal(created?.status, 'active');
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
    assert.equal(released, 1);
    settleGoalTurn({ kind: 'completed', turnId: 'goal-turn-1' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(coordinator.manager.get(session.id)?.status, 'cleared');

    coordinator.manager.create(session.id, 'A second Host-epoch Goal');
    assert.equal(acquired, 2);
    coordinator.beginDrain();
    assert.equal(released, 2);
    assert.equal(coordinator.readProjection(session.id), null);
    await coordinator.close();
    assert.equal(released, 2, 'close must not release Goal residency twice');
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

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
