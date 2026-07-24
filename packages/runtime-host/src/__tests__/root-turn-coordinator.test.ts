import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BackendRegistry,
  classifyTerminalRuntimeLedger,
  FakeBackend,
  FAKE_ASK_USER_QUESTION_PROMPT,
  LOCAL_READ_AGENT_PROFILE,
  RuntimeHostedRootConflictError,
  SessionManager,
  type RuntimeHostedRootAuthority,
} from '@maka/runtime';
import type { AgentBackend, BackendSendInput } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import type { MakaTool } from '@maka/runtime';
import {
  openInteractiveExecutionStoresForWrite,
  type RootTurnAdmissionStore,
} from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { SubscriptionFrame } from '../protocol/index.js';
import { CanonicalSessionProjectionReader } from '../server/canonical-session-projection.js';
import type { RuntimeHostResidency } from '../server/host-kernel.js';
import { type HostMessageRootPort, HostMessageCoordinator } from '../server/message-coordinator.js';
import { RootAdmissionOwner } from '../server/root-admission-owner.js';
import { RootTurnCoordinator } from '../server/root-turn-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { SessionContinuityCoordinator } from '../server/session-continuity-coordinator.js';
import type { SessionContinuityFrameSink } from '../server/session-continuity-service.js';

const HOLD_EXTERNAL_PROMPT = 'hold external root before follow-up';

test('hosted linked child roots share admission, message, terminal, and stop authority', {
  timeout: 20_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-linked-root-authority-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire test root');

  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const parent = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const sessionAdmission = new SessionAdmissionGate();
    const rootAdmissionOwner = new RootAdmissionOwner(stores.agentRunStore);
    await rootAdmissionOwner.recoverSession(parent.id);
    const acquireResidency = (): RuntimeHostResidency => ({ release() {} });
    let coordinator: RootTurnCoordinator | undefined;
    let continuity: SessionContinuityCoordinator | undefined;
    let drainRequested = false;
    const rootPort: HostMessageRootPort = {
      readSessionHeader: (sessionId) =>
        requireCoordinator(coordinator).readSessionHeader(sessionId),
      readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
      startFromMessage: (input, admission) =>
        requireCoordinator(coordinator).startFromMessage(input, admission),
      claimStop: (input, commitQueueFence) =>
        requireCoordinator(coordinator).claimStop(input, commitQueueFence),
    };
    const hostEpoch = 'epoch-linked-root';
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
      sessionAdmission,
      acquireResidency,
      requestDrain: () => {
        drainRequested = true;
      },
      onProjectionChanged: (sessionId) =>
        requireContinuity(continuity).enqueueCanonicalRefresh(sessionId),
    });
    const canonicalProjection = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions: rootAdmissionOwner,
      messages,
    });
    continuity = new SessionContinuityCoordinator(
      hostEpoch,
      (sessionId) => canonicalProjection.read(sessionId),
      sessionAdmission,
      () => {
        drainRequested = true;
      },
    );
    const authority: RuntimeHostedRootAuthority = {
      bindRun: (identity) => messages.bindRun(identity),
      executeRoot: (input) => requireCoordinator(coordinator).executeRoot(input),
      stopRoot: (identity, input) => requireCoordinator(coordinator).stopRoot(identity, input),
      stopSession: (sessionId, input) =>
        requireCoordinator(coordinator).stopSession(sessionId, input),
    };
    const backends = new BackendRegistry();
    const linkedBackends = new Map<string, LinkedChildAuthorityBackend>();
    backends.register('fake', (context) => {
      if (!context.header.subagentRuntime) {
        return new PermissionWaitingBackend(context.sessionId);
      }
      const backend = new LinkedChildAuthorityBackend(context.sessionId);
      linkedBackends.set(context.sessionId, backend);
      return backend;
    });
    const manager = new SessionManager({
      store: stores.sessionStore,
      runStore: stores.agentRunStore,
      runtimeEventStore: stores.runtimeEventStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: randomUUID,
      now: Date.now,
      messageAuthority: authority,
    });
    coordinator = new RootTurnCoordinator(
      manager,
      stores,
      sessionAdmission,
      rootAdmissionOwner,
      messages,
      continuity,
      acquireResidency,
      () => {
        drainRequested = true;
      },
    );

    const parentSink = new RecordingContinuitySink();
    const parentConnectionId = 'connection-waiting-parent';
    const parentConnection = continuity.attachConnection(parentConnectionId, parentSink);
    const parentOpened = await continuity.handlers['subscription.open'](
      { sessionId: parent.id },
      operationContext(hostEpoch, acquireResidency, parentConnectionId),
    );
    assert.equal(parentOpened.ok, true);
    if (!parentOpened.ok) return;
    parentConnection.activate(parentOpened.result.subscriptionId);

    const parentTurnId = randomUUID();
    const parentStarted = await coordinator.handlers['turn.start'](
      {
        sessionId: parent.id,
        turnId: parentTurnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      },
      operationContext('epoch-linked-root', acquireResidency),
    );
    assert.equal(parentStarted.ok, true);
    if (!parentStarted.ok) return;
    await waitForContinuityFrame(
      parentSink,
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.session.status === 'waiting_for_user',
    );

    let initialReady:
      | {
          childSessionId: string;
          turnId: string;
          runId: string;
          agentId: string;
          agentName: string;
        }
      | undefined;
    let initialEventCount = 0;
    const childSink = new RecordingContinuitySink();
    let closeChildContinuity: (() => void) | undefined;
    const child = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentStarted.result.runId,
        parentTurnId,
        toolCallId: 'linked-initial',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'initial linked child',
      onReady: async (ready) => {
        initialReady = ready;
        const childConnectionId = 'connection-linked-child';
        const childContinuity = requireContinuity(continuity);
        const connection = childContinuity.attachConnection(childConnectionId, childSink);
        const opened = await childContinuity.handlers['subscription.open'](
          { sessionId: ready.childSessionId },
          operationContext(hostEpoch, acquireResidency, childConnectionId),
        );
        assert.equal(opened.ok, true);
        if (!opened.ok) throw new Error('Unable to subscribe to hosted linked child');
        connection.activate(opened.result.subscriptionId);
        closeChildContinuity = () => connection.close();
      },
      onEvent: () => {
        initialEventCount += 1;
      },
    });
    assert.equal(child.status, 'completed');
    assert.deepEqual(initialReady, {
      childSessionId: child.childSessionId,
      turnId: child.turnId,
      runId: child.runId,
      agentId: child.agentId,
      agentName: child.agentName,
    });
    assert.equal(initialEventCount, child.eventCount);
    assert.ok(
      childSink.frames.some(
        (frame) =>
          frame.kind === 'subscription.session_delta' &&
          frame.sessionId === child.childSessionId &&
          frame.delta.turnId === child.turnId &&
          frame.delta.runId === child.runId &&
          frame.delta.kind === 'text' &&
          frame.delta.text === 'linked child complete',
      ),
    );
    assert.ok(
      childSink.frames.some(
        (frame) =>
          frame.kind === 'subscription.session_projection' &&
          frame.snapshot.rootTurn?.turnId === child.turnId &&
          frame.snapshot.rootTurn.runId === child.runId &&
          frame.snapshot.rootTurn.status === 'completed',
      ),
    );
    const initialAdmissions = await stores.agentRunStore.listRootTurnAdmissionsForRecovery(
      child.childSessionId,
    );
    assert.equal(initialAdmissions.length, 1);
    assert.equal(initialAdmissions[0]?.runId, child.runId);
    assert.ok(initialAdmissions[0]?.userMessageId);
    assert.deepEqual(initialAdmissions[0]?.execution, {
      kind: 'linked_child_initial',
      agentId: child.agentId,
      agentName: child.agentName,
    });
    const externalJoin = await coordinator.handlers['turn.start'](
      {
        sessionId: child.childSessionId,
        turnId: child.turnId,
        content: { text: 'initial linked child' },
      },
      operationContext(hostEpoch, acquireResidency),
    );
    assert.deepEqual(externalJoin, {
      ok: false,
      error: {
        code: 'operation_conflict',
        message: 'Turn identity belongs to a different execution kind',
      },
    });

    const resumeAbort = new AbortController();
    resumeAbort.abort();
    const runsBeforeAbortedResume = await stores.agentRunStore.listSessionRuns(
      child.childSessionId,
    );
    const sendsBeforeAbortedResume = linkedBackends.get(child.childSessionId)?.sendCount;
    let abortedResumeReady = 0;
    await assert.rejects(
      manager.resumeChildAgent(parent.id, {
        parentRunId: parentStarted.result.runId,
        sourceRunId: child.runId,
        prompt: 'must not start',
        abortSignal: resumeAbort.signal,
        onReady: () => {
          abortedResumeReady += 1;
        },
      }),
      { name: 'AbortError' },
    );
    assert.equal(
      (await stores.agentRunStore.listSessionRuns(child.childSessionId)).length,
      runsBeforeAbortedResume.length,
    );
    assert.equal(linkedBackends.get(child.childSessionId)?.sendCount, sendsBeforeAbortedResume);
    assert.equal(abortedResumeReady, 0);

    let resumeReadyRunId: string | undefined;
    let resumeEventCount = 0;
    const resumed = await manager.resumeChildAgent(parent.id, {
      parentRunId: parentStarted.result.runId,
      sourceRunId: child.runId,
      prompt: 'rate limit this resumed child',
      onReady: (ready) => {
        resumeReadyRunId = ready.runId;
      },
      onEvent: () => {
        resumeEventCount += 1;
      },
    });
    assert.equal(resumed.status, 'failed');
    assert.equal(resumed.failureClass, 'RateLimit');
    assert.equal(resumed.resumedFromRunId, child.runId);
    assert.equal(resumeReadyRunId, resumed.runId);
    assert.equal(resumeEventCount, resumed.eventCount);

    let retryReadyRunId: string | undefined;
    let retryEventCount = 0;
    const retried = await manager.retryChildAgent(parent.id, {
      parentRunId: parentStarted.result.runId,
      sourceRunId: resumed.runId!,
      execution: {
        kind: 'child_session',
        sessionId: child.childSessionId,
        currentRunId: resumed.runId,
      },
      onReady: (ready) => {
        retryReadyRunId = ready.runId;
      },
      onEvent: () => {
        retryEventCount += 1;
      },
    });
    assert.equal(retried.status, 'completed');
    assert.equal(retried.retriedFromRunId, resumed.runId);
    assert.equal(retryReadyRunId, retried.runId);
    assert.equal(retryEventCount, retried.eventCount);
    const admissions = await stores.agentRunStore.listRootTurnAdmissionsForRecovery(
      child.childSessionId,
    );
    assert.equal(admissions.length, 3);
    assert.equal(admissions[1]?.runId, resumed.runId);
    assert.ok(admissions[1]?.userMessageId);
    assert.deepEqual(admissions[1]?.execution, {
      kind: 'linked_child_resume',
      agentId: resumed.agentId,
      agentName: resumed.agentName,
      sourceRunId: child.runId,
    });
    assert.equal(admissions[2]?.runId, retried.runId);
    assert.equal(admissions[2]?.userMessageId, null);
    assert.deepEqual(admissions[2]?.execution, {
      kind: 'linked_child_provider_retry',
      agentId: retried.agentId,
      agentName: retried.agentName,
      sourceRunId: resumed.runId,
    });
    const retryMessages = (await stores.sessionStore.readMessages(child.childSessionId)).filter(
      (message) => 'turnId' in message && message.turnId === retried.turnId,
    );
    assert.deepEqual(retryMessages, []);
    assert.deepEqual(coordinator.readRootState(child.childSessionId), { kind: 'idle' });

    const externalTurnId = randomUUID();
    const external = await coordinator.handlers['turn.start'](
      {
        sessionId: child.childSessionId,
        turnId: externalTurnId,
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(hostEpoch, acquireResidency),
    );
    assert.equal(external.ok, true);
    if (!external.ok) return;
    const queuedFollowup = await messages.handlers['turn.message.submit'](
      {
        originHostEpoch: hostEpoch,
        sessionId: child.childSessionId,
        messageId: randomUUID(),
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
        placement: 'next_turn',
      },
      operationContext(hostEpoch, acquireResidency),
    );
    assert.equal(queuedFollowup.ok && queuedFollowup.result.disposition, 'followup');
    linkedBackends.get(child.childSessionId)?.release();
    await waitUntil(() => {
      const state = requireCoordinator(coordinator).readRootState(child.childSessionId);
      return state.kind === 'active' && state.turnId !== externalTurnId;
    });
    const followupState = coordinator.readRootState(child.childSessionId);
    assert.equal(followupState.kind, 'active');
    if (followupState.kind !== 'active') return;

    await assert.rejects(
      manager.resumeChildAgent(parent.id, {
        parentRunId: parentStarted.result.runId,
        sourceRunId: retried.runId!,
        prompt: 'internal resume racing the external follow-up',
      }),
      (error) => {
        assert.ok(error instanceof RuntimeHostedRootConflictError);
        assert.equal(error.code, 'session_busy');
        assert.deepEqual(error.scope, {
          kind: 'session',
          sessionId: child.childSessionId,
        });
        return true;
      },
    );
    assert.equal(drainRequested, false);
    await coordinator.stopRoot(followupState);
    assert.deepEqual(coordinator.readRootState(child.childSessionId), { kind: 'idle' });

    const failedResume = await manager.resumeChildAgent(parent.id, {
      parentRunId: parentStarted.result.runId,
      sourceRunId: retried.runId!,
      prompt: 'rate limit one more linked child',
    });
    assert.equal(failedResume.status, 'failed');
    const linkedBackend = linkedBackends.get(child.childSessionId);
    assert.ok(linkedBackend);
    const runsBeforeAbortedRetry = await stores.agentRunStore.listSessionRuns(child.childSessionId);
    const sendsBeforeAbortedRetry = linkedBackend?.sendCount;
    const retryAbort = new AbortController();
    retryAbort.abort();
    let abortedRetryReady = 0;
    await assert.rejects(
      manager.retryChildAgent(parent.id, {
        parentRunId: parentStarted.result.runId,
        sourceRunId: failedResume.runId!,
        abortSignal: retryAbort.signal,
        onReady: () => {
          abortedRetryReady += 1;
        },
      }),
      { name: 'AbortError' },
    );
    assert.equal(
      (await stores.agentRunStore.listSessionRuns(child.childSessionId)).length,
      runsBeforeAbortedRetry.length,
    );
    assert.equal(linkedBackend?.sendCount, sendsBeforeAbortedRetry);
    assert.equal(abortedRetryReady, 0);
    assert.equal(drainRequested, false);

    const abortController = new AbortController();
    let joinedInitial: Promise<typeof child> | undefined;
    const interrupted = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentStarted.result.runId,
        parentTurnId,
        toolCallId: 'linked-interrupt',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: FAKE_ASK_USER_QUESTION_PROMPT,
      abortSignal: abortController.signal,
      onReady: () => {
        joinedInitial = manager.spawnChildSession(parent.id, {
          spawnedBy: {
            parentRunId: parentStarted.result.runId,
            parentTurnId,
            toolCallId: 'linked-interrupt',
          },
          agentProfile: LOCAL_READ_AGENT_PROFILE,
          prompt: FAKE_ASK_USER_QUESTION_PROMPT,
        });
        abortController.abort();
      },
    });
    assert.ok(joinedInitial);
    const joinedInterrupted = await joinedInitial;
    assert.equal(interrupted.status, 'cancelled');
    assert.deepEqual(joinedInterrupted, interrupted);
    const interruptedRun = await stores.agentRunStore.readRun(
      interrupted.childSessionId,
      interrupted.runId,
    );
    const interruptedEvents = await stores.runtimeEventStore.readImmutableRuntimeEvents(
      interrupted.childSessionId,
      interrupted.runId,
    );
    const interruptedTerminal = classifyTerminalRuntimeLedger(interruptedRun, interruptedEvents);
    assert.equal(interruptedTerminal.kind, 'fact');
    if (interruptedTerminal.kind === 'fact') {
      assert.equal(interruptedTerminal.fact.runStatus, 'cancelled');
    }
    assert.deepEqual(coordinator.readRootState(interrupted.childSessionId), { kind: 'idle' });
    assert.equal(drainRequested, false);

    await coordinator.stopRoot({
      sessionId: parent.id,
      turnId: parentTurnId,
      runId: parentStarted.result.runId,
    });
    await coordinator.close();
    await messages.close();
    parentConnection.close();
    closeChildContinuity?.();
    continuity.close();
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('pre-bind startup failure fail-stops without orphaning an admitted queued Message', {
  timeout: 20_000,
}, async () => {
  const backendFactoryEntered = deferred<void>();
  const releaseBackendFactory = deferred<void>();
  const fixture = await createFailureFixture({
    registerBackend: (backends) => {
      backends.register('fake', async () => {
        backendFactoryEntered.resolve();
        await releaseBackendFactory.promise;
        throw new Error('injected backend startup failure');
      });
    },
  });

  try {
    const turnId = 'turn-pre-bind-failure';
    const starting = fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'start then fail before binding the Run' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    await backendFactoryEntered.promise;
    const admission = await fixture.stores.agentRunStore.readRootTurnAdmission(
      fixture.sessionId,
      turnId,
    );
    assert.ok(admission);
    if (!admission) return;

    const submitted = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: 'message-held-across-startup-failure',
        content: { text: 'retain this accepted follow-up' },
        placement: 'next_turn',
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(submitted.ok && submitted.result.disposition, 'followup');

    releaseBackendFactory.resolve();
    await assert.rejects(starting, /injected backend startup failure/);

    const expectedOwner = {
      kind: 'active' as const,
      sessionId: fixture.sessionId,
      turnId,
      runId: admission.runId,
    };
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), expectedOwner);
    assert.deepEqual(
      fixture.messages.projection(fixture.sessionId).followup.map((entry) => entry.messageId),
      ['message-held-across-startup-failure'],
    );
    assert.equal(fixture.liveResidencies(), 2);
    assert.equal(fixture.drainRequested(), true);

    const rejected = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: 'message-after-startup-failure',
        content: { text: 'must not enter a failed Host Epoch' },
        placement: 'next_turn',
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, 'host_draining');

    await assert.rejects(fixture.coordinator.close());
    await assert.rejects(fixture.messages.close(), /live owner, entry, or transition/);
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), expectedOwner);
    assert.equal(fixture.liveResidencies(), 2);
  } finally {
    await fixture.dispose();
  }
});

test('successor admission failure retains the terminal transition and its confirmed Message', {
  timeout: 20_000,
}, async () => {
  let backend: LinkedChildAuthorityBackend | undefined;
  const fixture = await createFailureFixture({
    registerBackend: (backends) => {
      backends.register('fake', () => {
        backend = new LinkedChildAuthorityBackend('terminal-admission-failure');
        return backend;
      });
    },
    wrapAdmissionStore: (store) => ({
      admitRootTurn: async (input) => {
        if (input.previousRootTurnId !== null) {
          throw new Error('injected successor admission write failure');
        }
        return store.admitRootTurn(input);
      },
      readRootTurnAdmission: (sessionId, turnId) => store.readRootTurnAdmission(sessionId, turnId),
      readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
        store.readRootTurnSourceMessageReceipt(sessionId, messageId),
      listRootTurnAdmissionsForRecovery: (sessionId) =>
        store.listRootTurnAdmissionsForRecovery(sessionId),
    }),
  });

  try {
    const turnId = 'turn-successor-admission-failure';
    const started = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const submitted = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: 'message-held-in-terminal-transition',
        content: { text: 'retain this confirmed successor input' },
        placement: 'next_turn',
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(submitted.ok && submitted.result.disposition, 'followup');

    backend?.release();
    await waitUntil(() => fixture.drainRequested());

    const expectedOwner = {
      kind: 'active' as const,
      sessionId: fixture.sessionId,
      turnId,
      runId: started.result.runId,
    };
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), expectedOwner);
    assert.deepEqual(
      fixture.messages.projection(fixture.sessionId).followup.map((entry) => entry.messageId),
      ['message-held-in-terminal-transition'],
    );
    assert.equal(fixture.liveResidencies(), 2);
    assert.equal(
      (await fixture.stores.agentRunStore.listRootTurnAdmissionsForRecovery(fixture.sessionId))
        .length,
      1,
    );

    const rejected = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: 'message-after-successor-admission-failure',
        content: { text: 'must not enter a failed Host Epoch' },
        placement: 'next_turn',
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, 'host_draining');

    await assert.rejects(fixture.coordinator.close(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.errors.some(
          (cause) =>
            cause instanceof Error &&
            cause.message === 'Stop fence cannot replace a terminal transition',
        ),
        true,
      );
      return true;
    });
    await assert.rejects(fixture.messages.close(), /live owner, entry, or transition/);
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), expectedOwner);
    assert.deepEqual(
      fixture.messages.projection(fixture.sessionId).followup.map((entry) => entry.messageId),
      ['message-held-in-terminal-transition'],
    );
    assert.equal(fixture.liveResidencies(), 2);
  } finally {
    await fixture.dispose();
  }
});

test('shutdown re-scans a successor created by an in-flight terminal handoff', {
  timeout: 20_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-root-turn-close-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire test root');

  try {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const followupAdmissionStarted = deferred<void>();
    const releaseFollowupAdmission = deferred<void>();
    const admissionStore: RootTurnAdmissionStore = {
      admitRootTurn: async (input) => {
        if (input.previousRootTurnId !== null) {
          followupAdmissionStarted.resolve();
          await releaseFollowupAdmission.promise;
        }
        return stores.agentRunStore.admitRootTurn(input);
      },
      readRootTurnAdmission: (sessionId, turnId) =>
        stores.agentRunStore.readRootTurnAdmission(sessionId, turnId),
      readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
        stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
      listRootTurnAdmissionsForRecovery: (sessionId) =>
        stores.agentRunStore.listRootTurnAdmissionsForRecovery(sessionId),
    };
    const rootAdmissionOwner = new RootAdmissionOwner(admissionStore);
    await rootAdmissionOwner.recoverSession(session.id);

    let liveResidencies = 0;
    const acquireResidency = (): RuntimeHostResidency => {
      liveResidencies += 1;
      let released = false;
      return {
        release: () => {
          assert.equal(released, false);
          released = true;
          liveResidencies -= 1;
        },
      };
    };
    const sessionAdmission = new SessionAdmissionGate();
    let coordinator: RootTurnCoordinator | undefined;
    let continuity: SessionContinuityCoordinator | undefined;
    const rootPort: HostMessageRootPort = {
      readSessionHeader: (sessionId) =>
        requireCoordinator(coordinator).readSessionHeader(sessionId),
      readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
      startFromMessage: (input, admission) =>
        requireCoordinator(coordinator).startFromMessage(input, admission),
      claimStop: (input, commitQueueFence) =>
        requireCoordinator(coordinator).claimStop(input, commitQueueFence),
    };
    const hostEpoch = 'epoch-close-handoff';
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
      sessionAdmission,
      acquireResidency,
      onProjectionChanged: (sessionId) =>
        requireContinuity(continuity).enqueueCanonicalRefresh(sessionId),
    });
    const canonicalProjection = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions: rootAdmissionOwner,
      messages,
    });
    continuity = new SessionContinuityCoordinator(
      hostEpoch,
      (sessionId) => canonicalProjection.read(sessionId),
      sessionAdmission,
    );
    const backends = new BackendRegistry();
    backends.register('fake', (context) => new FakeBackend(context));
    const manager = new SessionManager({
      store: stores.sessionStore,
      runStore: stores.agentRunStore,
      runtimeEventStore: stores.runtimeEventStore,
      backends,
      newId: randomUUID,
      now: Date.now,
      messageAuthority: messages,
    });
    let drainRequested = false;
    coordinator = new RootTurnCoordinator(
      manager,
      stores,
      sessionAdmission,
      rootAdmissionOwner,
      messages,
      continuity,
      acquireResidency,
      () => {
        drainRequested = true;
      },
    );

    const firstTurnId = 'turn-close-first';
    const started = await coordinator.handlers['turn.start'](
      {
        sessionId: session.id,
        turnId: firstTurnId,
        content: { text: `long-running root ${'x'.repeat(540)}` },
      },
      operationContext(hostEpoch, acquireResidency),
    );
    assert.equal(started.ok, true);
    const followup = await messages.handlers['turn.message.submit'](
      {
        originHostEpoch: hostEpoch,
        sessionId: session.id,
        messageId: 'message-close-followup',
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
        placement: 'next_turn',
      },
      operationContext(hostEpoch, acquireResidency),
    );
    assert.equal(followup.ok && followup.result.disposition, 'followup');

    await followupAdmissionStarted.promise;
    messages.beginDrain();
    const closing = coordinator.close();
    assert.equal(await settlesWithin(closing, 25), false);
    releaseFollowupAdmission.resolve();
    await closing;
    await messages.close();
    continuity.close();

    assert.deepEqual(coordinator.readRootState(session.id), { kind: 'idle' });
    assert.equal(liveResidencies, 0);
    assert.equal(drainRequested, false);
    const admissions = await stores.agentRunStore.listRootTurnAdmissionsForRecovery(session.id);
    assert.equal(admissions.length, 2);
    const successor = admissions[1];
    assert.ok(successor);
    const run = await stores.agentRunStore.readRun(session.id, successor.runId);
    const runtimeEvents = await stores.runtimeEventStore.readImmutableRuntimeEvents(
      session.id,
      successor.runId,
    );
    const terminal = classifyTerminalRuntimeLedger(run, runtimeEvents);
    assert.equal(terminal.kind, 'fact');
    if (terminal.kind === 'fact') assert.equal(terminal.fact.runStatus, 'cancelled');
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});

async function createFailureFixture(options: {
  registerBackend(backends: BackendRegistry): void;
  wrapAdmissionStore?(store: RootTurnAdmissionStore): RootTurnAdmissionStore;
}) {
  const base = await mkdtemp(join(tmpdir(), 'maka-root-turn-message-failure-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'root'),
    kind: 'interactive',
  });
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
  const admissionStore = options.wrapAdmissionStore?.(stores.agentRunStore) ?? stores.agentRunStore;
  const rootAdmissionOwner = new RootAdmissionOwner(admissionStore);
  await rootAdmissionOwner.recoverSession(session.id);
  const sessionAdmission = new SessionAdmissionGate();
  let liveResidencies = 0;
  const acquireResidency = (): RuntimeHostResidency => {
    liveResidencies += 1;
    let released = false;
    return {
      release: () => {
        assert.equal(released, false);
        released = true;
        liveResidencies -= 1;
      },
    };
  };
  let drainRequested = false;
  let coordinator: RootTurnCoordinator | undefined;
  let continuity: SessionContinuityCoordinator | undefined;
  const rootPort: HostMessageRootPort = {
    readSessionHeader: (sessionId) => requireCoordinator(coordinator).readSessionHeader(sessionId),
    readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
    startFromMessage: (input, admission) =>
      requireCoordinator(coordinator).startFromMessage(input, admission),
    claimStop: (input, commitQueueFence) =>
      requireCoordinator(coordinator).claimStop(input, commitQueueFence),
  };
  const hostEpoch = 'epoch-message-failure';
  await stores.messageReceiptStore.beginHostEpoch(hostEpoch);
  const requestDrain = () => {
    drainRequested = true;
  };
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
    sessionAdmission,
    acquireResidency,
    requestDrain,
    onProjectionChanged: (sessionId) =>
      requireContinuity(continuity).enqueueCanonicalRefresh(sessionId),
  });
  const canonicalProjection = new CanonicalSessionProjectionReader({
    stores,
    rootAdmissions: rootAdmissionOwner,
    messages,
  });
  continuity = new SessionContinuityCoordinator(
    hostEpoch,
    (sessionId) => canonicalProjection.read(sessionId),
    sessionAdmission,
    requestDrain,
  );
  const backends = new BackendRegistry();
  options.registerBackend(backends);
  const manager = new SessionManager({
    store: stores.sessionStore,
    runStore: stores.agentRunStore,
    runtimeEventStore: stores.runtimeEventStore,
    backends,
    newId: randomUUID,
    now: Date.now,
    messageAuthority: messages,
  });
  coordinator = new RootTurnCoordinator(
    manager,
    stores,
    sessionAdmission,
    rootAdmissionOwner,
    messages,
    continuity,
    acquireResidency,
    requestDrain,
  );

  return {
    stores,
    sessionId: session.id,
    hostEpoch,
    messages,
    coordinator,
    acquireResidency,
    liveResidencies: () => liveResidencies,
    drainRequested: () => drainRequested,
    dispose: async () => {
      continuity.close();
      await owner.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

function requireCoordinator(coordinator: RootTurnCoordinator | undefined): RootTurnCoordinator {
  if (!coordinator) throw new Error('RootTurnCoordinator is not composed');
  return coordinator;
}

function requireContinuity(
  continuity: SessionContinuityCoordinator | undefined,
): SessionContinuityCoordinator {
  if (!continuity) throw new Error('Continuity coordinator is not bound');
  return continuity;
}

function operationContext(
  hostEpoch: string,
  acquireResidency: () => RuntimeHostResidency,
  connectionId = 'connection-close-handoff',
) {
  return {
    hostEpoch,
    connectionId,
    surface: 'tui' as const,
    principal: 'local_os_user' as const,
    acquireResidency,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class LinkedChildAuthorityBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  sendCount = 0;
  private stopped = false;
  private releaseWait: (() => void) | undefined;

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendCount += 1;
    this.stopped = false;
    if (input.text === HOLD_EXTERNAL_PROMPT) {
      await new Promise<void>((resolve) => {
        this.releaseWait = resolve;
      });
    }
    if (input.text === FAKE_ASK_USER_QUESTION_PROMPT) {
      await new Promise<void>((resolve) => {
        this.releaseWait = resolve;
        if (this.stopped) resolve();
      });
      yield {
        type: 'abort',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        reason: 'user_stop',
      };
      yield {
        type: 'complete',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        stopReason: 'user_stop',
      };
      return;
    }
    if (input.text.includes('rate limit')) {
      yield {
        type: 'error',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        recoverable: true,
        reason: 'RateLimit',
        message: 'provider 429',
      };
      yield {
        type: 'complete',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        stopReason: 'error',
      };
      return;
    }
    yield {
      type: 'text_delta',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      messageId: randomUUID(),
      text: 'linked child complete',
    };
    yield {
      type: 'complete',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.releaseWait?.();
  }

  release(): void {
    this.releaseWait?.();
  }

  async respondToPermission(): Promise<void> {}

  async dispose(): Promise<void> {
    this.releaseWait?.();
  }
}

class PermissionWaitingBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  private stopped = false;
  private releaseWait: (() => void) | undefined;

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.stopped = false;
    yield {
      type: 'permission_request',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      kind: 'tool_permission',
      requestId: randomUUID(),
      toolUseId: randomUUID(),
      toolName: 'Bash',
      category: 'shell_safe',
      reason: 'custom',
      args: {},
      rememberForTurnAllowed: true,
    };
    await new Promise<void>((resolve) => {
      this.releaseWait = resolve;
      if (this.stopped) resolve();
    });
    yield {
      type: 'abort',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      reason: 'user_stop',
    };
    yield {
      type: 'complete',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'user_stop',
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.releaseWait?.();
  }

  async respondToPermission(): Promise<void> {}

  async dispose(): Promise<void> {
    this.releaseWait?.();
  }
}

class RecordingContinuitySink implements SessionContinuityFrameSink {
  readonly frames: SubscriptionFrame[] = [];

  async send(frame: SubscriptionFrame): Promise<void> {
    this.frames.push(frame);
  }
}

function testTool(name: string): MakaTool {
  return {
    name,
    description: `${name} test tool`,
    parameters: {},
    permissionRequired: false,
    impl: async () => ({ ok: true }),
  };
}

async function completesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForContinuityFrame(
  sink: RecordingContinuitySink,
  predicate: (frame: SubscriptionFrame) => boolean,
): Promise<SubscriptionFrame> {
  return completesWithin(
    new Promise((resolve) => {
      const check = (): void => {
        const frame = sink.frames.find(predicate);
        if (frame) {
          resolve(frame);
          return;
        }
        setImmediate(check);
      };
      check();
    }),
    5_000,
    'Session continuity frame',
  );
}
