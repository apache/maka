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
  RuntimeInteractionAdmissionRejectedError,
  SessionManager,
  type RuntimeHostedRootAuthority,
  type RuntimeInteractionAuthority,
  type RuntimeInteractionRunClosureReason,
} from '@maka/runtime';
import type { AgentBackend, BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import type { MakaTool } from '@maka/runtime';
import {
  openInteractiveExecutionStoresForWrite,
  type RootTurnAdmissionStore,
} from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { SubscriptionFrame } from '../protocol/index.js';
import { HostCanonicalPermissionOutcomeReader } from '../server/canonical-permission-outcome-reader.js';
import { CanonicalSessionProjectionReader } from '../server/canonical-session-projection.js';
import type { RuntimeHostResidency } from '../server/host-kernel.js';
import { HostInteractionCoordinator } from '../server/interaction-coordinator.js';
import { type HostMessageRootPort, HostMessageCoordinator } from '../server/message-coordinator.js';
import { RootAdmissionOwner } from '../server/root-admission-owner.js';
import { RootTurnCoordinator } from '../server/root-turn-coordinator.js';
import {
  SessionAdmissionGate,
  type SessionAdmissionLease,
} from '../server/session-admission-gate.js';
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
    let canonicalProjection: CanonicalSessionProjectionReader | undefined;
    let drainRequested = false;
    let stopClosureSignal: ReturnType<typeof deferred<void>> | undefined;
    const rootPort: HostMessageRootPort = {
      readSessionHeader: (sessionId) =>
        requireCoordinator(coordinator).readSessionHeader(sessionId),
      readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
      claimStopFence: (input, commitQueueFence, admission) =>
        requireCoordinator(coordinator).claimStopFence(input, commitQueueFence, admission),
      startFromMessage: (input, admission) =>
        requireCoordinator(coordinator).startFromMessage(input, admission),
      claimStop: (input, commitQueueFence, admission) =>
        requireCoordinator(coordinator).claimStop(input, commitQueueFence, admission),
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
      preflightSessionSnapshot: (sessionId, candidate) =>
        requireCanonicalProjection(canonicalProjection).fitsCandidate(sessionId, candidate),
      onProjectionChanged: (sessionId) =>
        requireContinuity(continuity).enqueueCanonicalRefresh(sessionId),
    });
    const canonicalProjectionReader = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions: rootAdmissionOwner,
      messages,
    });
    canonicalProjection = canonicalProjectionReader;
    continuity = new SessionContinuityCoordinator(
      hostEpoch,
      (sessionId) => canonicalProjectionReader.read(sessionId),
      sessionAdmission,
      () => {
        drainRequested = true;
      },
    );
    const interactions = new HostInteractionCoordinator({
      store: stores.interactionStore,
      sessionAdmission,
      preflightSessionSnapshot: (sessionId, interactionProjection) =>
        canonicalProjectionReader.fitsCandidate(sessionId, {
          interactions: interactionProjection,
        }),
      refreshCanonicalContinuity: (sessionId, admission) =>
        requireContinuity(continuity).refreshCanonical(sessionId, admission),
      onPoison: () => {
        drainRequested = true;
      },
    });
    const interactionAuthority: RuntimeInteractionAuthority = {
      bindRun: (identity) => {
        const owner = interactions.bindRun(identity);
        return Object.freeze({
          ...owner,
          close: async (reason: RuntimeInteractionRunClosureReason) => {
            await owner.close(reason);
            if (reason === 'turn_stopped') stopClosureSignal?.resolve();
          },
        });
      },
    };
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
      interactionAuthority,
      canonicalPermissionOutcomes: new HostCanonicalPermissionOutcomeReader({
        store: stores.interactionStore,
      }),
    });
    coordinator = new RootTurnCoordinator(
      manager,
      stores,
      sessionAdmission,
      rootAdmissionOwner,
      interactions,
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
    const waitingFrame = await waitForContinuityFrame(
      parentSink,
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.session.status === 'waiting_for_user' &&
        frame.snapshot.rootTurn?.status === 'waiting_for_user',
      'pending permission projection',
    );
    assert.equal(waitingFrame.kind, 'subscription.session_projection');
    if (waitingFrame.kind !== 'subscription.session_projection') return;
    const pendingPermission = waitingFrame.snapshot.interactions.pending.find(
      (interaction) => interaction.request.kind === 'permission',
    );
    assert.ok(pendingPermission);
    if (!pendingPermission) return;

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

    const readyFailure = new Error('linked child onReady failed after stop committed');
    const callbackAbortController = new AbortController();
    const stopClosureObserved = deferred<void>();
    stopClosureSignal = stopClosureObserved;
    let failedReady:
      | {
          childSessionId: string;
          turnId: string;
          runId: string;
          agentId: string;
          agentName: string;
        }
      | undefined;
    const callbackFailed = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentStarted.result.runId,
        parentTurnId,
        toolCallId: 'linked-ready-failure',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: FAKE_ASK_USER_QUESTION_PROMPT,
      abortSignal: callbackAbortController.signal,
      onReady: async (ready) => {
        failedReady = ready;
        callbackAbortController.abort();
        await stopClosureObserved.promise;
        throw readyFailure;
      },
    });
    stopClosureSignal = undefined;
    assert.ok(failedReady);
    assert.equal(callbackFailed.status, 'cancelled');
    assert.equal(callbackFailed.runId, failedReady.runId);
    assert.deepEqual(coordinator.readRootState(failedReady.childSessionId), { kind: 'idle' });
    assert.equal(interactions.isPoisoned(), false);
    assert.equal(drainRequested, false);

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

    const answered = await interactions.handlers['interaction.answer'](
      {
        interactionId: pendingPermission.interactionId,
        answer: { kind: 'permission', decision: 'allow', rememberForTurn: false },
      },
      operationContext(hostEpoch, acquireResidency),
    );
    assert.equal(answered.ok, true);
    await waitForContinuityFrame(
      parentSink,
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.projectionRevision > waitingFrame.snapshot.projectionRevision &&
        frame.snapshot.session.status === 'running' &&
        frame.snapshot.rootTurn?.runId === parentStarted.result.runId &&
        frame.snapshot.rootTurn.status === 'running' &&
        frame.snapshot.interactions.pending.length === 0,
      'resumed permission projection',
    );

    await coordinator.stopRoot({
      sessionId: parent.id,
      turnId: parentTurnId,
      runId: parentStarted.result.runId,
    });
    await coordinator.close();
    await messages.close();
    await interactions.close();
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
    let canonicalProjection: CanonicalSessionProjectionReader | undefined;
    const rootPort: HostMessageRootPort = {
      readSessionHeader: (sessionId) =>
        requireCoordinator(coordinator).readSessionHeader(sessionId),
      readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
      claimStopFence: (input, commitQueueFence, admission) =>
        requireCoordinator(coordinator).claimStopFence(input, commitQueueFence, admission),
      startFromMessage: (input, admission) =>
        requireCoordinator(coordinator).startFromMessage(input, admission),
      claimStop: (input, commitQueueFence, admission) =>
        requireCoordinator(coordinator).claimStop(input, commitQueueFence, admission),
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
      preflightSessionSnapshot: (sessionId, candidate) =>
        requireCanonicalProjection(canonicalProjection).fitsCandidate(sessionId, candidate),
      onProjectionChanged: (sessionId) =>
        requireContinuity(continuity).enqueueCanonicalRefresh(sessionId),
    });
    const canonicalProjectionReader = new CanonicalSessionProjectionReader({
      stores,
      rootAdmissions: rootAdmissionOwner,
      messages,
    });
    canonicalProjection = canonicalProjectionReader;
    continuity = new SessionContinuityCoordinator(
      hostEpoch,
      (sessionId) => canonicalProjectionReader.read(sessionId),
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
      {
        assertTerminalFence: async () => undefined,
        claimRunClosure: async () => undefined,
      },
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

test('public turn.stop rejects an admission queued behind its exact-Run closure without poisoning', {
  timeout: 20_000,
}, async () => {
  let backend: QueuedAdmissionBackend | undefined;
  const fixture = await createFailureFixture({
    withInteractions: true,
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new QueuedAdmissionBackend(context.sessionId);
        return backend;
      });
    },
  });

  try {
    const turnId = 'turn-public-stop-admission-race';
    const started = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'queue admission behind public stop' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.ok(backend);
    assert.ok(fixture.interactions);
    await backend.readyForAdmission.promise;

    const laneEntered = deferred<void>();
    const releaseLane = deferred<void>();
    const blocker = fixture.sessionAdmission.run(fixture.sessionId, async () => {
      laneEntered.resolve();
      await releaseLane.promise;
    });
    await laneEntered.promise;

    const stopQueued = fixture.sessionAdmission.waitForNextQueuedRun();
    const stopping = fixture.coordinator.handlers['turn.stop'](
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.result.runId,
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    await stopQueued;
    backend.triggerAdmission();
    await backend.admissionQueued.promise;
    releaseLane.resolve();

    await blocker;
    const admissionFailure = await completesWithin(
      backend.admissionFailure.promise,
      2_000,
      'queued admission rejection',
    );
    const stopOutcome = await completesWithin(stopping, 2_000, 'public turn.stop completion');
    assert.equal(stopOutcome.ok, true);
    assert.ok(admissionFailure instanceof RuntimeInteractionAdmissionRejectedError);
    assert.equal(admissionFailure.reason, 'run_closed');
    assert.equal(admissionFailure.closureReason, 'turn_stopped');
    assert.equal(fixture.interactions.isPoisoned(), false);
    assert.equal(fixture.drainRequested(), false);

    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.interactions.close();
  } finally {
    await fixture.dispose();
  }
});

test('public turn.interrupt releases the Session lane while a queried Run is still starting', {
  timeout: 20_000,
}, async () => {
  const backendFactoryEntered = deferred<void>();
  const releaseBackendFactory = deferred<void>();
  let backend: LinkedChildAuthorityBackend | undefined;
  const fixture = await createFailureFixture({
    withInteractions: true,
    registerBackend: (backends) => {
      backends.register('fake', async (context) => {
        backendFactoryEntered.resolve();
        await releaseBackendFactory.promise;
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      });
    },
  });

  try {
    const turnId = 'turn-public-interrupt-start-race';
    const starting = fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    await backendFactoryEntered.promise;
    const queried = await fixture.coordinator.handlers['turn.query'](
      { sessionId: fixture.sessionId, turnId },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(queried.ok, true);
    if (!queried.ok) return;

    let interruptSettled = false;
    const interrupting = fixture.messages.handlers['turn.interrupt'](
      {
        originHostEpoch: fixture.hostEpoch,
        interruptId: 'interrupt-before-start-ready',
        sessionId: fixture.sessionId,
        turnId,
        runId: queried.result.runId,
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    ).finally(() => {
      interruptSettled = true;
    });
    assert.equal(await settlesWithin(interrupting, 25), false);
    assert.equal(interruptSettled, false);

    releaseBackendFactory.resolve();
    const [startOutcome, interruptOutcome] = await Promise.all([
      completesWithin(starting, 2_000, 'turn start after interrupt fence'),
      completesWithin(interrupting, 2_000, 'public interrupt after start handoff'),
    ]);
    assert.equal(startOutcome.ok, true);
    assert.equal(interruptOutcome.ok, true);
    if (interruptOutcome.ok) {
      assert.equal(interruptOutcome.result.turn.runId, queried.result.runId);
      assert.equal(interruptOutcome.result.turn.status, 'cancelled');
    }
    assert.equal(backend?.sendCount, 0);
    assert.equal(fixture.interactions?.isPoisoned(), false);
    assert.equal(fixture.drainRequested(), false);

    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.interactions?.close();
  } finally {
    releaseBackendFactory.resolve();
    backend?.release();
    await fixture.dispose();
  }
});

test('Runtime stop lets a running admission publish before its exact-Run closure', {
  timeout: 20_000,
}, async () => {
  const preflightEntered = deferred<void>();
  const releasePreflight = deferred<void>();
  let backend: RunningAdmissionBackend | undefined;
  const fixture = await createFailureFixture({
    withInteractions: true,
    beforeInteractionPreflight: async () => {
      preflightEntered.resolve();
      await releasePreflight.promise;
    },
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new RunningAdmissionBackend(context.sessionId);
        return backend;
      });
    },
  });

  try {
    const turnId = 'turn-running-admission-stop-race';
    const started = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'stop while admission owns the Session lane' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.ok(backend);
    assert.ok(fixture.interactions);
    await preflightEntered.promise;

    const stopping = fixture.manager.stopSession(fixture.sessionId, {
      source: 'stop_button',
    });
    assert.equal(await settlesWithin(stopping, 25), false);
    releasePreflight.resolve();

    await completesWithin(backend.admitted.promise, 2_000, 'running admission completion');
    await completesWithin(stopping, 2_000, 'Runtime stop after running admission');
    assert.deepEqual(backend.closureReasons, ['turn_stopped']);
    assert.equal(fixture.interactions.isPoisoned(), false);
    assert.equal(fixture.drainRequested(), false);

    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.interactions.close();
  } finally {
    releasePreflight.resolve();
    backend?.release();
    await fixture.dispose();
  }
});

test('hosted permission timeout closure ack refreshes continuity before the next backend step', {
  timeout: 20_000,
}, async () => {
  let backend: PermissionTimeoutClosureBackend | undefined;
  const fixture = await createFailureFixture({
    withInteractions: true,
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new PermissionTimeoutClosureBackend(context.sessionId);
        return backend;
      });
    },
  });
  const sink = new RecordingContinuitySink();
  const connectionId = 'connection-permission-timeout-closure';
  const connection = fixture.continuity.attachConnection(connectionId, sink);

  try {
    const opened = await fixture.continuity.handlers['subscription.open'](
      { sessionId: fixture.sessionId },
      operationContext(fixture.hostEpoch, fixture.acquireResidency, connectionId),
    );
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    connection.activate(opened.result.subscriptionId);

    const turnId = 'turn-permission-timeout-closure';
    const started = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'time out a hosted permission' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.ok(backend);

    await backend.permissionRequestConsumed.promise;
    const waiting = await waitForContinuityFrame(
      sink,
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.rootTurn?.runId === started.result.runId &&
        frame.snapshot.session.status === 'waiting_for_user' &&
        frame.snapshot.rootTurn.status === 'waiting_for_user' &&
        frame.snapshot.interactions.pending.some(
          (interaction) => interaction.request.kind === 'permission',
        ),
      'hosted permission waiting projection',
    );
    assert.equal(waiting.kind, 'subscription.session_projection');
    if (waiting.kind !== 'subscription.session_projection') return;

    backend.commitTimeout();
    await backend.closureAckConsumed.promise;
    assert.equal(backend.providerStepCount, 0);

    const resumed = await waitForContinuityFrame(
      sink,
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.projectionRevision > waiting.snapshot.projectionRevision &&
        frame.snapshot.session.status === 'running' &&
        frame.snapshot.rootTurn?.runId === started.result.runId &&
        frame.snapshot.rootTurn.status === 'running' &&
        frame.snapshot.interactions.pending.length === 0,
      'permission timeout closure projection',
    );
    assert.equal(resumed.kind, 'subscription.session_projection');
    assert.equal(backend.providerStepCount, 0);
    const runtimeEvents = await fixture.stores.runtimeEventStore.readImmutableRuntimeEvents(
      fixture.sessionId,
      started.result.runId,
    );
    assert.equal(
      runtimeEvents.some(
        (event) =>
          event.actions?.permissionClosureAccepted?.reason === 'timed_out' &&
          event.actions.permissionClosureAccepted.requestId === backend?.requestId,
      ),
      true,
    );

    backend.releaseProviderStep();
    await backend.providerStepStarted.promise;
  } finally {
    backend?.releaseProviderStep();
    connection.close();
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.interactions?.close();
    await fixture.dispose();
  }
});

test('public turn.stop wins the Session lane before a wire answer for the same Run', {
  timeout: 20_000,
}, async () => {
  let backend: PendingQuestionBackend | undefined;
  const fixture = await createFailureFixture({
    withInteractions: true,
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new PendingQuestionBackend(context.sessionId);
        return backend;
      });
    },
  });

  try {
    const turnId = 'turn-public-stop-answer-race';
    const started = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'answer after the public stop fence' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.ok(backend);
    assert.ok(fixture.interactions);
    const requestId = await backend.pendingRequest.promise;

    const laneEntered = deferred<void>();
    const releaseLane = deferred<void>();
    const blocker = fixture.sessionAdmission.run(fixture.sessionId, async () => {
      laneEntered.resolve();
      await releaseLane.promise;
    });
    await laneEntered.promise;

    const stopQueued = fixture.sessionAdmission.waitForNextQueuedRun();
    const stopping = fixture.coordinator.handlers['turn.stop'](
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.result.runId,
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    await stopQueued;
    const answered = fixture.interactions.handlers['interaction.answer'](
      {
        interactionId: requestId,
        answer: { kind: 'question', answers: ['Yes'] },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    releaseLane.resolve();

    await blocker;
    const [stopOutcome, answerOutcome] = await Promise.all([
      completesWithin(stopping, 2_000, 'public turn.stop completion'),
      completesWithin(answered, 2_000, 'wire answer completion'),
    ]);
    assert.equal(stopOutcome.ok, true);
    assert.equal(answerOutcome.ok, false);
    if (!answerOutcome.ok) assert.equal(answerOutcome.error.code, 'already_resolved');
    assert.deepEqual(backend.closureReasons, ['turn_stopped']);
    assert.equal(backend.answerApplications, 0);
    assert.equal(fixture.interactions.isPoisoned(), false);
    assert.equal(fixture.drainRequested(), false);

    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.interactions.close();
  } finally {
    await fixture.dispose();
  }
});

test('public turn.stop takes over an earlier closure claim queued behind its lease', {
  timeout: 20_000,
}, async () => {
  let backend: TakeoverClosureBackend | undefined;
  const fixture = await createFailureFixture({
    withInteractions: true,
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new TakeoverClosureBackend(context.sessionId);
        return backend;
      });
    },
  });
  let releaseLane: ReturnType<typeof deferred<void>> | undefined;

  try {
    const turnId = 'turn-public-stop-closure-takeover';
    const started = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'take over the queued closure execution' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.ok(backend);
    assert.ok(fixture.interactions);
    await backend.sendStarted.promise;

    const laneEntered = deferred<void>();
    releaseLane = deferred<void>();
    const blocker = fixture.sessionAdmission.run(fixture.sessionId, async () => {
      laneEntered.resolve();
      await releaseLane?.promise;
    });
    await laneEntered.promise;

    const stopQueued = fixture.sessionAdmission.waitForNextQueuedRun();
    const publicStop = fixture.coordinator.handlers['turn.stop'](
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.result.runId,
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    await stopQueued;

    const runtimeStop = fixture.manager.stopSession(fixture.sessionId, {
      source: 'stop_button',
    });
    await backend.stopStarted.promise;
    releaseLane.resolve();

    await blocker;
    await completesWithin(runtimeStop, 2_000, 'Runtime stop closure takeover');
    backend.releaseSend();
    const outcome = await completesWithin(publicStop, 2_000, 'public turn.stop completion');
    assert.equal(outcome.ok, true);
    assert.equal(fixture.interactions.isPoisoned(), false);
    assert.equal(fixture.drainRequested(), false);

    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.interactions.close();
  } finally {
    releaseLane?.resolve();
    backend?.releaseSend();
    await fixture.dispose();
  }
});

async function createFailureFixture(options: {
  registerBackend(backends: BackendRegistry): void;
  wrapAdmissionStore?(store: RootTurnAdmissionStore): RootTurnAdmissionStore;
  withInteractions?: boolean;
  beforeInteractionPreflight?(): Promise<void>;
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
  const sessionAdmission = new ObservableSessionAdmissionGate();
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
  let canonicalProjection: CanonicalSessionProjectionReader | undefined;
  const rootPort: HostMessageRootPort = {
    readSessionHeader: (sessionId) => requireCoordinator(coordinator).readSessionHeader(sessionId),
    readRootState: (sessionId) => requireCoordinator(coordinator).readRootState(sessionId),
    claimStopFence: (input, commitQueueFence, admission) =>
      requireCoordinator(coordinator).claimStopFence(input, commitQueueFence, admission),
    startFromMessage: (input, admission) =>
      requireCoordinator(coordinator).startFromMessage(input, admission),
    claimStop: (input, commitQueueFence, admission) =>
      requireCoordinator(coordinator).claimStop(input, commitQueueFence, admission),
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
    preflightSessionSnapshot: (sessionId, candidate) =>
      requireCanonicalProjection(canonicalProjection).fitsCandidate(sessionId, candidate),
    onProjectionChanged: (sessionId) =>
      requireContinuity(continuity).enqueueCanonicalRefresh(sessionId),
  });
  const canonicalProjectionReader = new CanonicalSessionProjectionReader({
    stores,
    rootAdmissions: rootAdmissionOwner,
    messages,
  });
  canonicalProjection = canonicalProjectionReader;
  continuity = new SessionContinuityCoordinator(
    hostEpoch,
    (sessionId) => canonicalProjectionReader.read(sessionId),
    sessionAdmission,
    requestDrain,
  );
  const interactions = options.withInteractions
    ? new HostInteractionCoordinator({
        store: stores.interactionStore,
        sessionAdmission,
        preflightSessionSnapshot: async (sessionId, interactionProjection) => {
          await options.beforeInteractionPreflight?.();
          return canonicalProjectionReader.fitsCandidate(sessionId, {
            interactions: interactionProjection,
          });
        },
        refreshCanonicalContinuity: (sessionId, admission) =>
          requireContinuity(continuity).refreshCanonical(sessionId, admission),
        onPoison: requestDrain,
      })
    : undefined;
  const backends = new BackendRegistry();
  options.registerBackend(backends);
  const managerDeps = {
    store: stores.sessionStore,
    runStore: stores.agentRunStore,
    runtimeEventStore: stores.runtimeEventStore,
    backends,
    newId: randomUUID,
    now: Date.now,
    messageAuthority: messages,
  };
  const manager = interactions
    ? new SessionManager({
        ...managerDeps,
        interactionAuthority: interactions,
        canonicalPermissionOutcomes: new HostCanonicalPermissionOutcomeReader({
          store: stores.interactionStore,
        }),
      })
    : new SessionManager(managerDeps);
  coordinator = new RootTurnCoordinator(
    manager,
    stores,
    sessionAdmission,
    rootAdmissionOwner,
    interactions ?? {
      assertTerminalFence: async () => undefined,
      claimRunClosure: async () => undefined,
    },
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
    continuity,
    manager,
    interactions,
    sessionAdmission,
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

function requireCanonicalProjection(
  projection: CanonicalSessionProjectionReader | undefined,
): CanonicalSessionProjectionReader {
  if (!projection) throw new Error('Canonical projection is not composed');
  return projection;
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

class ObservableSessionAdmissionGate extends SessionAdmissionGate {
  #nextQueuedRun: ReturnType<typeof deferred<void>> | undefined;

  waitForNextQueuedRun(): Promise<void> {
    if (this.#nextQueuedRun) throw new Error('A Session admission queue signal is already armed');
    const signal = deferred<void>();
    this.#nextQueuedRun = signal;
    return signal.promise;
  }

  override run<T>(
    sessionId: string,
    operation: (lease: SessionAdmissionLease) => Promise<T> | T,
  ): Promise<T> {
    const signal = this.#nextQueuedRun;
    this.#nextQueuedRun = undefined;
    const result = super.run(sessionId, operation);
    signal?.resolve();
    return result;
  }
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

class QueuedAdmissionBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly readyForAdmission = deferred<void>();
  readonly admissionQueued = deferred<void>();
  readonly admissionFailure = deferred<unknown>();
  private readonly admissionTrigger = deferred<void>();

  constructor(readonly sessionId: string) {}

  triggerAdmission(): void {
    this.admissionTrigger.resolve();
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'text_delta',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      messageId: randomUUID(),
      text: 'running before queued admission',
    };
    this.readyForAdmission.resolve();
    await this.admissionTrigger.promise;
    if (!input.hostedInteraction) {
      throw new Error('QueuedAdmissionBackend requires hosted Interaction authority');
    }
    const request = {
      type: 'user_question_request',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      requestId: randomUUID(),
      toolUseId: randomUUID(),
      questions: [
        {
          question: 'Continue?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    } satisfies Extract<SessionEvent, { type: 'user_question_request' }>;
    const admission = input.hostedInteraction.admitUserQuestionRequest({
      request,
      settlement: {
        applyAnswer: async () => {},
        applyClosure: async () => {},
      },
    });
    this.admissionQueued.resolve();
    try {
      await admission;
      throw new Error('Queued admission unexpectedly crossed the stop fence');
    } catch (error) {
      this.admissionFailure.resolve(error);
    }
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
    this.admissionTrigger.resolve();
  }

  async respondToPermission(): Promise<void> {}

  async dispose(): Promise<void> {
    this.admissionTrigger.resolve();
  }
}

class RunningAdmissionBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly admitted = deferred<void>();
  readonly closureReasons: string[] = [];
  private readonly settled = deferred<void>();

  constructor(readonly sessionId: string) {}

  release(): void {
    this.settled.resolve();
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (!input.hostedInteraction) {
      throw new Error('RunningAdmissionBackend requires hosted Interaction authority');
    }
    const request = {
      type: 'user_question_request',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      requestId: randomUUID(),
      toolUseId: randomUUID(),
      questions: [
        {
          question: 'Continue?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    } satisfies Extract<SessionEvent, { type: 'user_question_request' }>;
    await input.hostedInteraction.admitUserQuestionRequest({
      request,
      settlement: {
        applyAnswer: async () => {
          this.settled.resolve();
        },
        applyClosure: async (reason) => {
          this.closureReasons.push(reason);
          this.settled.resolve();
        },
      },
    });
    this.admitted.resolve();
    yield request;
    await this.settled.promise;
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

  async stop(): Promise<void> {}

  async respondToPermission(): Promise<void> {}

  async dispose(): Promise<void> {
    this.settled.resolve();
  }
}

class PendingQuestionBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly pendingRequest = deferred<string>();
  readonly closureReasons: string[] = [];
  answerApplications = 0;
  private readonly settled = deferred<void>();

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (!input.hostedInteraction) {
      throw new Error('PendingQuestionBackend requires hosted Interaction authority');
    }
    const requestId = randomUUID();
    const request = {
      type: 'user_question_request',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      requestId,
      toolUseId: randomUUID(),
      questions: [
        {
          question: 'Continue?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    } satisfies Extract<SessionEvent, { type: 'user_question_request' }>;
    await input.hostedInteraction.admitUserQuestionRequest({
      request,
      settlement: {
        applyAnswer: async () => {
          this.answerApplications += 1;
          this.settled.resolve();
        },
        applyClosure: async (reason) => {
          this.closureReasons.push(reason);
          this.settled.resolve();
        },
      },
    });
    this.pendingRequest.resolve(requestId);
    yield request;
    await this.settled.promise;
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
    this.settled.resolve();
  }

  async respondToPermission(): Promise<void> {}

  async dispose(): Promise<void> {
    this.settled.resolve();
  }
}

class TakeoverClosureBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sendStarted = deferred<void>();
  readonly stopStarted = deferred<void>();
  private readonly sendReleased = deferred<void>();

  constructor(readonly sessionId: string) {}

  releaseSend(): void {
    this.sendReleased.resolve();
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendStarted.resolve();
    yield {
      type: 'text_delta',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      messageId: randomUUID(),
      text: 'waiting for closure takeover',
    };
    await this.sendReleased.promise;
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
    this.stopStarted.resolve();
  }

  async respondToPermission(): Promise<void> {}

  async dispose(): Promise<void> {
    this.sendReleased.resolve();
  }
}

class PermissionWaitingBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  private stopped = false;
  private resolveDecision: ((decision: PermissionDecision | null) => void) | undefined;
  private releaseAfterDecision: (() => void) | undefined;

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.stopped = false;
    const requestId = randomUUID();
    const toolUseId = randomUUID();
    const request = {
      type: 'permission_request',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      kind: 'tool_permission',
      requestId,
      toolUseId,
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'echo hello', cwd: '/repo' },
      rememberForTurnAllowed: true,
    } satisfies Extract<SessionEvent, { type: 'permission_request' }>;
    const decisionPromise = new Promise<PermissionDecision | null>((resolve) => {
      this.resolveDecision = resolve;
      if (this.stopped) resolve(null);
    });
    if (!input.hostedInteraction) {
      throw new Error('PermissionWaitingBackend requires hosted Interaction authority');
    }
    const admission = await input.hostedInteraction.admitPermissionRequest({
      request,
      settlement: {
        applyAnswer: async (answer) => {
          this.resolveDecision?.({ requestId, ...answer });
        },
        applyClosure: async () => {
          this.resolveDecision?.(null);
        },
      },
    });
    if (admission.state === 'pending') yield request;
    const decision = await decisionPromise;
    this.resolveDecision = undefined;
    if (!decision || this.stopped) {
      yield* this.abort(input.turnId);
      return;
    }
    yield {
      type: 'permission_answer_ack',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      requestId,
      toolUseId,
    };
    await new Promise<void>((resolve) => {
      this.releaseAfterDecision = resolve;
      if (this.stopped) resolve();
    });
    yield* this.abort(input.turnId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.resolveDecision?.(null);
    this.releaseAfterDecision?.();
  }

  async respondToPermission(): Promise<void> {}

  async dispose(): Promise<void> {
    await this.stop();
  }

  private async *abort(turnId: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'abort',
      id: randomUUID(),
      turnId,
      ts: Date.now(),
      reason: 'user_stop',
    };
    yield {
      type: 'complete',
      id: randomUUID(),
      turnId,
      ts: Date.now(),
      stopReason: 'user_stop',
    };
  }
}

class PermissionTimeoutClosureBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly permissionRequestConsumed = deferred<void>();
  readonly closureAckConsumed = deferred<void>();
  readonly providerStepStarted = deferred<void>();
  providerStepCount = 0;
  requestId: string | undefined;
  private readonly timeoutRequested = deferred<void>();
  private readonly providerStepReleased = deferred<void>();

  constructor(readonly sessionId: string) {}

  commitTimeout(): void {
    this.timeoutRequested.resolve();
  }

  releaseProviderStep(): void {
    this.providerStepReleased.resolve();
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (!input.hostedInteraction) {
      throw new Error('PermissionTimeoutClosureBackend requires hosted Interaction authority');
    }
    const requestId = randomUUID();
    this.requestId = requestId;
    const toolUseId = randomUUID();
    const request = {
      type: 'permission_request',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      kind: 'tool_permission',
      requestId,
      toolUseId,
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'echo timeout', cwd: '/repo' },
      rememberForTurnAllowed: true,
    } satisfies Extract<SessionEvent, { type: 'permission_request' }>;
    const admission = await input.hostedInteraction.admitPermissionRequest({
      request,
      settlement: {
        applyAnswer: async () => {
          throw new Error('Permission timeout backend unexpectedly received an answer');
        },
        applyClosure: async () => {},
      },
    });
    if (admission.state !== 'pending') {
      throw new Error('Permission timeout backend expected a pending admission');
    }

    yield request;
    this.permissionRequestConsumed.resolve();
    await this.timeoutRequested.promise;
    const outcome = await input.hostedInteraction.commitPermissionTimeout({ requestId });
    if (outcome.kind !== 'closure' || outcome.reason !== 'timed_out') {
      throw new Error('Permission timeout backend received an unexpected canonical outcome');
    }
    yield {
      type: 'permission_closure_ack',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      requestId,
      toolUseId,
      reason: 'timed_out',
    };
    this.closureAckConsumed.resolve();

    await this.providerStepReleased.promise;
    this.providerStepCount += 1;
    this.providerStepStarted.resolve();
    yield {
      type: 'text_delta',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      messageId: randomUUID(),
      text: 'provider resumed after permission timeout',
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
    this.timeoutRequested.resolve();
    this.providerStepReleased.resolve();
  }

  async respondToPermission(): Promise<void> {}

  async dispose(): Promise<void> {
    await this.stop();
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
  description = 'Session continuity frame',
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
    description,
  );
}
