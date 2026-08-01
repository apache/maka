import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BackendRegistry,
  FakeBackend,
  goalCheckpoint,
  SessionManager,
  type RuntimeHostedRootAuthority,
} from '@maka/runtime';
import {
  openInteractiveExecutionStoresForWrite,
  type InteractiveExecutionStoresWriter,
} from '@maka/storage/execution-stores';
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
    const admission = fixture.coordinator.admitGoalTurn(
      fixture.sessionId,
      goalCheckpoint(created),
      controlLease,
      'Continue the Goal',
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
    const admission = fixture.coordinator.admitGoalTurn(
      fixture.sessionId,
      goalCheckpoint(created),
      controlLease,
      'This stale continuation must never run',
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

interface Fixture {
  readonly owner: InteractiveRootOwner;
  readonly base: string;
  readonly stores: InteractiveExecutionStoresWriter;
  readonly sessionId: string;
  readonly rootAdmissions: RootAdmissionOwner;
  readonly coordinator: RootTurnCoordinator;
  readonly goal: HostGoalCoordinator;
  readonly messages: HostMessageCoordinator;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly drainRequested: () => boolean;
  close(): Promise<void>;
}

async function createFixture(options: { recoverAdmissions?: boolean } = {}): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'maka-goal-root-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire test root');
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const session = await stores.sessionStore.create({
    cwd: capability.canonicalPath,
    backend: 'fake',
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
  const rootPort: HostMessageRootPort = {
    readSessionHeader: (sessionId) => requireCoordinator(coordinator).readSessionHeader(sessionId),
    readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
    claimStopFence: (input, commitQueueFence, lease) =>
      requireCoordinator(coordinator).claimStopFence(input, commitQueueFence, lease),
    startFromMessage: (input, lease) =>
      requireCoordinator(coordinator).startFromMessage(input, lease),
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
    sessionAdmission: admission,
    preflightSessionSnapshot: (sessionId, interactions) =>
      canonical.fitsCandidate(sessionId, { interactions }),
    refreshCanonicalContinuity: (sessionId, lease) =>
      requireContinuity(continuity).refreshCanonical(sessionId, lease),
    onPoison: () => {
      requestedDrain = true;
    },
  });
  const backends = new BackendRegistry();
  backends.register('fake', (context) => new FakeBackend(context));
  const authority: RuntimeHostedRootAuthority = {
    bindRun: (identity) => messages.bindRun(identity),
    executeRoot: (input) => requireCoordinator(coordinator).executeRoot(input),
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
  goal = new HostGoalCoordinator({
    stores,
    sessionAdmission: admission,
    evaluator: {
      evaluate: async () =>
        '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"verified"}',
      close: async () => {},
    },
    admitTurn: (sessionId, text, checkpoint, controlLease) =>
      rootCoordinator.admitGoalTurn(sessionId, checkpoint, controlLease, text),
    listActionableTaskKeys: async () => [],
    acquireResidency,
    onProjectionChanged: (sessionId) =>
      requireContinuity(continuity).enqueueCanonicalRefresh(sessionId),
  });
  const goalCoordinator = goal;

  return {
    owner,
    base,
    stores,
    sessionId: session.id,
    rootAdmissions,
    coordinator: rootCoordinator,
    goal: goalCoordinator,
    messages,
    sessionAdmission: admission,
    drainRequested: () => requestedDrain,
    async close() {
      goalCoordinator.beginDrain();
      rootCoordinator.beginDrain();
      await goalCoordinator.close();
      await rootCoordinator.close();
      await messages.close();
      await interactions.close();
      continuity?.close();
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

function operationContext() {
  return {
    hostEpoch: 'goal-root-epoch',
    connectionId: 'connection-1',
    surface: 'tui' as const,
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
