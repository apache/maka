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
  RuntimeMessageAuthorityInvariantError,
  SessionManager,
  type RuntimeHostedRootAuthority,
  type RuntimeInteractionAuthority,
  type RuntimeInteractionRunClosureReason,
  type RuntimeMessageAuthority,
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
import { HostCanonicalPermissionOutcomeReader } from '../server/canonical-permission-outcome-reader.js';
import { CanonicalSessionProjectionReader } from '../server/canonical-session-projection.js';
import { HostClientCapabilityCoordinator } from '../server/client-capability-coordinator.js';
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
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';

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
        return new QuestionWaitingBackend(context.sessionId);
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
      'pending question projection',
    );
    assert.equal(waitingFrame.kind, 'subscription.session_projection');
    if (waitingFrame.kind !== 'subscription.session_projection') return;
    const pendingQuestion = waitingFrame.snapshot.interactions.pending.find(
      (interaction) => interaction.request.kind === 'question',
    );
    assert.ok(pendingQuestion);
    if (!pendingQuestion) return;

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
    const legacyRetryRun = await stores.agentRunStore.readRun(child.childSessionId, retried.runId!);
    assert.equal(legacyRetryRun.continuationSource, undefined);
    assert.equal(
      (
        await stores.runtimeEventStore.readImmutableRuntimeEvents(
          child.childSessionId,
          retried.runId!,
        )
      ).some((event) => event.actions?.continuationStart !== undefined),
      false,
    );
    assert.deepEqual(coordinator.readRootState(child.childSessionId), { kind: 'idle' });

    const callbackAbortController = new AbortController();
    const stopClosureObserved = deferred<void>();
    stopClosureSignal = stopClosureObserved;
    let stoppedReady:
      | {
          childSessionId: string;
          turnId: string;
          runId: string;
          agentId: string;
          agentName: string;
        }
      | undefined;
    const callbackStopped = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentStarted.result.runId,
        parentTurnId,
        toolCallId: 'linked-ready-stop',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: FAKE_ASK_USER_QUESTION_PROMPT,
      abortSignal: callbackAbortController.signal,
      onReady: async (ready) => {
        stoppedReady = ready;
        callbackAbortController.abort();
        await stopClosureObserved.promise;
      },
    });
    stopClosureSignal = undefined;
    assert.ok(stoppedReady);
    assert.equal(callbackStopped.status, 'cancelled');
    assert.equal(callbackStopped.runId, stoppedReady.runId);
    assert.deepEqual(coordinator.readRootState(stoppedReady.childSessionId), { kind: 'idle' });
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
        interactionId: pendingQuestion.interactionId,
        answer: { kind: 'question', answers: ['Yes'] },
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
      'resumed question projection',
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

    const admissions = await fixture.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
      fixture.sessionId,
    );
    assert.equal(admissions.length, 2);
    const successor = admissions[1];
    assert.ok(successor);
    if (!successor) return;
    const expectedOwner = {
      kind: 'active' as const,
      sessionId: fixture.sessionId,
      turnId: successor.turnId,
      runId: successor.runId,
    };
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), expectedOwner);
    assert.deepEqual(fixture.messages.projection(fixture.sessionId).followup, []);
    assert.equal(fixture.liveResidencies(), 1);
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

    await assert.rejects(fixture.coordinator.close(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.errors.some(
          (cause) => cause instanceof Error && cause.message === 'injected backend startup failure',
        ),
        true,
      );
      return true;
    });
    await fixture.messages.close();
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), { kind: 'idle' });
    assert.equal(fixture.liveResidencies(), 0);
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
      backends.register('fake', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
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

test('shutdown contains a successor backend start rejected by Interaction drain', {
  timeout: 20_000,
}, async () => {
  const followupAdmissionStarted = deferred<void>();
  const releaseFollowupAdmission = deferred<void>();
  let backend: LinkedChildAuthorityBackend | undefined;
  const fixture = await createFailureFixture({
    withInteractions: true,
    wrapAdmissionStore: (store) => ({
      admitRootTurn: async (input) => {
        if (input.previousRootTurnId !== null) {
          followupAdmissionStarted.resolve();
          await releaseFollowupAdmission.promise;
        }
        return store.admitRootTurn(input);
      },
      readRootTurnAdmission: (sessionId, turnId) => store.readRootTurnAdmission(sessionId, turnId),
      readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
        store.readRootTurnSourceMessageReceipt(sessionId, messageId),
      listRootTurnAdmissionsForRecovery: (sessionId) =>
        store.listRootTurnAdmissionsForRecovery(sessionId),
    }),
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      });
    },
  });
  let closed = false;

  try {
    const firstTurnId = 'turn-close-first';
    const started = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: firstTurnId,
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    assert.ok(backend);
    assert.ok(fixture.interactions);
    await completesWithin(backend.externalHoldStarted.promise, 2_000, 'held root start');

    const followup = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: 'message-close-followup',
        content: { text: 'start successor while shutdown drains Interaction authority' },
        placement: 'next_turn',
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(followup.ok && followup.result.disposition, 'followup');

    backend.release();
    await completesWithin(followupAdmissionStarted.promise, 2_000, 'successor root admission');
    fixture.messages.beginDrain();
    fixture.interactions.beginDrain();
    const closing = fixture.coordinator.close();
    releaseFollowupAdmission.resolve();
    await completesWithin(closing, 2_000, 'root close after successor admission');
    await fixture.messages.close();
    await fixture.interactions.close();
    closed = true;

    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), { kind: 'idle' });
    assert.equal(fixture.liveResidencies(), 0);
    assert.equal(fixture.drainRequested(), false);
    assert.equal(fixture.interactions.isPoisoned(), false);
    const admissions = await fixture.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
      fixture.sessionId,
    );
    assert.equal(admissions.length, 2);
    const successor = admissions[1];
    assert.ok(successor);
    const run = await fixture.stores.agentRunStore.readRun(fixture.sessionId, successor.runId);
    const runtimeEvents = await fixture.stores.runtimeEventStore.readImmutableRuntimeEvents(
      fixture.sessionId,
      successor.runId,
    );
    const terminal = classifyTerminalRuntimeLedger(run, runtimeEvents);
    assert.equal(terminal.kind, 'fact');
    if (terminal.kind === 'fact') assert.equal(terminal.fact.runStatus, 'cancelled');
  } finally {
    releaseFollowupAdmission.resolve();
    backend?.release();
    if (!closed) {
      await Promise.allSettled([
        fixture.coordinator.close(),
        fixture.messages.close(),
        fixture.interactions?.close(),
      ]);
    }
    await fixture.dispose();
  }
});

test('Client Capability ambiguity fails before durable root admission', async () => {
  const clientCapabilities = new HostClientCapabilityCoordinator({
    activation: new RuntimePolicyActivationGate(),
    onRegistryChanged: () => undefined,
  });
  const fixture = await createFailureFixture({
    clientCapabilities,
    registerBackend: (backends) => {
      backends.register('fake', (context) => new FakeBackend(context));
    },
  });
  const first = clientCapabilities.attachConnection('provider-a', { send: async () => {} });
  const second = clientCapabilities.attachConnection('provider-b', { send: async () => {} });

  try {
    for (const [connectionId, registrationId] of [
      ['provider-a', 'registration-a'],
      ['provider-b', 'registration-b'],
    ] as const) {
      const replaced = await clientCapabilities.handlers['client.capability.replace'](
        {
          registrationId,
          offers: [
            {
              offerId: 'opaque',
              version: '0',
              affinity: 'session',
              label: 'Opaque',
              tools: [
                {
                  serverId: 'opaque',
                  name: 'inspect',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          ],
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency, connectionId),
      );
      assert.equal(replaced.ok, true);
    }

    const turnId = 'turn-client-capability-ambiguity';
    const started = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'must not be admitted' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'observer'),
    );
    assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.error.code, 'operation_conflict');
    assert.equal(
      await fixture.stores.agentRunStore.readRootTurnAdmission(fixture.sessionId, turnId),
      undefined,
    );
  } finally {
    first.close();
    second.close();
    clientCapabilities.close();
    await fixture.dispose();
  }
});

test('an exact active retry preserves the Client Capability admission binding', {
  timeout: 20_000,
}, async () => {
  const clientCapabilities = new HostClientCapabilityCoordinator({
    activation: new RuntimePolicyActivationGate(),
    onRegistryChanged: () => undefined,
  });
  let backend: LinkedChildAuthorityBackend | undefined;
  const fixture = await createFailureFixture({
    clientCapabilities,
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      });
    },
  });
  const first = clientCapabilities.attachConnection('provider-a', { send: async () => {} });
  const second = clientCapabilities.attachConnection('provider-b', { send: async () => {} });

  try {
    for (const [connectionId, registrationId] of [
      ['provider-a', 'registration-a'],
      ['provider-b', 'registration-b'],
    ] as const) {
      const replaced = await clientCapabilities.handlers['client.capability.replace'](
        {
          registrationId,
          offers: [
            {
              offerId: 'browser',
              version: '0',
              affinity: 'turn',
              label: 'Browser',
              tools: [
                {
                  serverId: 'browser',
                  name: 'navigate',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          ],
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency, connectionId),
      );
      assert.equal(replaced.ok, true);
    }

    const input = {
      sessionId: fixture.sessionId,
      turnId: 'turn-client-capability-exact-retry',
      content: { text: HOLD_EXTERNAL_PROMPT },
    } as const;
    const started = await fixture.coordinator.handlers['turn.start'](
      input,
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-a'),
    );
    assert.equal(started.ok, true);
    const retried = await fixture.coordinator.handlers['turn.start'](
      input,
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-b'),
    );
    assert.equal(retried.ok, true);

    const snapshot = clientCapabilities.snapshotForSession(fixture.sessionId);
    assert.deepEqual(snapshot?.registrationIds, ['registration-a']);
    snapshot?.release();

    if (started.ok) {
      await fixture.coordinator.stopRoot({
        sessionId: fixture.sessionId,
        turnId: input.turnId,
        runId: started.result.runId,
      });
    }
  } finally {
    backend?.release();
    first.close();
    second.close();
    clientCapabilities.close();
    await fixture.dispose();
  }
});

test('mixed-Client queued follow-ups preserve each submitting connection through root handoff', {
  timeout: 20_000,
}, async () => {
  const clientCapabilities = new HostClientCapabilityCoordinator({
    activation: new RuntimePolicyActivationGate(),
    onRegistryChanged: () => undefined,
  });
  let backend: LinkedChildAuthorityBackend | undefined;
  const fixture = await createFailureFixture({
    clientCapabilities,
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      });
    },
  });
  const first = clientCapabilities.attachConnection('provider-a', { send: async () => {} });
  const second = clientCapabilities.attachConnection('provider-b', { send: async () => {} });

  try {
    for (const [connectionId, registrationId] of [
      ['provider-a', 'registration-a'],
      ['provider-b', 'registration-b'],
    ] as const) {
      const replaced = await clientCapabilities.handlers['client.capability.replace'](
        {
          registrationId,
          offers: [
            {
              offerId: 'browser',
              version: '0',
              affinity: 'turn',
              label: 'Browser',
              tools: [
                {
                  serverId: 'browser',
                  name: 'navigate',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          ],
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency, connectionId),
      );
      assert.equal(replaced.ok, true);
    }

    const firstTurnId = 'turn-client-a';
    const started = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: firstTurnId,
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-a'),
    );
    assert.equal(started.ok, true);
    const firstSnapshot = clientCapabilities.snapshotForSession(fixture.sessionId);
    assert.deepEqual(firstSnapshot?.registrationIds, ['registration-a']);
    firstSnapshot?.release();

    const queued = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: 'followup-from-provider-b',
        content: { text: HOLD_EXTERNAL_PROMPT },
        placement: 'next_turn',
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-b'),
    );
    assert.equal(queued.ok && queued.result.disposition, 'followup');
    const queuedAfter = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: 'followup-from-provider-a',
        content: { text: HOLD_EXTERNAL_PROMPT },
        placement: 'next_turn',
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-a'),
    );
    assert.equal(queuedAfter.ok && queuedAfter.result.disposition, 'followup');

    backend?.release();
    await waitUntil(() => {
      const state = fixture.coordinator.readRootState(fixture.sessionId);
      return state.kind === 'active' && state.turnId !== firstTurnId;
    });
    const firstFollowup = fixture.coordinator.readRootState(fixture.sessionId);
    assert.equal(firstFollowup.kind, 'active');
    if (firstFollowup.kind !== 'active') return;
    const firstFollowupSnapshot = clientCapabilities.snapshotForSession(fixture.sessionId);
    assert.deepEqual(firstFollowupSnapshot?.registrationIds, ['registration-b']);
    firstFollowupSnapshot?.release();

    await waitUntil(() => backend?.sendCount === 2);
    backend?.release();
    await waitUntil(() => {
      const state = fixture.coordinator.readRootState(fixture.sessionId);
      return state.kind === 'active' && state.turnId !== firstFollowup.turnId;
    });
    const secondFollowupSnapshot = clientCapabilities.snapshotForSession(fixture.sessionId);
    assert.deepEqual(secondFollowupSnapshot?.registrationIds, ['registration-a']);
    secondFollowupSnapshot?.release();

    await waitUntil(() => backend?.sendCount === 3);
    backend?.release();
    await waitUntil(
      () => fixture.coordinator.readRootState(fixture.sessionId).kind === 'idle',
      5_000,
    );
    const admissions = await fixture.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
      fixture.sessionId,
    );
    assert.deepEqual(
      admissions.map((admission) => admission.sourceMessages.map((source) => source.messageId)),
      [[], ['followup-from-provider-b'], ['followup-from-provider-a']],
    );
  } finally {
    first.close();
    second.close();
    clientCapabilities.close();
    await fixture.dispose();
  }
});

test('queued follow-up degrades lost Session tools and rebinds ephemeral tools to its Client', {
  timeout: 20_000,
}, async () => {
  await assertFollowupCapabilityRebinding('call');
  await assertFollowupCapabilityRebinding('turn');
});

async function assertFollowupCapabilityRebinding(affinity: 'call' | 'turn'): Promise<void> {
  const clientCapabilities = new HostClientCapabilityCoordinator({
    activation: new RuntimePolicyActivationGate(),
    onRegistryChanged: () => undefined,
  });
  let backend: LinkedChildAuthorityBackend | undefined;
  const fixture = await createFailureFixture({
    clientCapabilities,
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      });
    },
  });
  const sessionProvider = clientCapabilities.attachConnection('provider-session', {
    send: async () => {},
  });
  const calls: string[] = [];
  let previousProvider!: ReturnType<HostClientCapabilityCoordinator['attachConnection']>;
  previousProvider = clientCapabilities.attachConnection('provider-previous', {
    send: async (frame) => {
      if (frame.kind !== 'client.capability.call') return;
      calls.push('provider-previous');
      previousProvider.accept({
        kind: 'client.capability.accepted',
        invocationId: frame.invocationId,
      });
      previousProvider.accept({
        kind: 'client.capability.result',
        invocationId: frame.invocationId,
        result: { content: [{ type: 'text', text: 'previous' }] },
      });
    },
  });
  let followupProvider!: ReturnType<HostClientCapabilityCoordinator['attachConnection']>;
  followupProvider = clientCapabilities.attachConnection('provider-followup', {
    send: async (frame) => {
      if (frame.kind !== 'client.capability.call') return;
      calls.push('provider-followup');
      followupProvider.accept({
        kind: 'client.capability.accepted',
        invocationId: frame.invocationId,
      });
      followupProvider.accept({
        kind: 'client.capability.result',
        invocationId: frame.invocationId,
        result: { content: [{ type: 'text', text: 'followup' }] },
      });
    },
  });

  try {
    const sessionReplaced = await clientCapabilities.handlers['client.capability.replace'](
      {
        registrationId: 'registration-session',
        offers: [
          {
            offerId: 'session-browser',
            version: '0',
            affinity: 'session',
            label: 'Session browser',
            tools: [
              {
                serverId: 'session_browser',
                name: 'navigate_session',
                inputSchema: { type: 'object' },
              },
            ],
          },
        ],
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-session'),
    );
    assert.equal(sessionReplaced.ok, true);
    for (const [connectionId, registrationId] of [
      ['provider-previous', 'registration-previous'],
      ['provider-followup', 'registration-followup'],
    ] as const) {
      const replaced = await clientCapabilities.handlers['client.capability.replace'](
        {
          registrationId,
          offers: [
            {
              offerId: 'ephemeral-browser',
              version: '0',
              affinity,
              label: 'Ephemeral browser',
              tools: [
                {
                  serverId: 'ephemeral_browser',
                  name: 'navigate_ephemeral',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          ],
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency, connectionId),
      );
      assert.equal(replaced.ok, true);
    }

    const firstTurnId = `turn-client-capability-loss-${affinity}`;
    const started = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: firstTurnId,
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-previous'),
    );
    assert.equal(started.ok, true);
    const queued = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: `followup-after-provider-loss-${affinity}`,
        content: { text: HOLD_EXTERNAL_PROMPT },
        placement: 'next_turn',
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-followup'),
    );
    assert.equal(queued.ok && queued.result.disposition, 'followup');

    sessionProvider.close();
    backend?.release();
    await waitUntil(() => {
      const state = fixture.coordinator.readRootState(fixture.sessionId);
      return state.kind === 'active' && state.turnId !== firstTurnId;
    });
    const snapshot = clientCapabilities.snapshotForSession(fixture.sessionId);
    assert.ok(snapshot);
    assert.equal(
      snapshot.tools.some((tool) => tool.name.endsWith('navigate_session')),
      false,
    );
    const ephemeral = snapshot.tools.find((tool) => tool.name.endsWith('navigate_ephemeral'));
    assert.ok(ephemeral);
    await ephemeral.impl(
      {},
      {
        sessionId: fixture.sessionId,
        turnId: 'followup-turn',
        cwd: '/tmp',
        toolCallId: `followup-${affinity}`,
        abortSignal: new AbortController().signal,
        emitOutput: () => undefined,
      },
    );
    assert.deepEqual(calls, ['provider-followup']);
    snapshot.release();

    await waitUntil(() => backend?.sendCount === 2);
    backend?.release();
    await waitUntil(
      () => fixture.coordinator.readRootState(fixture.sessionId).kind === 'idle',
      5_000,
    );
    const admissions = await fixture.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
      fixture.sessionId,
    );
    assert.equal(admissions.length, 2);
    const followup = admissions[1];
    assert.ok(followup);
    assert.equal(
      (await fixture.stores.agentRunStore.readRun(fixture.sessionId, followup.runId)).status,
      'completed',
    );
    assert.equal(fixture.drainRequested(), false);
  } finally {
    sessionProvider.close();
    previousProvider.close();
    followupProvider.close();
    clientCapabilities.close();
    await fixture.dispose();
  }
}

test('an exact terminal retry does not require a live Client Capability binding', {
  timeout: 20_000,
}, async () => {
  const clientCapabilities = new HostClientCapabilityCoordinator({
    activation: new RuntimePolicyActivationGate(),
    onRegistryChanged: () => undefined,
  });
  const fixture = await createFailureFixture({
    clientCapabilities,
    registerBackend: (backends) => {
      backends.register('fake', (context) => new FakeBackend(context));
    },
  });
  const provider = clientCapabilities.attachConnection('provider-a', { send: async () => {} });

  try {
    const replaced = await clientCapabilities.handlers['client.capability.replace'](
      {
        registrationId: 'registration-a',
        offers: [
          {
            offerId: 'opaque',
            version: '0',
            affinity: 'session',
            label: 'Opaque',
            tools: [
              {
                serverId: 'opaque',
                name: 'inspect',
                inputSchema: { type: 'object' },
              },
            ],
          },
        ],
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-a'),
    );
    assert.equal(replaced.ok, true);
    const input = {
      sessionId: fixture.sessionId,
      turnId: 'turn-client-capability-terminal-retry',
      content: { text: 'complete before the provider disconnects' },
    } as const;
    const started = await fixture.coordinator.handlers['turn.start'](
      input,
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-a'),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    let terminal = started.result;
    for (
      let attempt = 0;
      attempt < 200 &&
      terminal.status !== 'completed' &&
      terminal.status !== 'failed' &&
      terminal.status !== 'cancelled';
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const queried = await fixture.coordinator.handlers['turn.query'](
        { sessionId: input.sessionId, turnId: input.turnId },
        operationContext(fixture.hostEpoch, fixture.acquireResidency, 'observer'),
      );
      assert.equal(queried.ok, true);
      if (!queried.ok) return;
      terminal = queried.result;
    }
    assert.equal(terminal.status, 'completed');

    provider.close();
    const retried = await fixture.coordinator.handlers['turn.start'](
      input,
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'observer'),
    );
    assert.deepEqual(retried, { ok: true, result: terminal });
  } finally {
    provider.close();
    clientCapabilities.close();
    await fixture.dispose();
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

test('public turn.interrupt contains a question admission rejected by its own stop closure', {
  timeout: 20_000,
}, async () => {
  let backend: StopReleasedAdmissionBackend | undefined;
  const fixture = await createFailureFixture({
    withInteractions: true,
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new StopReleasedAdmissionBackend(context.sessionId);
        return backend;
      });
    },
  });

  try {
    const turnId = 'turn-public-interrupt-stop-released-admission';
    const started = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'admit a question only after stop arrives' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.ok(backend);
    await backend.ready.promise;

    const interrupted = await fixture.messages.handlers['turn.interrupt'](
      {
        originHostEpoch: fixture.hostEpoch,
        interruptId: 'interrupt-stop-released-admission',
        sessionId: fixture.sessionId,
        turnId,
        runId: started.result.runId,
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(interrupted.ok, true);
    if (!interrupted.ok) return;
    assert.equal(interrupted.result.turn.status, 'cancelled');
    assert.equal(fixture.interactions?.isPoisoned(), false);
    assert.equal(fixture.drainRequested(), false);

    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.interactions?.close();
  } finally {
    await fixture.dispose();
  }
});

test('public turn.interrupt releases the Session lane while a queried Run is still starting', {
  timeout: 20_000,
}, async () => {
  const backendFactoryEntered = deferred<void>();
  let backendFactoryAborted = false;
  const fixture = await createFailureFixture({
    withInteractions: true,
    registerBackend: (backends) => {
      backends.register('fake', async (context) => {
        backendFactoryEntered.resolve();
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            backendFactoryAborted = true;
            reject(context.abortSignal?.reason ?? new Error('backend factory aborted'));
          };
          if (context.abortSignal?.aborted) abort();
          else context.abortSignal?.addEventListener('abort', abort, { once: true });
        });
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
    const [startOutcome, interruptOutcome] = await Promise.all([
      completesWithin(starting, 2_000, 'cancelled turn start'),
      completesWithin(interrupting, 2_000, 'public interrupt during backend creation'),
    ]);
    assert.equal(startOutcome.ok, true);
    if (startOutcome.ok) assert.equal(startOutcome.result.status, 'cancelled');
    assert.equal(interruptOutcome.ok, true);
    if (interruptOutcome.ok) {
      assert.equal(interruptOutcome.result.turn.runId, queried.result.runId);
      assert.equal(interruptOutcome.result.turn.status, 'cancelled');
    }
    assert.equal(interruptSettled, true);
    assert.equal(backendFactoryAborted, true);
    assert.equal(fixture.interactions?.isPoisoned(), false);
    assert.equal(fixture.drainRequested(), false);

    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.interactions?.close();
  } finally {
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
    await completesWithin(backend.stopRequested.promise, 2_000, 'Runtime stop request');
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

test('post-start backend failure closes its owner without draining an unrelated active root', {
  timeout: 20_000,
}, async () => {
  let backend: AdmissionThenFailureBackend | undefined;
  let failingSessionId: string | undefined;
  let unrelatedBackend: LinkedChildAuthorityBackend | undefined;
  const backendReady = deferred<AdmissionThenFailureBackend>();
  const fixture = await createFailureFixture({
    withInteractions: true,
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        if (context.sessionId !== failingSessionId) {
          unrelatedBackend = new LinkedChildAuthorityBackend(context.sessionId);
          return unrelatedBackend;
        }
        backend = new AdmissionThenFailureBackend(context.sessionId);
        backendReady.resolve(backend);
        return backend;
      });
    },
  });
  failingSessionId = fixture.sessionId;

  try {
    const unrelatedSession = await fixture.stores.sessionStore.create({
      cwd: '/tmp/unrelated-active-root',
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const unrelatedTurnId = 'turn-unrelated-active-root';
    const unrelatedStarted = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: unrelatedSession.id,
        turnId: unrelatedTurnId,
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(unrelatedStarted.ok, true);
    if (!unrelatedStarted.ok) return;
    assert.ok(unrelatedBackend);

    const turnId = 'turn-admission-before-backend-failure';
    const starting = fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'admit a question then fail before publication' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    const activeBackend = await completesWithin(
      backendReady.promise,
      2_000,
      'backend construction',
    );
    await completesWithin(
      activeBackend.admitted.promise,
      2_000,
      'question admission before backend failure',
    );
    const started = await completesWithin(starting, 2_000, 'turn start before backend failure');
    assert.equal(started.ok, true);
    if (!started.ok) return;

    activeBackend.releaseFailure();
    await waitUntil(() => fixture.coordinator.readRootState(fixture.sessionId).kind === 'idle');
    await waitUntil(() => fixture.liveResidencies() === 1);

    assert.deepEqual(activeBackend.closureReasons, ['turn_terminal']);
    assert.equal(fixture.interactions?.isPoisoned(), false);
    assert.equal(fixture.drainRequested(), false);
    assert.deepEqual(fixture.coordinator.readRootState(unrelatedSession.id), {
      kind: 'active',
      sessionId: unrelatedSession.id,
      turnId: unrelatedTurnId,
      runId: unrelatedStarted.result.runId,
    });
    assert.equal(unrelatedBackend.stopCount, 0);
    const run = await fixture.stores.agentRunStore.readRun(fixture.sessionId, started.result.runId);
    const events = await fixture.stores.runtimeEventStore.readImmutableRuntimeEvents(
      fixture.sessionId,
      started.result.runId,
    );
    const terminal = classifyTerminalRuntimeLedger(run, events);
    assert.equal(terminal.kind, 'fact');
    if (terminal.kind === 'fact') assert.equal(terminal.fact.runStatus, 'failed');

    await fixture.coordinator.stopRoot({
      sessionId: unrelatedSession.id,
      turnId: unrelatedTurnId,
      runId: unrelatedStarted.result.runId,
    });
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.interactions?.close();
  } finally {
    backend?.releaseFailure();
    unrelatedBackend?.release();
    await fixture.dispose();
  }
});

test('claimed graph backend failure is contained after its failed terminal transition', {
  timeout: 20_000,
}, async () => {
  let backend: AdmissionThenFailureBackend | undefined;
  const backendReady = deferred<AdmissionThenFailureBackend>();
  const fixture = await createFailureFixture({
    withInteractions: true,
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new AdmissionThenFailureBackend(context.sessionId);
        backendReady.resolve(backend);
        return backend;
      });
    },
  });

  try {
    const { turnId, runId, execution } = executeClaimedGraphRoot(fixture, {
      key: 'backend-failure',
      claimChar: 'a',
      intentChar: 'b',
      prompt: 'fail this claimed graph execution after start',
    });
    const activeBackend = await completesWithin(
      backendReady.promise,
      2_000,
      'claimed graph backend construction',
    );
    await completesWithin(
      activeBackend.admitted.promise,
      2_000,
      'question admission before claimed graph backend failure',
    );

    activeBackend.releaseFailure();
    await completesWithin(execution, 2_000, 'claimed graph failure containment');
    const queried = await fixture.coordinator.handlers['turn.query'](
      { sessionId: fixture.sessionId, turnId },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );

    assert.equal(queried.ok, true);
    if (queried.ok) {
      assert.equal(queried.result.runId, runId);
      assert.equal(queried.result.status, 'failed');
    }
    assert.deepEqual(activeBackend.closureReasons, ['turn_terminal']);
    assert.equal(fixture.interactions?.isPoisoned(), false);
    assert.equal(fixture.drainRequested(), false);

    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.interactions?.close();
  } finally {
    backend?.releaseFailure();
    await fixture.dispose();
  }
});

test('failed claimed graph Run identity mismatch drains instead of being contained', {
  timeout: 20_000,
}, async () => {
  let backend: AdmissionThenFailureBackend | undefined;
  const fixture = await createFailureFixture({
    withInteractions: true,
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new AdmissionThenFailureBackend(context.sessionId);
        return backend;
      });
    },
  });

  try {
    const { execution } = executeClaimedGraphRoot(fixture, {
      key: 'identity-mismatch',
      claimChar: 'e',
      intentChar: 'f',
      prompt: 'throw a backend failure after identity drift',
      runtimeAgentName: 'Drifted Agent Name',
    });

    await waitUntil(() => backend !== undefined);
    await completesWithin(
      backend!.admitted.promise,
      2_000,
      'question admission before identity-drift backend failure',
    );
    backend!.releaseFailure();
    await assert.rejects(execution, RuntimeMessageAuthorityInvariantError);
    await waitUntil(() => fixture.drainRequested());
    await waitUntil(() => fixture.coordinator.readRootState(fixture.sessionId).kind === 'idle');

    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.interactions?.close();
  } finally {
    backend?.releaseFailure();
    await fixture.dispose();
  }
});

test('post-start backend AggregateError is contained after its failed terminal transition', {
  timeout: 20_000,
}, async () => {
  const firstProviderFailure = new Error('provider request failed');
  const secondProviderFailure = new Error('provider response also failed');
  const aggregateFailure = new AggregateError(
    [firstProviderFailure, secondProviderFailure],
    'provider returned multiple failures',
  );
  let backend: AdmissionThenFailureBackend | undefined;
  const fixture = await createFailureFixture({
    withInteractions: true,
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new AdmissionThenFailureBackend(context.sessionId, aggregateFailure);
        return backend;
      });
    },
  });

  try {
    const turnId = 'turn-aggregate-cleanup-failure';
    const starting = fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'surface aggregate execution cleanup failure' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    await waitUntil(() => backend !== undefined);
    await completesWithin(
      backend!.admitted.promise,
      2_000,
      'question admission before provider aggregate failure',
    );
    const started = await completesWithin(
      starting,
      2_000,
      'turn start before provider aggregate failure',
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;

    backend!.releaseFailure();
    await waitUntil(() => fixture.coordinator.readRootState(fixture.sessionId).kind === 'idle');
    assert.equal(fixture.drainRequested(), false);

    const run = await fixture.stores.agentRunStore.readRun(fixture.sessionId, started.result.runId);
    const events = await fixture.stores.runtimeEventStore.readImmutableRuntimeEvents(
      fixture.sessionId,
      started.result.runId,
    );
    const terminal = classifyTerminalRuntimeLedger(run, events);
    assert.equal(terminal.kind, 'fact');
    if (terminal.kind === 'fact') assert.equal(terminal.fact.runStatus, 'failed');

    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.interactions?.close();
  } finally {
    backend?.releaseFailure();
    await fixture.dispose();
  }
});

test('post-start message owner cleanup failure drains after its failed terminal transition', {
  timeout: 20_000,
}, async () => {
  let backend: LinkedChildAuthorityBackend | undefined;
  const cleanupFailure = new Error('message owner release failed');
  const fixture = await createFailureFixture({
    registerBackend: (backends) => {
      backends.register('fake', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      });
    },
    wrapMessageAuthority: (authority) => ({
      bindRun: (identity) => {
        const owner = authority.bindRun(identity);
        return {
          ...owner,
          pull: () => owner.pull(),
          ack: (leaseIds) => owner.ack(leaseIds),
          nack: (leaseIds) => owner.nack(leaseIds),
          release: () => {
            owner.release();
            throw cleanupFailure;
          },
        };
      },
    }),
  });

  try {
    const turnId = 'turn-message-owner-cleanup-failure';
    const started = await fixture.coordinator.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'surface rate limit with owner cleanup failure' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;

    await waitUntil(() => fixture.drainRequested());
    await waitUntil(() => fixture.coordinator.readRootState(fixture.sessionId).kind === 'idle');
    const run = await fixture.stores.agentRunStore.readRun(fixture.sessionId, started.result.runId);
    const events = await fixture.stores.runtimeEventStore.readImmutableRuntimeEvents(
      fixture.sessionId,
      started.result.runId,
    );
    const terminal = classifyTerminalRuntimeLedger(run, events);
    assert.equal(terminal.kind, 'fact');
    if (terminal.kind === 'fact') assert.equal(terminal.fact.runStatus, 'failed');

    await fixture.coordinator.close();
    await fixture.messages.close();
  } finally {
    backend?.release();
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

function executeClaimedGraphRoot(
  fixture: Awaited<ReturnType<typeof createFailureFixture>>,
  input: {
    key: string;
    claimChar: string;
    intentChar: string;
    prompt: string;
    runtimeAgentName?: string;
  },
) {
  const turnId = `turn-claimed-graph-${input.key}`;
  const runId = `run-claimed-graph-${input.key}`;
  const agentId = 'claimed-graph-operator';
  const agentName = 'Claimed Graph Operator';
  const execution = fixture.coordinator.executeRoot({
    sessionId: fixture.sessionId,
    turnId,
    runId,
    userMessageId: `message-claimed-graph-${input.key}`,
    execution: {
      kind: 'claimed_agent_graph_intent',
      claim: {
        schemaVersion: 1,
        claimId: `graph_claim_${input.claimChar.repeat(32)}`,
        graphId: `graph-${input.key}`,
        intentId: `graph_intent_${input.intentChar.repeat(32)}`,
        intentFingerprint: `sha256:${'c'.repeat(64)}`,
        readinessContextFingerprint: `sha256:${'d'.repeat(64)}`,
        targetOperatorId: agentId,
        targetSessionId: fixture.sessionId,
        targetTurnId: turnId,
        targetRunId: runId,
        claimedAt: Date.now(),
      },
      agentId,
      agentName,
    },
    content: { text: input.prompt },
    start: ({ runId: admittedRunId, userMessageId, onRunStarted }) =>
      fixture.manager.sendMessage(
        fixture.sessionId,
        {
          turnId,
          text: input.prompt,
          agentId,
          agentName: input.runtimeAgentName ?? agentName,
        },
        {
          runId: admittedRunId,
          userMessageId: userMessageId ?? undefined,
          durability: 'required',
          onRunStarted,
        },
      ),
  });
  return { turnId, runId, execution };
}

async function createFailureFixture(options: {
  registerBackend(backends: BackendRegistry): void;
  wrapAdmissionStore?(store: RootTurnAdmissionStore): RootTurnAdmissionStore;
  wrapMessageAuthority?(authority: RuntimeMessageAuthority): RuntimeMessageAuthority;
  withInteractions?: boolean;
  beforeInteractionPreflight?(): Promise<void>;
  clientCapabilities?: HostClientCapabilityCoordinator;
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
  let messages!: HostMessageCoordinator;
  let interactions: HostInteractionCoordinator | undefined;
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
    messages?.beginDrain();
    interactions?.beginDrain();
  };
  messages = new HostMessageCoordinator({
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
  interactions = options.withInteractions
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
    messageAuthority: options.wrapMessageAuthority?.(messages) ?? messages,
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
    options.clientCapabilities,
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class LinkedChildAuthorityBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly externalHoldStarted = deferred<void>();
  sendCount = 0;
  stopCount = 0;
  private stopped = false;
  private releaseWait: (() => void) | undefined;

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendCount += 1;
    this.stopped = false;
    if (input.text === HOLD_EXTERNAL_PROMPT) {
      await new Promise<void>((resolve) => {
        this.releaseWait = resolve;
        this.externalHoldStarted.resolve();
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
    this.stopCount += 1;
    this.stopped = true;
    this.releaseWait?.();
  }

  release(): void {
    this.releaseWait?.();
  }

  async respondToSandboxBoundary(): Promise<void> {}

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

  async respondToSandboxBoundary(): Promise<void> {}

  async dispose(): Promise<void> {
    this.admissionTrigger.resolve();
  }
}

class StopReleasedAdmissionBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly ready = deferred<void>();
  private readonly stopped = deferred<void>();

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'text_delta',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      messageId: randomUUID(),
      text: 'running before stop-released admission',
    };
    this.ready.resolve();
    await this.stopped.promise;
    if (!input.hostedInteraction) {
      throw new Error('StopReleasedAdmissionBackend requires hosted Interaction authority');
    }
    await input.hostedInteraction.admitUserQuestionRequest({
      request: {
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
      },
      settlement: {
        applyAnswer: async () => {},
        applyClosure: async () => {},
      },
    });
    throw new Error('Question admission unexpectedly crossed the stop closure');
  }

  async stop(): Promise<void> {
    this.stopped.resolve();
  }

  async respondToSandboxBoundary(): Promise<void> {}

  async dispose(): Promise<void> {
    this.stopped.resolve();
  }
}

class RunningAdmissionBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly admitted = deferred<void>();
  readonly stopRequested = deferred<void>();
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

  async stop(): Promise<void> {
    this.stopRequested.resolve();
  }

  async respondToSandboxBoundary(): Promise<void> {}

  async dispose(): Promise<void> {
    this.settled.resolve();
  }
}

class AdmissionThenFailureBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly admitted = deferred<void>();
  readonly closureReasons: string[] = [];
  private readonly fail = deferred<void>();

  constructor(
    readonly sessionId: string,
    private readonly failure: unknown = new Error('backend failed after question admission'),
  ) {}

  releaseFailure(): void {
    this.fail.resolve();
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (!input.hostedInteraction) {
      throw new Error('AdmissionThenFailureBackend requires hosted Interaction authority');
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
        applyAnswer: async () => {},
        applyClosure: async (reason) => {
          this.closureReasons.push(reason);
        },
      },
    });
    this.admitted.resolve();
    await this.fail.promise;
    throw this.failure;
  }

  async stop(): Promise<void> {}

  async respondToSandboxBoundary(): Promise<void> {}

  async dispose(): Promise<void> {
    this.fail.resolve();
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

  async respondToSandboxBoundary(): Promise<void> {}

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

  async respondToSandboxBoundary(): Promise<void> {}

  async dispose(): Promise<void> {
    this.sendReleased.resolve();
  }
}

class QuestionWaitingBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  private stopped = false;
  private resolveAnswer: ((answers: readonly (string | null)[] | null) => void) | undefined;
  private releaseAfterAnswer: (() => void) | undefined;

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.stopped = false;
    const requestId = randomUUID();
    const toolUseId = randomUUID();
    const request = {
      type: 'user_question_request',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      requestId,
      toolUseId,
      questions: [
        {
          question: 'Continue?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    } satisfies Extract<SessionEvent, { type: 'user_question_request' }>;
    const answerPromise = new Promise<readonly (string | null)[] | null>((resolve) => {
      this.resolveAnswer = resolve;
      if (this.stopped) resolve(null);
    });
    if (!input.hostedInteraction) {
      throw new Error('QuestionWaitingBackend requires hosted interaction authority');
    }
    await input.hostedInteraction.admitUserQuestionRequest({
      request,
      settlement: {
        applyAnswer: async (answer) => {
          this.resolveAnswer?.(answer.answers);
        },
        applyClosure: async () => {
          this.resolveAnswer?.(null);
        },
      },
    });
    yield request;
    const answers = await answerPromise;
    this.resolveAnswer = undefined;
    if (!answers || this.stopped) {
      yield* this.abort(input.turnId);
      return;
    }
    yield {
      type: 'user_question_answer_ack',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      requestId,
      toolUseId,
    };
    await new Promise<void>((resolve) => {
      this.releaseAfterAnswer = resolve;
      if (this.stopped) resolve();
    });
    yield* this.abort(input.turnId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.resolveAnswer?.(null);
    this.releaseAfterAnswer?.();
  }

  async respondToSandboxBoundary(): Promise<void> {}

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
