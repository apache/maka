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

import { deferred, withTimeout } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import { BackendRegistry, SessionManager } from '@maka/runtime/session-manager';
import {
  buildRecoveredTerminalRuntimeEvent,
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
} from '@maka/runtime/terminal-run-commit';
import { FakeBackend, FAKE_ASK_USER_QUESTION_PROMPT } from '@maka/runtime/test-only/fake-backend';
import {
  IMPLEMENTATION_AGENT_DEFINITION,
  LOCAL_READ_AGENT_PROFILE,
} from '@maka/runtime/agent-catalog';
import { mcpProxyToolName } from '@maka/runtime/mcp-tools';
import {
  RuntimeHostedRootConflictError,
  RuntimeHostedRootUnavailableError,
  RuntimeMessageAuthorityInvariantError,
  type RuntimeHostedRootAuthority,
  type RuntimeMessageAuthority,
} from '@maka/runtime/message-authority';
import {
  RuntimeInteractionAdmissionRejectedError,
  type RuntimeInteractionAuthority,
  type RuntimeInteractionRunClosureReason,
} from '@maka/runtime/interaction-authority';
import { type PreparedSkillInvocationMessage } from '@maka/runtime/skill-invocation';
import type {
  AgentBackend,
  BackendCompactHistoryInput,
  BackendSendInput,
} from '@maka/core/backend-types';
import { messageContentDigest, type SessionEvent } from '@maka/core/events';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
} from '@maka/core/session';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  clientCapabilityConnectionIdentity,
  clientCapabilityCoordinatorTestAdmission,
} from './fixtures/client-capability.js';
import {
  openInteractiveExecutionStoresForWrite,
  type RootTurnAdmission,
  type RootTurnAdmissionStore,
} from '@maka/storage/execution-stores';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { OPERATIONAL_STATE_DATABASE_NAME } from '@maka/storage/operational-state-store';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { SubscriptionFrame, TurnSnapshot } from '../protocol/index.js';
import { HostAgentGraphExecutionCoordinator } from '../server/agent-graph-execution-coordinator.js';
import { HostArtifactCoordinator } from '../server/artifact-coordinator.js';
import { HostCanonicalPermissionOutcomeReader } from '../server/canonical-permission-outcome-reader.js';
import { CanonicalSessionProjectionReader } from '../server/canonical-session-projection.js';
import { HostClientCapabilityCoordinator } from '../server/client-capability-coordinator.js';
import { ClientCapabilityInvocationError } from '../server/client-capability-invocation-broker.js';
import { HostContextCoordinator } from '../server/context-coordinator.js';
import type { RuntimeHostResidency } from '../server/host-kernel.js';
import type { HostedExecutionObserver } from '../server/hosted-execution-authority.js';
import { executeHostedExecutionToSettlement } from '../server/hosted-execution-wait.js';
import { HostInteractionCoordinator } from '../server/interaction-coordinator.js';
import { HostInteractiveTurnCoordinator } from '../server/interactive-turn-coordinator.js';
import { type HostMessageRootPort, HostMessageCoordinator } from '../server/message-coordinator.js';
import { RootAdmissionOwner } from '../server/root-admission-owner.js';
import {
  continuationSafetyDigest,
  RootTurnCoordinator,
  type TurnStartOutcome,
} from '../server/root-turn-coordinator.js';
import {
  SessionAdmissionGate,
  type SessionAdmissionLease,
} from '../server/session-admission-gate.js';
import { SessionContinuityCoordinator } from '../server/session-continuity-coordinator.js';
import type { SessionContinuityFrameSink } from '../server/session-continuity-service.js';
import { HostTurnControlCoordinator } from '../server/turn-control-coordinator.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { PROCESS_TIMEOUT_MS } from './fixtures/execution-host-suite.js';
import { waitFor } from '@maka/core/test-only/async-primitives';

const HOLD_EXTERNAL_PROMPT = 'hold external root before follow-up';
const HOLD_CONTEXT_RECOVERY_FOLLOWUP_PROMPT = 'hold follow-up before context recovery';
const NO_EXECUTION_OBSERVER: HostedExecutionObserver = {
  begin: () => undefined,
};

type StartedTurnOutcome = {
  ok: true;
  result: {
    kind: 'started';
    turn: TurnSnapshot;
    skillInvocation: Extract<TurnStartOutcome, { ok: true }>['result']['skillInvocation'];
  };
};

function assertStartedTurn(outcome: TurnStartOutcome): asserts outcome is StartedTurnOutcome {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok || outcome.result.kind !== 'started') {
    assert.fail('Expected a started Turn outcome');
  }
}

test('turn.start rejects the reserved WorkHub Coordination Session identity', async () => {
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (backendContext) => new FakeBackend(backendContext)),
  });
  try {
    assert.deepEqual(fixture.coordinator.prepare(WORKHUB_COORDINATION_SESSION_ID), {
      kind: 'unavailable',
      reason: 'WorkHub Coordination Session execution requires WorkHub authority',
    });
    const outcome = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        turnId: 'coordination-turn',
        content: { text: 'Run a tool from WorkHub.' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );

    assert.deepEqual(outcome, {
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'WorkHub Coordination Session execution requires WorkHub authority',
      },
    });
    assert.deepEqual(
      await fixture.coordinator.handlers['turn.resume.query'](
        {
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          sourceRunId: 'source-run',
          expectedRuntimeEventHighWater: 1,
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency),
      ),
      {
        ok: false,
        error: {
          code: 'operation_unavailable',
          message: 'WorkHub Coordination Session execution requires WorkHub authority',
        },
      },
    );
    assert.equal(
      await fixture.stores.agentRunStore.readRootTurnAdmission(
        WORKHUB_COORDINATION_SESSION_ID,
        'coordination-turn',
      ),
      undefined,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('turn.start rejects a corrupt Coordination role on an ordinary identity', async () => {
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (backendContext) => new FakeBackend(backendContext)),
    corruptSessionRole: true,
  });
  try {
    const outcome = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: 'corrupt-coordination-role-turn',
        content: { text: 'This must remain outside ordinary execution.' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );

    assert.deepEqual(outcome, {
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'WorkHub Coordination Session execution requires WorkHub authority',
      },
    });
    assert.equal(
      await fixture.stores.agentRunStore.readRootTurnAdmission(
        fixture.sessionId,
        'corrupt-coordination-role-turn',
      ),
      undefined,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('turn.start rejects a legacy Session until an explicit account recovery binds it', async () => {
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (backendContext) => new FakeBackend(backendContext)),
    legacyConnectionIdentity: true,
  });
  try {
    const outcome = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: 'legacy-connection-identity-turn',
        content: { text: 'This cannot select a replacement account implicitly.' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );

    assert.deepEqual(outcome, {
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'This Session requires an explicit account selection before it can run.',
      },
    });
    assert.equal(
      await fixture.stores.agentRunStore.readRootTurnAdmission(
        fixture.sessionId,
        'legacy-connection-identity-turn',
      ),
      undefined,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('prepares a fresh Agent Graph epoch before durable external Turn admission', async () => {
  let fixture!: FailureFixture;
  let cutovers = 0;
  fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
    agentGraphEpochs: {
      currentGraphId: async (rootSessionId) => agentGraphIdForRootSession(rootSessionId),
      beginNextGraphEpoch: async (rootSessionId) => {
        cutovers += 1;
        assert.equal(
          (await fixture.stores.agentRunStore.listRootTurnAdmissionsForRecovery(rootSessionId))
            .length,
          0,
        );
        return agentGraphIdForRootSession(rootSessionId);
      },
    },
  });
  try {
    const outcome = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: 'turn-after-epoch-cutover',
        content: { text: 'Start the next task.' },
        turnOrchestration: { mode: 'graph', source: 'host_api' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assertStartedTurn(outcome);
    assert.equal(cutovers, 1);
    await fixture.coordinator.whenIdle(fixture.sessionId);
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('turn.start enforces the admitted step cap at the backend boundary', async () => {
  let backend: StepCapProbeBackend | undefined;
  const fixture = await createFailureFixture({
    registerBackend: (backends) => {
      backends.register('ai-sdk', (context) => {
        backend = new StepCapProbeBackend(context.sessionId);
        return backend;
      });
    },
  });
  try {
    const turnId = 'turn-step-cap';
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'Keep calling Read.' },
        maxSteps: 1,
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assertStartedTurn(started);
    await fixture.coordinator.whenIdle(fixture.sessionId);

    const admission = await fixture.stores.agentRunStore.readRootTurnAdmission(
      fixture.sessionId,
      turnId,
    );
    assert.equal(
      admission?.execution.kind === 'external_message' ? admission.execution.maxSteps : undefined,
      1,
    );
    assert.equal(backend?.sendInputs[0]?.maxSteps, 1);
    assert.equal(backend?.providerSteps, 1);

    const runtimeEvents = await fixture.stores.runtimeEventStore.readRuntimeEvents(
      fixture.sessionId,
      started.result.turn.runId,
    );
    assert.equal(
      runtimeEvents.filter((event) => event.content?.kind === 'function_call').length,
      1,
    );
    assert.deepEqual(runtimeEvents.at(-1)?.actions?.stateDelta, {
      stopReason: 'step_limit',
      failureClass: 'tool_step_cap_reached',
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('does not advance a finished graph for an ordinary default Turn', async () => {
  let cutovers = 0;
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
    agentGraphEpochs: {
      currentGraphId: async (rootSessionId) => agentGraphIdForRootSession(rootSessionId),
      beginNextGraphEpoch: async (rootSessionId) => {
        cutovers += 1;
        return agentGraphIdForRootSession(rootSessionId);
      },
    },
  });
  try {
    const outcome = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: 'turn-without-graph-orchestration',
        content: { text: 'Continue the conversation normally.' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assertStartedTurn(outcome);
    assert.equal(cutovers, 0);
    await fixture.coordinator.whenIdle(fixture.sessionId);
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('uses the submitted Turn identity for the canonical external user message', async () => {
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
  });
  try {
    const turnId = 'turn-canonical-message';
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'Keep this identity stable.' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assertStartedTurn(started);
    await fixture.coordinator.whenIdle(fixture.sessionId);

    const user = (await fixture.stores.sessionStore.readMessages(fixture.sessionId)).find(
      (message) => message.type === 'user' && message.turnId === turnId,
    );
    assert.equal(user?.id, turnId);
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('startup recovery replays one admitted safe-boundary continuation without a UserMessage', async () => {
  const workspaceIdentity = 'workspace-safe-boundary-recovery';
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
    continuationSafety: { workspaceIdentity, availableToolNames: [] },
  });
  let observer: ReturnType<SessionContinuityCoordinator['attachConnection']> | undefined;
  try {
    await fixture.coordinator.close();
    const pending = await seedPendingSafeBoundaryContinuation(
      fixture,
      workspaceIdentity,
      'safe-boundary-recovery',
    );

    const recovery = fixture.createRecoveryCoordinator();
    await recovery.prepareRecovery();
    const terminal = deferred<TurnSnapshot>();
    const observeTerminal = (snapshot: { rootTurn: TurnSnapshot | null }): void => {
      const turn = snapshot.rootTurn;
      if (
        turn?.turnId === pending.targetTurnId &&
        turn.runId === pending.targetRunId &&
        ['completed', 'failed', 'cancelled'].includes(turn.status)
      ) {
        terminal.resolve(turn);
      }
    };
    const connectionId = 'safe-boundary-recovery-observer';
    const continuity = fixture.currentContinuity();
    observer = continuity.attachConnection(connectionId, {
      send: async (frame) => {
        if (frame.kind === 'subscription.session_projection') {
          observeTerminal(frame.snapshot);
        }
      },
    });
    const opened = await continuity.handlers['subscription.open'](
      { sessionId: fixture.sessionId, transcript: { kind: 'none' } },
      operationContext(fixture.hostEpoch, fixture.acquireResidency, connectionId),
    );
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (!opened.ok) assert.fail('Unable to observe the recovered Session');
    observeTerminal(opened.result.snapshot);
    observer.activate(opened.result.subscriptionId);

    await recovery.recover();
    assert.equal(
      (
        await withTimeout(
          terminal.promise,
          PROCESS_TIMEOUT_MS,
          'Recovered safe-boundary continuation did not publish a terminal fact',
        )
      ).status,
      'completed',
    );
    assert.equal(
      (await fixture.stores.sessionStore.readMessages(fixture.sessionId)).some(
        (message) => message.type === 'user' && message.turnId === pending.targetTurnId,
      ),
      false,
    );
    await recovery.close();
  } finally {
    observer?.close();
    await fixture.dispose();
  }
});

test('startup recovery closes a ScheduledTask Run after its pending fire was settled', async () => {
  const validations: Array<'pending_fire_required' | 'run_recorded'> = [];
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
    assertScheduledTaskRecoveryAdmission: async (_admission, state) => {
      validations.push(state);
    },
  });
  const turnId = 'turn-scheduled-task-settled-fire';
  const runId = 'run-scheduled-task-settled-fire';
  const userMessageId = 'message-scheduled-task-settled-fire';
  let recovery: RootTurnCoordinator | undefined;
  try {
    await fixture.coordinator.close();
    const session = await fixture.stores.sessionStore.readHeaderSnapshot(fixture.sessionId);
    const admittedAt = Date.now();
    const admission = await fixture.stores.agentRunStore.admitRootTurn({
      sessionId: fixture.sessionId,
      turnId,
      proposedRunId: runId,
      proposedUserMessageId: userMessageId,
      execution: { kind: 'scheduled_task', scheduledTaskId: 'task-settled-fire' },
      previousRootTurnId: null,
      normalizedInput: { text: 'Continue the scheduled work.' },
      sourceMessages: [],
      admittedAt,
    });
    assert.equal(admission.kind, 'admitted');
    await fixture.stores.sessionStore.appendMessage(fixture.sessionId, {
      type: 'user',
      id: userMessageId,
      turnId,
      ts: admittedAt,
      text: 'Continue the scheduled work.',
      origin: { kind: 'scheduled_task', scheduledTaskId: 'task-settled-fire' },
    });
    await fixture.stores.agentRunStore.createRun(
      {
        runId,
        invocationId: runId,
        sessionId: fixture.sessionId,
        turnId,
        status: 'created',
        backendKind: 'fake',
        llmConnectionId: session.llmConnectionId,
        llmConnectionSlug: session.llmConnectionSlug,
        modelId: session.model,
        cwd: session.cwd,
        scheduledTaskId: 'task-settled-fire',
        permissionMode: session.permissionMode,
        collaborationMode: session.collaborationMode,
        createdAt: admittedAt,
        updatedAt: admittedAt,
      },
      { durable: true },
    );

    recovery = fixture.createRecoveryCoordinator();
    await recovery.prepareRecovery();
    assert.deepEqual(validations, ['run_recorded']);
    await fixture.manager.recoverInterruptedSessionsStrict(fixture.stores);
    await recovery.recover();

    const run = await fixture.stores.agentRunStore.readRun(fixture.sessionId, runId);
    assert.equal(run.status, 'failed');
    assert.equal(run.failureClass, 'app_restarted');
    assert.deepEqual(recovery.readRootState(fixture.sessionId), { kind: 'idle' });
  } finally {
    await recovery?.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('a failed exact Capability retry does not poison the parked continuation binding', async () => {
  const capabilities = new HostClientCapabilityCoordinator({
    ...clientCapabilityCoordinatorTestAdmission(),
    activation: new RuntimePolicyActivationGate(),
    onModelToolsChanged: () => undefined,
  });
  const workspaceIdentity = 'workspace-safe-boundary-capability-retry';
  const fixture = await createFailureFixture({
    clientCapabilities: capabilities,
    continuationSafety: {
      workspaceIdentity,
      availableToolNames: (sessionId) => {
        const snapshot = capabilities.snapshotForSession(sessionId);
        try {
          return snapshot?.tools.map((tool) => tool.name) ?? [];
        } finally {
          snapshot?.release();
        }
      },
    },
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
  });
  const seedConnection = capabilities.attachConnection(
    clientCapabilityConnectionIdentity('provider-seed'),
    { send: async () => {} },
  );
  let wrongConnection: ReturnType<HostClientCapabilityCoordinator['attachConnection']> | undefined;
  let correctConnection:
    | ReturnType<HostClientCapabilityCoordinator['attachConnection']>
    | undefined;
  let recovery: RootTurnCoordinator | undefined;
  try {
    await registerSessionCapability(fixture, capabilities, 'provider-seed', 'registration-seed', [
      'inspect',
    ]);
    assert.deepEqual(await capabilities.bindSession(fixture.sessionId, 'provider-seed'), {
      ok: true,
    });
    await fixture.coordinator.close();
    const pending = await seedPendingSafeBoundaryContinuation(
      fixture,
      workspaceIdentity,
      'capability-retry',
    );

    await seedConnection.close();
    wrongConnection = capabilities.attachConnection(
      clientCapabilityConnectionIdentity('provider-wrong'),
      { send: async () => {} },
    );
    await registerSessionCapability(fixture, capabilities, 'provider-wrong', 'registration-wrong', [
      'inspect',
      'unexpected',
    ]);
    capabilities.retireSessions([fixture.sessionId]);
    recovery = fixture.createRecoveryCoordinator();
    await recovery.prepareRecovery();
    await recovery.recover();

    assert.deepEqual(
      await recovery.handlers['turn.resume.start'](
        {
          sessionId: fixture.sessionId,
          turnId: pending.targetTurnId,
          sourceRunId: pending.sourceRunId,
          sourceRuntimeEventHighWater: pending.sourceRuntimeEventHighWater,
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-wrong'),
      ),
      {
        ok: true,
        result: {
          kind: 'parked',
          plan: {
            sessionId: fixture.sessionId,
            disposition: 'parked',
            reason: 'safety_check_failed',
          },
        },
      },
    );

    await wrongConnection.close();
    wrongConnection = undefined;
    correctConnection = capabilities.attachConnection(
      clientCapabilityConnectionIdentity('provider-correct'),
      { send: async () => {} },
    );
    await registerSessionCapability(
      fixture,
      capabilities,
      'provider-correct',
      'registration-correct',
      ['inspect'],
    );
    const started = await recovery.handlers['turn.resume.start'](
      {
        sessionId: fixture.sessionId,
        turnId: pending.targetTurnId,
        sourceRunId: pending.sourceRunId,
        sourceRuntimeEventHighWater: pending.sourceRuntimeEventHighWater,
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-correct'),
    );
    assert.equal(started.ok && started.result.kind === 'started', true, JSON.stringify(started));
    let terminal = await fixture.turnControl.handlers['turn.query'](
      { sessionId: fixture.sessionId, turnId: pending.targetTurnId },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    await waitUntil(async () => {
      terminal = await fixture.turnControl.handlers['turn.query'](
        { sessionId: fixture.sessionId, turnId: pending.targetTurnId },
        operationContext(fixture.hostEpoch, fixture.acquireResidency),
      );
      return terminal.ok && ['completed', 'failed', 'cancelled'].includes(terminal.result.status);
    });
    assert.equal(terminal.ok, true);
    if (terminal.ok) assert.equal(terminal.result.status, 'completed');
    assert.equal(
      (await fixture.stores.agentRunStore.listSessionRuns(fixture.sessionId)).filter(
        (run) => run.turnId === pending.targetTurnId,
      ).length,
      1,
    );
    assert.equal(
      (await fixture.stores.sessionStore.readMessages(fixture.sessionId)).filter(
        (message) => message.type === 'user' && message.turnId === pending.targetTurnId,
      ).length,
      0,
    );
  } finally {
    await Promise.allSettled([
      seedConnection.close(),
      wrongConnection?.close(),
      correctConnection?.close(),
    ]);
    await recovery?.close();
    await capabilities.close();
    await fixture.dispose();
  }
});

test('resume query preserves Session-before-activation lock ordering', async () => {
  const activation = new RuntimePolicyActivationGate();
  const capabilities = new HostClientCapabilityCoordinator({
    ...clientCapabilityCoordinatorTestAdmission(),
    activation,
    onModelToolsChanged: () => undefined,
  });
  const fixture = await createFailureFixture({
    clientCapabilities: capabilities,
    continuationSafety: {
      workspaceIdentity: 'workspace-resume-query-lock-order',
      availableToolNames: (sessionId) => {
        const snapshot = capabilities.snapshotForSession(sessionId);
        try {
          return snapshot?.tools.map((tool) => tool.name) ?? [];
        } finally {
          snapshot?.release();
        }
      },
    },
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
  });
  const connection = capabilities.attachConnection(
    clientCapabilityConnectionIdentity('provider-lock-order'),
    {
      send: async () => {},
    },
  );
  const laneEntered = deferred<void>();
  const releaseLane = deferred<void>();
  let blocker: Promise<void> | undefined;
  let query: Promise<unknown> | undefined;
  try {
    await registerSessionCapability(
      fixture,
      capabilities,
      'provider-lock-order',
      'registration-lock-order',
      ['inspect'],
    );
    blocker = fixture.sessionAdmission.run(fixture.sessionId, async () => {
      laneEntered.resolve();
      await releaseLane.promise;
    });
    await laneEntered.promise;

    const queryQueued = fixture.sessionAdmission.waitForNextQueuedRun();
    query = fixture.coordinator.handlers['turn.resume.query'](
      { sessionId: fixture.sessionId },
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-lock-order'),
    );
    await queryQueued;
    await completesWithin(
      capabilities.bindSession('unrelated-session-before-release', 'provider-lock-order'),
      2_000,
      'Capability mutation while resume query waits for its Session lane',
    );

    releaseLane.resolve();
    await blocker;
    const outcome = await completesWithin(query, 2_000, 'queued resume query');
    assert.equal(
      typeof outcome === 'object' && outcome !== null && 'ok' in outcome && outcome.ok,
      true,
    );
    assert.deepEqual(
      await capabilities.bindSession('unrelated-session-after-query', 'provider-lock-order'),
      { ok: true },
    );
  } finally {
    releaseLane.resolve();
    await Promise.allSettled([blocker, query]);
    await connection.close();
    await capabilities.close();
    await fixture.dispose();
  }
});

test('turn.start durably applies one exact per-Turn orchestration override', async () => {
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
  });
  const input = {
    sessionId: fixture.sessionId,
    turnId: 'turn-hosted-swarm-override',
    content: { text: 'Use the hosted swarm override.' },
    turnOrchestration: { mode: 'swarm' as const, source: 'host_api' as const },
  };
  try {
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      input,
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true, JSON.stringify(started));
    if (!started.ok) return;
    assertStartedTurn(started);

    const run = await fixture.stores.agentRunStore.readRun(
      fixture.sessionId,
      started.result.turn.runId,
    );
    assert.equal(run.orchestrationMode, 'swarm');
    assert.equal(run.orchestrationSource, 'turn_override');
    assert.equal(run.agentSwarmAuthorization, 'turn_override');
    assert.deepEqual(
      (await fixture.stores.agentRunStore.readRootTurnAdmission(fixture.sessionId, input.turnId))
        ?.turnOrchestration,
      input.turnOrchestration,
    );

    const exactRetry = await fixture.interactiveTurns.handlers['turn.start'](
      input,
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(exactRetry.ok, true);

    const conflict = await fixture.interactiveTurns.handlers['turn.start'](
      {
        ...input,
        turnOrchestration: { mode: 'default', source: 'host_api' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.code, 'operation_conflict');
  } finally {
    await fixture.dispose();
  }
});

test('turn.start durably binds a Guest request approval to the admitted Turn', async () => {
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
  });
  const input = {
    sessionId: fixture.sessionId,
    turnId: 'turn-collaboration-request',
    content: { text: 'Run the exact approved request.' },
  };
  const authorization = {
    kind: 'session_turn_access_request' as const,
    requestId: 'request-1',
    principalId: 'session_guest:guest-1',
    grantId: 'grant-1',
    approvedAt: 1_788_000_000_000,
    approvedBy: 'local_owner',
  };
  try {
    const started = await fixture.interactiveTurns.handlers['turn.start'](input, {
      ...operationContext(fixture.hostEpoch, fixture.acquireResidency),
      principal: authorization.principalId,
      turnAdmissionAuthorization: authorization,
    });
    assertStartedTurn(started);
    assert.deepEqual(
      (await fixture.stores.agentRunStore.readRootTurnAdmission(fixture.sessionId, input.turnId))
        ?.authorization,
      authorization,
    );

    const conflictingRetry = await fixture.interactiveTurns.handlers['turn.start'](
      input,
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(conflictingRetry.ok, false);
    if (!conflictingRetry.ok) assert.equal(conflictingRetry.error.code, 'operation_conflict');
  } finally {
    await fixture.dispose();
  }
});

test('turn.start resolves explicit Skills once before durable admission and replays the result', async () => {
  let preparationCount = 0;
  let blocked = false;
  let observedCapabilityPreview = false;
  const capabilities = new HostClientCapabilityCoordinator({
    ...clientCapabilityCoordinatorTestAdmission(),
    activation: new RuntimePolicyActivationGate(),
    onModelToolsChanged: () => undefined,
  });
  const connection = capabilities.attachConnection(
    clientCapabilityConnectionIdentity('skill-provider'),
    { send: async () => {} },
  );
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
    clientCapabilities: capabilities,
    prepareSkillInvocation: async ({ sessionId }): Promise<PreparedSkillInvocationMessage> => {
      preparationCount += 1;
      const snapshot = capabilities.snapshotForSession(sessionId);
      observedCapabilityPreview = (snapshot?.tools.length ?? 0) > 0;
      snapshot?.release();
      if (blocked) {
        return {
          disposition: 'blocked',
          skillInvocation: {
            loaded: [],
            failed: [{ request: 'writer', reason: 'not_found' }],
            receipts: [
              {
                invocation: 'explicit',
                request: 'writer',
                success: false,
                reason: 'not_found',
              },
            ],
          },
        };
      }
      return {
        disposition: 'ready',
        sendText: '<invoked-skill>Write clearly.</invoked-skill>\n\nDraft this.',
        skillInvocation: {
          loaded: [{ id: 'writer', name: 'Writer' }],
          failed: [],
          receipts: [
            {
              invocation: 'explicit',
              request: 'writer',
              success: true,
              ref: 'project:maka:writer',
              id: 'writer',
              name: 'Writer',
              scope: 'project',
              source: 'maka',
              truncated: false,
            },
          ],
        },
      };
    },
  });
  const input = {
    sessionId: fixture.sessionId,
    turnId: 'turn-hosted-skill',
    content: { text: '/skill:writer Draft this.' },
    skillIds: ['writer'],
  };
  try {
    await registerSessionCapability(fixture, capabilities, 'skill-provider', 'skill-registration', [
      'inspect',
    ]);
    const context = operationContext(fixture.hostEpoch, fixture.acquireResidency, 'skill-provider');
    const started = await fixture.interactiveTurns.handlers['turn.start'](input, context);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.result.kind, 'started');
    if (started.result.kind !== 'started') return;
    assert.deepEqual(started.result.skillInvocation.loaded, [{ id: 'writer', name: 'Writer' }]);
    assert.equal(preparationCount, 1);
    assert.equal(observedCapabilityPreview, true);
    const admission = await fixture.stores.agentRunStore.readRootTurnAdmission(
      fixture.sessionId,
      input.turnId,
    );
    assert.equal(admission?.execution.kind, 'external_message');
    assert.match(
      admission?.execution.kind === 'external_message'
        ? (admission.execution.inputDigest ?? '')
        : '',
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.deepEqual(admission?.normalizedInput, {
      text: '<invoked-skill>Write clearly.</invoked-skill>\n\nDraft this.',
      displayText: '/skill:writer Draft this.',
      inlineReferences: [{ kind: 'skill', value: '/skill:writer', label: 'Writer', start: 0 }],
    });

    blocked = true;
    const exactRetry = await fixture.interactiveTurns.handlers['turn.start'](input, context);
    assert.equal(exactRetry.ok, true);
    if (exactRetry.ok) assert.deepEqual(exactRetry.result, started.result);
    assert.equal(preparationCount, 1, 'durable replay must not resolve a mutable Skill catalog');

    const conflictingRetry = await fixture.interactiveTurns.handlers['turn.start'](
      { ...input, skillIds: ['writer', 'another'] },
      context,
    );
    assert.equal(conflictingRetry.ok, false);
    if (!conflictingRetry.ok) assert.equal(conflictingRetry.error.code, 'operation_conflict');
  } finally {
    await connection.close();
    await capabilities.close();
    await fixture.dispose();
  }
});

test('queued Message preparation preserves partial and blocked Skill outcomes', async () => {
  let blocked = false;
  const readySkillInvocation = {
    loaded: [{ id: 'writer', name: 'Writer' }],
    failed: [{ request: 'typo', reason: 'not_found' as const }],
    receipts: [
      {
        invocation: 'explicit' as const,
        request: 'writer',
        success: true as const,
        ref: 'project:maka:writer',
        id: 'writer',
        name: 'Writer',
        scope: 'project' as const,
        source: 'maka' as const,
        truncated: false,
      },
      {
        invocation: 'explicit' as const,
        request: 'typo',
        success: false as const,
        reason: 'not_found' as const,
      },
    ],
  };
  const blockedSkillInvocation = {
    loaded: [],
    failed: [{ request: 'missing', reason: 'not_found' as const }],
    receipts: [],
  };
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
    prepareSkillInvocation: async () =>
      blocked
        ? { disposition: 'blocked', skillInvocation: blockedSkillInvocation }
        : {
            disposition: 'ready',
            sendText: '<invoked-skill>Write clearly.</invoked-skill>\n\nDraft this.',
            skillInvocation: readySkillInvocation,
          },
  });
  try {
    assert.deepEqual(
      await fixture.coordinator.prepareMessage({
        sessionId: fixture.sessionId,
        turnId: 'turn-running',
        content: { text: '/skill:writer /skill:typo Draft this.' },
        placement: 'current_turn',
      }),
      {
        kind: 'ready',
        content: {
          text: '<invoked-skill>Write clearly.</invoked-skill>\n\nDraft this.',
          displayText: '/skill:writer /skill:typo Draft this.',
          inlineReferences: [{ kind: 'skill', value: '/skill:writer', label: 'Writer', start: 0 }],
        },
        skillInvocation: readySkillInvocation,
      },
    );

    blocked = true;
    assert.deepEqual(
      await fixture.coordinator.prepareMessage({
        sessionId: fixture.sessionId,
        turnId: 'turn-running',
        content: { text: '/skill:missing Draft this.' },
        placement: 'current_turn',
      }),
      {
        kind: 'rejected',
        error: 'Explicit Skill invocation could not be resolved',
        skillInvocation: blockedSkillInvocation,
      },
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('turn.start durably replays an all-failed invocation without creating a Turn', async () => {
  let preparationCount = 0;
  const skillInvocation = {
    loaded: [],
    failed: [{ request: 'missing', reason: 'not_found' as const }],
    receipts: [
      {
        invocation: 'explicit' as const,
        request: 'missing',
        success: false as const,
        reason: 'not_found' as const,
      },
    ],
  };
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
    prepareSkillInvocation: async (): Promise<PreparedSkillInvocationMessage> => {
      preparationCount += 1;
      return { disposition: 'blocked', skillInvocation };
    },
  });
  const input = {
    sessionId: fixture.sessionId,
    turnId: 'turn-blocked-skill',
    content: { text: '/skill:missing' },
  } as const;
  try {
    const context = operationContext(fixture.hostEpoch, fixture.acquireResidency);
    const first = await fixture.interactiveTurns.handlers['turn.start'](input, context);
    assert.deepEqual(first, {
      ok: true,
      result: { kind: 'blocked', skillInvocation },
    });
    assert.equal(
      await fixture.stores.agentRunStore.readRootTurnAdmission(fixture.sessionId, input.turnId),
      undefined,
    );

    const retry = await fixture.interactiveTurns.handlers['turn.start'](input, context);
    assert.deepEqual(retry, first);
    assert.equal(preparationCount, 1);
  } finally {
    await fixture.dispose();
  }
});

test('idle turn.message.submit applies hosted Skill preparation before durable admission', async () => {
  let preparationCount = 0;
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
    prepareSkillInvocation: async (): Promise<PreparedSkillInvocationMessage> => {
      preparationCount += 1;
      return {
        disposition: 'ready',
        sendText: '<invoked-skill>Write clearly.</invoked-skill>\n\nDraft this.',
        skillInvocation: {
          loaded: [{ id: 'writer', name: 'Writer' }],
          failed: [],
          receipts: [
            {
              invocation: 'explicit',
              request: 'writer',
              success: true,
              ref: 'project:maka:writer',
              id: 'writer',
              name: 'Writer',
              scope: 'project',
              source: 'maka',
              truncated: false,
            },
          ],
        },
      };
    },
  });
  try {
    const outcome = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: 'idle-skill-message',
        content: { text: '/skill:writer Draft this.' },
        placement: 'current_turn',
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(preparationCount, 1);
    if (!outcome.ok || outcome.result.disposition !== 'turn_started') return;
    const admission = await fixture.stores.agentRunStore.readRootTurnAdmission(
      fixture.sessionId,
      outcome.result.turnId,
    );
    assert.deepEqual(admission?.normalizedInput, {
      text: '<invoked-skill>Write clearly.</invoked-skill>\n\nDraft this.',
      displayText: '/skill:writer Draft this.',
      inlineReferences: [{ kind: 'skill', value: '/skill:writer', label: 'Writer', start: 0 }],
    });
    assert.deepEqual(admission?.sourceMessages[0]?.content, admission?.normalizedInput);
    assert.match(
      admission?.execution.kind === 'external_message'
        ? (admission.execution.inputDigest ?? '')
        : '',
      /^sha256:[a-f0-9]{64}$/,
    );
  } finally {
    await fixture.dispose();
  }
});

test('idle Skill admission persists a canonical draft without history before root handoff', async () => {
  const canonicalText = '<invoked-skill>Write clearly.</invoked-skill>\n\nDraft this.';
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
    prepareSkillInvocation: async (): Promise<PreparedSkillInvocationMessage> => ({
      disposition: 'ready',
      sendText: canonicalText,
      skillInvocation: {
        loaded: [{ id: 'writer', name: 'Writer' }],
        failed: [],
        receipts: [],
      },
    }),
    wrapAdmissionStore: (store) => ({
      admitRootTurn: async () => {
        throw new Error('injected root admission failure');
      },
      readRootTurnAdmission: (sessionId, turnId) => store.readRootTurnAdmission(sessionId, turnId),
      readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
        store.readRootTurnSourceMessageReceipt(sessionId, messageId),
      listRootTurnAdmissionsForRecovery: (sessionId) =>
        store.listRootTurnAdmissionsForRecovery(sessionId),
    }),
  });
  try {
    await assert.rejects(
      fixture.messages.handlers['turn.message.submit'](
        {
          originHostEpoch: fixture.hostEpoch,
          sessionId: fixture.sessionId,
          messageId: 'idle-skill-before-handoff',
          content: { text: '/skill:writer Draft this.' },
          placement: 'current_turn',
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency),
      ),
      /injected root admission failure/,
    );
    const admission = await fixture.stores.sessionStore.readMessageAdmission(
      fixture.sessionId,
      'idle-skill-before-handoff',
    );
    assert.deepEqual(admission?.content, {
      text: canonicalText,
      displayText: '/skill:writer Draft this.',
      inlineReferences: [],
    });
    assert.deepEqual(await fixture.stores.sessionStore.readMessages(fixture.sessionId), []);
  } finally {
    await fixture.dispose();
  }
});

test('turn.start rejects oversized preparation before admission and preserves not-found semantics', async () => {
  let preparationCount = 0;
  let preparation: 'blocked' | 'oversized_content' | 'oversized_feedback' = 'blocked';
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
    prepareSkillInvocation: async () => {
      preparationCount += 1;
      if (preparation === 'blocked') {
        return {
          disposition: 'blocked',
          skillInvocation: {
            loaded: [],
            failed: [{ request: 'writer', reason: 'not_found' }],
            receipts: [],
          },
        };
      }
      if (preparation === 'oversized_content')
        return {
          disposition: 'ready',
          sendText: 'x'.repeat(70 * 1024),
          skillInvocation: {
            loaded: [{ id: 'writer', name: 'Writer' }],
            failed: [],
            receipts: [],
          },
        };
      const request = 'r'.repeat(512);
      const id = 'i'.repeat(81);
      const name = '"'.repeat(256);
      return {
        disposition: 'ready',
        sendText: 'Run the selected Skills.',
        skillInvocation: {
          loaded: Array.from({ length: 50 }, () => ({ id, name })),
          failed: [],
          receipts: Array.from({ length: 50 }, () => ({
            invocation: 'explicit' as const,
            request,
            success: true as const,
            ref: `workspace:legacy:${id}`,
            id,
            name,
            scope: 'workspace' as const,
            source: 'legacy' as const,
            truncated: false,
          })),
        },
      };
    },
  });
  const context = operationContext(fixture.hostEpoch, fixture.acquireResidency);
  try {
    const blocked = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: 'turn-hosted-skill-blocked',
        content: { text: '/skill:writer' },
      },
      context,
    );
    assert.equal(blocked.ok, true);
    if (blocked.ok) assert.equal(blocked.result.kind, 'blocked');
    assert.equal(
      await fixture.stores.agentRunStore.readRootTurnAdmission(
        fixture.sessionId,
        'turn-hosted-skill-blocked',
      ),
      undefined,
    );

    preparation = 'oversized_content';
    const oversized = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: 'turn-hosted-skill-oversized',
        content: { text: '/skill:writer Draft this.' },
      },
      context,
    );
    assert.equal(oversized.ok, false);
    if (!oversized.ok) assert.equal(oversized.error.code, 'operation_conflict');
    assert.equal(fixture.drainRequested(), false);
    assert.equal(
      await fixture.stores.agentRunStore.readRootTurnAdmission(
        fixture.sessionId,
        'turn-hosted-skill-oversized',
      ),
      undefined,
    );

    preparation = 'oversized_feedback';
    const oversizedFeedback = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: 'turn-hosted-skill-oversized-feedback',
        content: { text: '/skill:writer Draft this.' },
      },
      context,
    );
    assert.equal(oversizedFeedback.ok, false);
    if (!oversizedFeedback.ok) assert.equal(oversizedFeedback.error.code, 'operation_conflict');
    assert.equal(fixture.drainRequested(), false);
    assert.equal(
      await fixture.stores.agentRunStore.readRootTurnAdmission(
        fixture.sessionId,
        'turn-hosted-skill-oversized-feedback',
      ),
      undefined,
    );

    const missingSession = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: 'missing-session',
        turnId: 'turn-hosted-skill-missing-session',
        content: { text: '/skill:writer Draft this.' },
      },
      context,
    );
    assert.equal(missingSession.ok, false);
    if (!missingSession.ok) assert.equal(missingSession.error.code, 'not_found');
    assert.equal(preparationCount, 3, 'missing Sessions must not resolve Skills');
  } finally {
    await fixture.dispose();
  }
});

test('turn.start admits only canonical live Session Artifact attachments', async () => {
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
    withArtifacts: true,
  });
  try {
    const artifact = await fixture.artifacts!.create({
      id: 'attachment-fixture',
      sessionId: fixture.sessionId,
      turnId: 'upload-1',
      name: 'fixture.txt',
      kind: 'file',
      content: 'fixture bytes',
      mimeType: 'text/plain',
      source: 'user_upload',
    });
    const attachment = {
      kind: 'other' as const,
      name: artifact.name,
      mimeType: artifact.mimeType!,
      bytes: artifact.sizeBytes,
      ref: {
        kind: 'session_file' as const,
        sessionId: fixture.sessionId,
        relativePath: artifact.id,
      },
    };
    for (const [turnId, invalidAttachment] of [
      ['turn-with-wrong-size', { ...attachment, bytes: attachment.bytes + 1 }],
      ['turn-with-wrong-kind', { ...attachment, kind: 'image' as const }],
      [
        'turn-with-cross-session-ref',
        { ...attachment, ref: { ...attachment.ref, sessionId: 'another-session' } },
      ],
      [
        'turn-with-missing-artifact',
        { ...attachment, ref: { ...attachment.ref, relativePath: 'missing-artifact' } },
      ],
    ] as const) {
      const rejected = await fixture.interactiveTurns.handlers['turn.start'](
        {
          sessionId: fixture.sessionId,
          turnId,
          content: { text: 'Use this attachment.', attachments: [invalidAttachment] },
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency),
      );
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.equal(rejected.error.code, 'operation_conflict');
      assert.equal(
        await fixture.stores.agentRunStore.readRootTurnAdmission(fixture.sessionId, turnId),
        undefined,
      );
    }
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: 'turn-with-attachment',
        content: { text: 'Use this attachment.', attachments: [attachment] },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
  } finally {
    await fixture.dispose();
  }
});

test('safe-boundary continuation safety identity uses the exact canonical tool catalog', () => {
  const safetySnapshot: {
    workspaceIdentity: string;
    backgroundOperationsSettled: boolean;
    availableToolNames: readonly string[];
    workspaceCheckpoint: { ref: string; runtimeEventHighWater: number };
  } = {
    workspaceIdentity: 'workspace-safety-identity',
    backgroundOperationsSettled: true,
    availableToolNames: ['tool-beta', 'tool-alpha'],
    workspaceCheckpoint: {
      ref: 'checkpoint-ref',
      runtimeEventHighWater: 7,
    },
  };
  const digest = (snapshot: typeof safetySnapshot) =>
    continuationSafetyDigest({
      safetySnapshot: snapshot,
    } as unknown as Parameters<typeof continuationSafetyDigest>[0]);

  assert.equal(
    digest(safetySnapshot),
    digest({
      ...safetySnapshot,
      availableToolNames: ['tool-alpha', 'tool-beta', 'tool-alpha'],
    }),
  );
  assert.notEqual(
    digest(safetySnapshot),
    digest({
      ...safetySnapshot,
      availableToolNames: ['tool-alpha', 'tool-beta', 'tool-privileged'],
    }),
  );
  assert.notEqual(
    digest(safetySnapshot),
    digest({ ...safetySnapshot, workspaceIdentity: 'different-workspace' }),
  );
  assert.notEqual(
    digest(safetySnapshot),
    digest({ ...safetySnapshot, backgroundOperationsSettled: false }),
  );
  assert.notEqual(
    digest(safetySnapshot),
    digest({
      ...safetySnapshot,
      workspaceCheckpoint: { ...safetySnapshot.workspaceCheckpoint, ref: 'different-checkpoint' },
    }),
  );
  assert.notEqual(
    digest(safetySnapshot),
    digest({
      ...safetySnapshot,
      workspaceCheckpoint: {
        ...safetySnapshot.workspaceCheckpoint,
        runtimeEventHighWater: 8,
      },
    }),
  );
});

test('linked child Sessions reject public safe-boundary continuation', async () => {
  let recoveryCoordinator: RootTurnCoordinator | undefined;
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
  });
  try {
    const parent = await fixture.stores.sessionStore.readHeaderSnapshot(fixture.sessionId);
    const { header: child } = await fixture.stores.sessionStore.createSubagent({
      cwd: parent.cwd,
      llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      subagentParent: {
        kind: 'subagent',
        parentSessionId: fixture.sessionId,
        spawnedBy: {
          parentRunId: 'parent-run',
          parentTurnId: 'parent-turn',
          toolCallId: 'implementation-spawn',
        },
        lifecycle: 'foreground',
      },
      subagentRuntime: {
        schemaVersion: 1,
        definitionVersion: IMPLEMENTATION_AGENT_DEFINITION.definitionVersion,
        agentId: IMPLEMENTATION_AGENT_DEFINITION.id,
        agentName: IMPLEMENTATION_AGENT_DEFINITION.name,
        profile: 'implementation',
        systemPrompt: IMPLEMENTATION_AGENT_DEFINITION.systemPrompt,
        toolNames: [...IMPLEMENTATION_AGENT_DEFINITION.tools],
        categoryPolicy: {},
      },
      subagentSpawn: {
        schemaVersion: 1,
        requestFingerprint: 'c'.repeat(64),
        initialTurnId: 'managed-child-turn',
        initialRunId: 'managed-child-run',
      },
    });
    const unavailableMessage = 'Child Sessions must be continued through their parent agent.';

    assert.deepEqual(
      await fixture.coordinator.handlers['turn.resume.query'](
        { sessionId: child.id },
        operationContext(fixture.hostEpoch, fixture.acquireResidency),
      ),
      {
        ok: false,
        error: { code: 'operation_unavailable', message: unavailableMessage },
      },
    );
    assert.deepEqual(
      await fixture.coordinator.handlers['turn.resume.start'](
        {
          sessionId: child.id,
          turnId: 'external-child-continuation-turn',
          sourceRunId: 'external-child-source-run',
          sourceRuntimeEventHighWater: 1,
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency),
      ),
      {
        ok: false,
        error: { code: 'operation_unavailable', message: unavailableMessage },
      },
    );

    await fixture.coordinator.close();
    const targetTurnId = 'parked-external-child-continuation-turn';
    await fixture.stores.agentRunStore.admitRootTurn({
      sessionId: child.id,
      turnId: targetTurnId,
      proposedRunId: 'parked-external-child-continuation-run',
      proposedUserMessageId: null,
      execution: {
        kind: 'safe_boundary_continuation',
        sourceInvocationId: 'external-child-source-invocation',
        sourceRunId: 'external-child-source-run',
        sourceTurnId: 'external-child-source-turn',
        sourceRuntimeEventHighWater: 1,
        claimId: 'external-child-continuation-claim',
        boundaryDigest: `sha256:${'a'.repeat(64)}`,
        providerReplayDigest: `sha256:${'b'.repeat(64)}`,
        safetyDigest: `sha256:${'c'.repeat(64)}`,
        targetInvocationId: 'external-child-target-invocation',
      },
      previousRootTurnId: null,
      normalizedInput: null,
      sourceMessages: [],
      admittedAt: Date.now(),
    });
    recoveryCoordinator = fixture.createRecoveryCoordinator();
    await recoveryCoordinator.prepareRecovery();
    await recoveryCoordinator.recover();

    assert.deepEqual(recoveryCoordinator.readRootState(child.id), { kind: 'reserved' });
    assert.equal(
      (await fixture.stores.agentRunStore.listSessionRuns(child.id)).some(
        (run) => run.turnId === targetTurnId,
      ),
      false,
    );
    assert.deepEqual(
      await recoveryCoordinator.handlers['turn.resume.start'](
        {
          sessionId: child.id,
          turnId: targetTurnId,
          sourceRunId: 'external-child-source-run',
          sourceRuntimeEventHighWater: 1,
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency),
      ),
      {
        ok: false,
        error: {
          code: 'operation_unavailable',
          message: unavailableMessage,
        },
      },
    );
    assert.deepEqual(recoveryCoordinator.readRootState(child.id), { kind: 'reserved' });
  } finally {
    await recoveryCoordinator?.close();
    await fixture.dispose();
  }
});

test('worktree child Sessions reject roots outside managed child execution', async () => {
  let backend: LinkedChildAuthorityBackend | undefined;
  let recoveryCoordinator: RootTurnCoordinator | undefined;
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      }),
    childTools: IMPLEMENTATION_AGENT_DEFINITION.tools.map(testTool),
  });
  const binding = {
    schemaVersion: 1 as const,
    kind: 'git_worktree' as const,
    leaseId: `subagent_worktree_${'a'.repeat(32)}`,
    gitCommonDir: '/tmp/project/.git',
    worktreePath: '/tmp/worktrees/managed-child',
    branch: `maka/subagent/${'a'.repeat(32)}`,
    baseCommit: 'b'.repeat(40),
  };
  try {
    const { header: child } = await fixture.stores.sessionStore.createSubagent({
      cwd: binding.worktreePath,
      llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      subagentParent: {
        kind: 'subagent',
        parentSessionId: fixture.sessionId,
        spawnedBy: {
          parentRunId: 'parent-run',
          parentTurnId: 'parent-turn',
          toolCallId: 'implementation-spawn',
        },
        lifecycle: 'foreground',
      },
      subagentRuntime: {
        schemaVersion: 1,
        definitionVersion: IMPLEMENTATION_AGENT_DEFINITION.definitionVersion,
        agentId: IMPLEMENTATION_AGENT_DEFINITION.id,
        agentName: IMPLEMENTATION_AGENT_DEFINITION.name,
        profile: 'implementation',
        systemPrompt: IMPLEMENTATION_AGENT_DEFINITION.systemPrompt,
        toolNames: [...IMPLEMENTATION_AGENT_DEFINITION.tools],
        categoryPolicy: {},
      },
      subagentSpawn: {
        schemaVersion: 1,
        requestFingerprint: 'c'.repeat(64),
        initialTurnId: 'managed-child-turn',
        initialRunId: 'managed-child-run',
      },
      subagentWorkspace: binding,
    });
    const unavailableMessage =
      'Worktree child Sessions must be continued through their parent agent.';

    assert.deepEqual(
      await fixture.interactiveTurns.handlers['turn.start'](
        {
          sessionId: child.id,
          turnId: 'external-child-turn',
          content: { text: 'Modify the child directly.' },
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency),
      ),
      {
        ok: false,
        error: { code: 'operation_unavailable', message: unavailableMessage },
      },
    );
    assert.equal(
      (await fixture.coordinator.readSessionHeader(child.id))?.unavailableReason,
      unavailableMessage,
    );
    await assert.rejects(
      () =>
        executeHostedExecutionToSettlement(fixture.coordinator, {
          sessionId: child.id,
          turnId: 'external-child-turn-2',
          runId: 'external-child-run-2',
          userMessageId: 'external-child-message-2',
          execution: { kind: 'external_message' },
          content: { text: 'Modify the child from an external message.' },
          start: async function* () {},
        }),
      RuntimeHostedRootUnavailableError,
    );

    const managed = executeHostedExecutionToSettlement(fixture.coordinator, {
      sessionId: child.id,
      turnId: 'managed-child-turn',
      runId: 'managed-child-run',
      userMessageId: 'managed-child-message',
      execution: {
        kind: 'linked_child_initial',
        agentId: IMPLEMENTATION_AGENT_DEFINITION.id,
        agentName: IMPLEMENTATION_AGENT_DEFINITION.name,
      },
      content: { text: HOLD_EXTERNAL_PROMPT },
      start: ({ runId, userMessageId, onRunStarted }) =>
        fixture.manager.sendMessage(
          child.id,
          {
            turnId: 'managed-child-turn',
            text: HOLD_EXTERNAL_PROMPT,
            agentId: IMPLEMENTATION_AGENT_DEFINITION.id,
            agentName: IMPLEMENTATION_AGENT_DEFINITION.name,
          },
          {
            runId,
            userMessageId: userMessageId ?? undefined,
            durability: 'required',
            onRunStarted,
          },
        ),
    });
    await waitUntil(() => backend !== undefined);
    await backend?.externalHoldStarted.promise;

    for (const placement of ['current_turn', 'next_turn'] as const) {
      assert.deepEqual(
        await fixture.messages.handlers['turn.message.submit'](
          {
            originHostEpoch: fixture.hostEpoch,
            sessionId: child.id,
            messageId: randomUUID(),
            content: { text: `External ${placement} mutation.` },
            placement,
          },
          operationContext(fixture.hostEpoch, fixture.acquireResidency),
        ),
        {
          ok: false,
          error: { code: 'operation_unavailable', message: unavailableMessage },
        },
      );
    }
    assert.deepEqual(fixture.messages.projection(child.id).steering, []);
    assert.deepEqual(fixture.messages.projection(child.id).followup, []);
    assert.equal(
      (await fixture.stores.agentRunStore.listRootTurnAdmissionsForRecovery(child.id)).length,
      1,
    );
    assert.equal((await fixture.stores.agentRunStore.listSessionRuns(child.id)).length, 1);

    backend?.release();
    await managed;
    assert.deepEqual(fixture.coordinator.readRootState(child.id), {
      kind: 'idle',
    });

    await fixture.coordinator.close();
    await fixture.stores.agentRunStore.admitRootTurn({
      sessionId: child.id,
      turnId: 'legacy-external-child-turn',
      proposedRunId: 'legacy-external-child-run',
      proposedUserMessageId: 'legacy-external-child-message',
      execution: { kind: 'external_message' },
      normalizedInput: { text: 'Recover an unmanaged child Turn.' },
      sourceMessages: [],
      admittedAt: Date.now(),
      previousRootTurnId: 'managed-child-turn',
    });
    const recovery = fixture.createRecoveryCoordinator();
    recoveryCoordinator = recovery;
    await recovery.prepareRecovery();
    await assert.rejects(
      () => recovery.recover(),
      /Unable to recover admitted Turn legacy-external-child-turn: operation_unavailable/,
    );
    assert.equal((await fixture.stores.agentRunStore.listSessionRuns(child.id)).length, 1);
  } finally {
    backend?.release();
    await recoveryCoordinator?.close();
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('Agent Graph supervisor stop owns only graph-capable root Turns', async () => {
  let backend: LinkedChildAuthorityBackend | undefined;
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      }),
  });
  try {
    const ordinaryTurnId = 'turn-before-graph-stop';
    const ordinary = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: ordinaryTurnId,
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(ordinary.ok, true);
    await waitUntil(() => backend !== undefined);
    await backend?.externalHoldStarted.promise;

    await fixture.coordinator.stopAgentGraphSupervisor(fixture.sessionId, {
      source: 'stop_button',
    });
    assert.equal(backend?.stopCount, 0);
    assert.equal(fixture.coordinator.readRootState(fixture.sessionId).kind, 'active');

    const ordinaryIdle = fixture.coordinator.whenIdle(fixture.sessionId);
    assert.ok(ordinaryIdle);
    backend?.release();
    await ordinaryIdle;

    for (const [index, mode] of (['graph', 'swarm'] as const).entries()) {
      await fixture.manager.setOrchestrationMode(fixture.sessionId, mode);
      const graph = await fixture.interactiveTurns.handlers['turn.start'](
        {
          sessionId: fixture.sessionId,
          turnId: `turn-owned-by-${mode}-stop`,
          content: { text: HOLD_EXTERNAL_PROMPT },
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency),
      );
      assert.equal(graph.ok, true);
      await waitUntil(() => backend?.sendCount === index + 2);

      await fixture.coordinator.stopAgentGraphSupervisor(fixture.sessionId, {
        source: 'stop_button',
      });
      assert.equal(backend?.stopCount, index + 1);
      assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), { kind: 'idle' });
    }
    assert.equal(fixture.drainRequested(), false);
  } finally {
    backend?.release();
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('Agent Graph supervisor stop rejects a stale graph identity inside session admission', async () => {
  let backend: LinkedChildAuthorityBackend | undefined;
  let currentGraphId = 'graph-before-rollover';
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      }),
    agentGraphEpochs: {
      currentGraphId: async () => currentGraphId,
      beginNextGraphEpoch: async () => currentGraphId,
    },
  });
  try {
    await fixture.manager.setOrchestrationMode(fixture.sessionId, 'graph');
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: 'turn-owned-by-graph-before-rollover',
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    await waitUntil(() => backend !== undefined);
    await backend?.externalHoldStarted.promise;

    currentGraphId = 'graph-after-rollover';
    await assert.rejects(
      () =>
        fixture.coordinator.stopAgentGraphSupervisor(fixture.sessionId, {
          expectedGraphId: currentGraphId,
          source: 'stop_button',
        }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeHostedRootConflictError);
        assert.match(error.message, /graph-after-rollover.*no longer current/);
        return true;
      },
    );
    assert.equal(backend?.stopCount, 0);
    assert.equal(fixture.coordinator.readRootState(fixture.sessionId).kind, 'active');
  } finally {
    backend?.release();
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('Agent Graph supervisor stop owns a graph safe-boundary continuation', async () => {
  const workspaceIdentity = 'workspace-graph-continuation-stop';
  let backend: BlockingRootBackend | undefined;
  const fixture = await createFailureFixture({
    continuationSafety: { workspaceIdentity, availableToolNames: [] },
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => {
        backend = new BlockingRootBackend(context.sessionId);
        return backend;
      }),
  });
  let recovery: RootTurnCoordinator | undefined;
  try {
    await fixture.manager.setOrchestrationMode(fixture.sessionId, 'graph');
    await fixture.coordinator.close();
    await seedPendingSafeBoundaryContinuation(
      fixture,
      workspaceIdentity,
      'graph-continuation-stop',
      'graph',
    );

    recovery = fixture.createRecoveryCoordinator();
    await recovery.prepareRecovery();
    await recovery.recover();
    await waitUntil(() => backend !== undefined);
    await backend?.started.promise;

    await recovery.stopAgentGraphSupervisor(fixture.sessionId, { source: 'stop_button' });
    assert.equal(backend?.stopCount, 1);
    assert.deepEqual(recovery.readRootState(fixture.sessionId), { kind: 'idle' });
    assert.equal(fixture.drainRequested(), false);
  } finally {
    backend?.release();
    await recovery?.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('Agent Graph supervisor wake waits for root idle and binds one durable execution identity', async () => {
  let backend: LinkedChildAuthorityBackend | undefined;
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      }),
  });
  const externalTurnId = 'turn-before-graph-wake';
  const graphId = agentGraphIdForRootSession(fixture.sessionId);
  const wakeId = `${graphId}:snapshot-1`;
  const attemptId = 'graph-wake-attempt-1';
  const graphTurnId = 'turn-graph-supervisor-wake';
  try {
    const external = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: externalTurnId,
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(external.ok, true);
    await waitUntil(() => backend !== undefined);
    await backend?.externalHoldStarted.promise;

    const wake = graphExecutions(fixture).run(
      fixture.sessionId,
      {
        turnId: graphTurnId,
        text: 'Inspect the durable graph.',
        displayText: 'Agent graph reached a supervisor checkpoint.',
        turnOrchestration: { mode: 'graph', source: 'host_api' },
        origin: { kind: 'agent_graph', graphId, wakeId, attemptId },
      },
      new AbortController().signal,
      async () => true,
    );

    assert.equal(
      (await fixture.stores.agentRunStore.listRootTurnAdmissionsForRecovery(fixture.sessionId))
        .length,
      1,
    );
    backend?.release();
    assert.deepEqual(await wake, { kind: 'completed', turnId: graphTurnId });

    const admissions = await fixture.stores.agentRunStore.listRootTurnAdmissionsForRecovery(
      fixture.sessionId,
    );
    assert.equal(admissions.length, 2);
    const graphAdmission = admissions.find((admission) => admission.turnId === graphTurnId);
    assert.ok(graphAdmission);
    assert.deepEqual(graphAdmission?.execution, {
      kind: 'agent_graph_supervisor_wake',
      graphId,
      wakeId,
      attemptId,
    });
    assert.deepEqual(graphAdmission?.turnOrchestration, {
      mode: 'graph',
      source: 'host_api',
    });

    const graphRun = await fixture.stores.agentRunStore.readRun(
      fixture.sessionId,
      graphAdmission!.runId,
    );
    assert.equal(graphRun.agentGraphWakeId, wakeId);
    assert.equal(graphRun.agentGraphWakeAttemptId, attemptId);
    assert.equal(graphRun.orchestrationMode, 'graph');
    assert.equal(graphRun.orchestrationSource, 'turn_override');
    const userMessage = (await fixture.stores.sessionStore.readMessages(fixture.sessionId)).find(
      (message) => message.id === graphAdmission?.userMessageId,
    );
    assert.ok(userMessage?.type === 'user');
    if (userMessage?.type === 'user') {
      assert.deepEqual(userMessage.origin, {
        kind: 'agent_graph',
        graphId,
        wakeId,
        attemptId,
      });
      assert.equal(userMessage.displayText, 'Agent graph reached a supervisor checkpoint.');
    }
    assert.equal(fixture.drainRequested(), false);
  } finally {
    backend?.release();
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('Agent Graph supervisor wake preserves structured context-overflow outcomes', async () => {
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new ContextFailureBackend(context.sessionId)),
  });
  const graphId = agentGraphIdForRootSession(fixture.sessionId);
  try {
    for (const [index, text] of [
      'provider context overflow',
      'local context budget exhausted',
    ].entries()) {
      const turnId = `turn-graph-context-${index}`;
      const outcome = await graphExecutions(fixture).run(
        fixture.sessionId,
        {
          turnId,
          text,
          turnOrchestration: { mode: 'graph', source: 'host_api' },
          origin: {
            kind: 'agent_graph',
            graphId,
            wakeId: `${graphId}:context-${index}`,
            attemptId: `context-attempt-${index}`,
          },
        },
        new AbortController().signal,
        async () => true,
      );

      assert.deepEqual(outcome, {
        kind: 'context_overflow',
        turnId,
        reason: index === 0 ? 'context_overflow' : 'context_budget_exhausted',
      });
    }
    assert.equal(fixture.drainRequested(), false);
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('Agent Graph context recovery fences competing root turns while compaction runs', async () => {
  let backend: BlockingContextRecoveryBackend | undefined;
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => {
        backend = new BlockingContextRecoveryBackend(context.sessionId);
        return backend;
      }),
  });
  const compactTurnId = 'turn-graph-context-recovery';
  try {
    const recovery = graphExecutions(fixture).recoverContextOverflow(
      fixture.sessionId,
      compactTurnId,
      new AbortController().signal,
    );
    await waitUntil(() => backend !== undefined);
    await backend?.compactStarted.promise;

    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), {
      kind: 'reserved',
    });
    const competing = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: 'turn-racing-context-recovery',
        content: { text: 'Do not overlap the recovery compaction.' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(competing.ok, false);
    if (!competing.ok) assert.equal(competing.error.code, 'session_busy');

    backend?.releaseCompact();
    assert.equal(await recovery, undefined);
    assert.equal(backend?.compactInput?.turnId, compactTurnId);
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), {
      kind: 'idle',
    });

    const following = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: 'turn-after-context-recovery',
        content: { text: 'Continue after recovery.' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(following.ok, true);
    assert.equal(fixture.drainRequested(), false);
  } finally {
    backend?.releaseCompact();
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('manual context compact uses durable root query, stop, and exact retry authority', async () => {
  let backend: BlockingContextRecoveryBackend | undefined;
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => {
        backend = new BlockingContextRecoveryBackend(context.sessionId);
        return backend;
      }),
  });
  const turnId = 'turn-manual-context-compact';
  const context = operationContext(fixture.hostEpoch, fixture.acquireResidency);
  try {
    const started = await fixture.contextOperations.handlers['context.compact'](
      { sessionId: fixture.sessionId, turnId },
      context,
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.result.kind, 'started');
    assert.equal(started.result.turn.sessionId, fixture.sessionId);
    assert.equal(started.result.turn.turnId, turnId);
    await backend?.compactStarted.promise;
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), {
      kind: 'active',
      sessionId: fixture.sessionId,
      turnId,
      runId: started.result.turn.runId,
    });

    const queried = await fixture.turnControl.handlers['turn.query'](
      { sessionId: fixture.sessionId, turnId },
      context,
    );
    assert.equal(queried.ok, true);
    if (queried.ok) assert.equal(queried.result.runId, started.result.turn.runId);

    const stopped = await fixture.turnControl.handlers['turn.stop'](
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.result.turn.runId,
      },
      context,
    );
    assert.equal(stopped.ok, true);
    if (!stopped.ok) return;
    assert.equal(stopped.result.status, 'cancelled');

    const retried = await fixture.contextOperations.handlers['context.compact'](
      { sessionId: fixture.sessionId, turnId },
      context,
    );
    assert.deepEqual(retried, {
      ok: true,
      result: {
        kind: 'finished',
        turn: stopped.result,
        outcome: { kind: 'failed', reason: stopped.result.abortSource },
      },
    });
    const admission = await fixture.stores.agentRunStore.readRootTurnAdmission(
      fixture.sessionId,
      turnId,
    );
    assert.deepEqual(admission?.execution, { kind: 'context_compact' });
    assert.equal(admission?.userMessageId, null);
    assert.equal(
      (await fixture.stores.sessionStore.readMessages(fixture.sessionId)).some(
        (message) => message.type === 'user' && message.turnId === turnId,
      ),
      false,
    );
    assert.equal(fixture.drainRequested(), false);
  } finally {
    backend?.releaseCompact();
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('startup recovery replays an admitted context compact with its exact Run identity', async () => {
  let backend: BlockingContextRecoveryBackend | undefined;
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => {
        backend = new BlockingContextRecoveryBackend(context.sessionId);
        return backend;
      }),
  });
  const turnId = 'turn-recovered-context-compact';
  const runId = 'run-recovered-context-compact';
  let recovery: RootTurnCoordinator | undefined;
  try {
    await fixture.coordinator.close();
    await fixture.stores.agentRunStore.admitRootTurn({
      sessionId: fixture.sessionId,
      turnId,
      proposedRunId: runId,
      proposedUserMessageId: null,
      execution: { kind: 'context_compact' },
      previousRootTurnId: null,
      normalizedInput: null,
      sourceMessages: [],
      admittedAt: Date.now(),
    });

    recovery = fixture.createRecoveryCoordinator();
    await recovery.prepareRecovery();
    await recovery.recover();
    await backend?.compactStarted.promise;
    assert.deepEqual(recovery.readRootState(fixture.sessionId), {
      kind: 'active',
      sessionId: fixture.sessionId,
      turnId,
      runId,
    });

    const stopped = await fixture.turnControl.handlers['turn.stop'](
      { sessionId: fixture.sessionId, turnId, runId },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(stopped.ok, true);
    if (stopped.ok) assert.equal(stopped.result.status, 'cancelled');
    assert.equal(
      (await fixture.stores.agentRunStore.listSessionRuns(fixture.sessionId)).filter(
        (run) => run.turnId === turnId,
      ).length,
      1,
    );
    assert.equal(fixture.drainRequested(), false);
  } finally {
    backend?.releaseCompact();
    await recovery?.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('Agent Graph context recovery abort stops compaction and releases Host close', async () => {
  let backend: BlockingContextRecoveryBackend | undefined;
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => {
        backend = new BlockingContextRecoveryBackend(context.sessionId);
        return backend;
      }),
  });
  const abortController = new AbortController();
  try {
    const recovery = graphExecutions(fixture).recoverContextOverflow(
      fixture.sessionId,
      'turn-aborted-graph-context-recovery',
      abortController.signal,
    );
    await waitUntil(() => backend !== undefined);
    await backend?.compactStarted.promise;

    const closed = fixture.coordinator.close();
    abortController.abort();
    await assert.rejects(recovery, (error) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, 'AbortError');
      return true;
    });
    await closed;
    assert.equal(backend?.stopCount, 1);
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), { kind: 'idle' });
  } finally {
    abortController.abort();
    backend?.releaseCompact();
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('Agent Graph context recovery waits for a confirmed follow-up root', async () => {
  let backend: GraphFollowupRecoveryBackend | undefined;
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => {
        backend = new GraphFollowupRecoveryBackend(context.sessionId);
        return backend;
      }),
  });
  const graphId = agentGraphIdForRootSession(fixture.sessionId);
  const graphTurnId = 'turn-graph-context-before-follow-up';
  try {
    const graphTurn = graphExecutions(fixture).run(
      fixture.sessionId,
      {
        turnId: graphTurnId,
        text: 'Overflow after a follow-up is confirmed.',
        turnOrchestration: { mode: 'graph', source: 'host_api' },
        origin: {
          kind: 'agent_graph',
          graphId,
          wakeId: `${graphId}:context-follow-up`,
          attemptId: 'context-follow-up-attempt',
        },
      },
      new AbortController().signal,
      async () => true,
    );
    await waitUntil(() => backend !== undefined);
    await backend?.graphTurnStarted.promise;

    const queued = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: 'message-before-context-recovery',
        content: { text: HOLD_CONTEXT_RECOVERY_FOLLOWUP_PROMPT },
        placement: 'next_turn',
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(queued.ok && queued.result.disposition, 'followup');
    backend?.releaseGraphTurn();
    assert.deepEqual(await graphTurn, {
      kind: 'context_overflow',
      turnId: graphTurnId,
      reason: 'context_overflow',
    });

    const recovery = graphExecutions(fixture).recoverContextOverflow(
      fixture.sessionId,
      'turn-context-recovery-after-follow-up',
      new AbortController().signal,
    );
    await backend?.followupStarted.promise;
    assert.equal(backend?.compactStartedCount, 0);

    backend?.releaseFollowup();
    await backend?.compactStarted.promise;
    assert.equal(backend?.compactStartedCount, 1);
    backend?.releaseCompact();
    assert.equal(await recovery, undefined);
    assert.equal(fixture.drainRequested(), false);
  } finally {
    backend?.releaseGraphTurn();
    backend?.releaseFollowup();
    backend?.releaseCompact();
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('Agent Graph supervisor wake revalidates freshness before durable root admission', async () => {
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
  });
  const graphId = agentGraphIdForRootSession(fixture.sessionId);
  const turnId = 'turn-stale-graph-supervisor-wake';
  try {
    const outcome = await graphExecutions(fixture).run(
      fixture.sessionId,
      {
        turnId,
        text: 'Inspect a stale graph checkpoint.',
        turnOrchestration: { mode: 'graph', source: 'host_api' },
        origin: {
          kind: 'agent_graph',
          graphId,
          wakeId: `${graphId}:stale-snapshot`,
          attemptId: 'stale-attempt',
        },
      },
      new AbortController().signal,
      async () => false,
    );

    assert.deepEqual(outcome, {
      kind: 'superseded',
      turnId,
      reason: 'Agent graph supervisor checkpoint was superseded before root admission.',
    });
    assert.deepEqual(
      await fixture.stores.agentRunStore.listRootTurnAdmissionsForRecovery(fixture.sessionId),
      [],
    );
    assert.deepEqual(await fixture.stores.agentRunStore.listSessionRuns(fixture.sessionId), []);
    assert.deepEqual(await fixture.stores.sessionStore.readMessages(fixture.sessionId), []);
    assert.equal(fixture.drainRequested(), false);
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('Agent Graph supervisor recovery closes a durable admission that has no Run', async () => {
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
  });
  const graphId = agentGraphIdForRootSession(fixture.sessionId);
  const wakeId = `${graphId}:snapshot-recovery`;
  const attemptId = 'graph-wake-recovery-attempt';
  const turnId = 'turn-graph-wake-recovery';
  const runId = 'run-graph-wake-recovery';
  const userMessageId = 'message-graph-wake-recovery';
  let recovery: RootTurnCoordinator | undefined;
  try {
    await fixture.coordinator.close();
    await fixture.stores.agentRunStore.admitRootTurn({
      sessionId: fixture.sessionId,
      turnId,
      proposedRunId: runId,
      proposedUserMessageId: userMessageId,
      execution: {
        kind: 'agent_graph_supervisor_wake',
        graphId,
        wakeId,
        attemptId,
      },
      normalizedInput: {
        text: 'Inspect the durable graph after restart.',
        displayText: 'Agent graph reached a supervisor checkpoint.',
      },
      turnOrchestration: { mode: 'graph', source: 'host_api' },
      sourceMessages: [],
      admittedAt: Date.now(),
      previousRootTurnId: null,
    });

    recovery = fixture.createRecoveryCoordinator();
    await recovery.prepareRecovery();
    await recovery.recover();

    const run = await fixture.stores.agentRunStore.readRun(fixture.sessionId, runId);
    assert.equal(run.status, 'failed');
    assert.equal(run.failureClass, 'app_restarted');
    assert.equal(run.agentGraphWakeId, wakeId);
    assert.equal(run.agentGraphWakeAttemptId, attemptId);
    assert.equal(run.orchestrationMode, 'graph');
    assert.equal(run.orchestrationSource, 'turn_override');
    const message = (await fixture.stores.sessionStore.readMessages(fixture.sessionId)).find(
      (candidate) => candidate.id === userMessageId,
    );
    assert.ok(message?.type === 'user');
    if (message?.type === 'user') {
      assert.deepEqual(message.origin, {
        kind: 'agent_graph',
        graphId,
        wakeId,
        attemptId,
      });
      assert.equal(message.text, 'Inspect the durable graph after restart.');
      assert.equal(message.displayText, 'Agent graph reached a supervisor checkpoint.');
    }
    assert.deepEqual(recovery.readRootState(fixture.sessionId), {
      kind: 'idle',
    });
    assert.equal(fixture.drainRequested(), false);
  } finally {
    await recovery?.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('hosted root target unavailability is retryable without poisoning the Host', async () => {
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
  });
  try {
    await assert.rejects(
      () =>
        executeHostedExecutionToSettlement(fixture.coordinator, {
          sessionId: 'missing-session',
          turnId: 'turn-missing-root',
          runId: 'run-missing-root',
          userMessageId: 'message-missing-root',
          execution: { kind: 'external_message' },
          content: { text: 'Retry later.' },
          start: async function* () {},
        }),
      RuntimeHostedRootUnavailableError,
    );
    assert.equal(fixture.drainRequested(), false);
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

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
      llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
      startFromMessage: (input, admission, commitAdmission) =>
        requireCoordinator(coordinator).startFromMessage(input, admission, commitAdmission),
      prepareMessage: (input) => requireCoordinator(coordinator).prepareMessage(input),
      claimStop: (input, commitQueueFence, admission) =>
        requireCoordinator(coordinator).claimStop(input, commitQueueFence, admission),
    };
    const hostEpoch = 'epoch-linked-root';
    const messages = new HostMessageCoordinator({
      hostEpoch,
      root: rootPort,
      durableProof: {
        readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
          stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
        readImmutableSteeringMessageProof: (sessionId, messageId) =>
          stores.runtimeEventStore.readImmutableSteeringMessageProof(sessionId, messageId),
      },
      admissions: stores.sessionStore,
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
      sandboxBoundaries: stores.sessionStore,
      sessionAdmission,
      sessions: stores.sessionStore,
      preflightSessionSnapshot: (sessionId, interactionProjection) =>
        canonicalProjectionReader.fitsCandidate(sessionId, {
          interactions: interactionProjection,
        }),
      refreshCanonicalContinuity: (sessionId, admission) =>
        requireContinuity(continuity).refreshCanonical(sessionId, admission),
      onPoison: () => {
        drainRequested = true;
      },
      onSandboxBoundarySettled: async () => {},
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
      executeRoot: (input) =>
        executeHostedExecutionToSettlement(requireCoordinator(coordinator), input),
      stopRoot: (identity, input) => requireCoordinator(coordinator).stopRoot(identity, input),
      stopSession: (sessionId, input) =>
        requireCoordinator(coordinator).stopSession(sessionId, input),
    };
    const backends = new BackendRegistry();
    const linkedBackends = new Map<string, LinkedChildAuthorityBackend>();
    backends.register('ai-sdk', (context) => {
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
      safeBoundaryResumeEnabled: true,
      inspectContinuationSafety: async () => ({
        workspaceIdentity: 'workspace-linked-root-authority',
        backgroundOperationsSettled: true,
        availableToolNames: ['Read', 'Glob', 'Grep'],
      }),
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
      undefined,
      () => NO_EXECUTION_OBSERVER,
    );
    const interactiveTurns = new HostInteractiveTurnCoordinator({
      executions: coordinator,
      turns: stores.agentRunStore,
      runtime: manager,
    });

    const parentSink = new RecordingContinuitySink();
    const parentConnectionId = 'connection-waiting-parent';
    const parentConnection = continuity.attachConnection(parentConnectionId, parentSink);
    const parentOpened = await continuity.handlers['subscription.open'](
      { sessionId: parent.id, transcript: { kind: 'none' } },
      operationContext(hostEpoch, acquireResidency, parentConnectionId),
    );
    assert.equal(parentOpened.ok, true);
    if (!parentOpened.ok) return;
    parentConnection.activate(parentOpened.result.subscriptionId);

    const parentTurnId = randomUUID();
    const parentStarted = await interactiveTurns.handlers['turn.start'](
      {
        sessionId: parent.id,
        turnId: parentTurnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      },
      operationContext('epoch-linked-root', acquireResidency),
    );
    assert.equal(parentStarted.ok, true);
    if (!parentStarted.ok) return;
    assertStartedTurn(parentStarted);
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
        parentRunId: parentStarted.result.turn.runId,
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
          { sessionId: ready.childSessionId, transcript: { kind: 'none' } },
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
      permissionMode: child.permissionMode,
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
    const externalJoin = await interactiveTurns.handlers['turn.start'](
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
        parentRunId: parentStarted.result.turn.runId,
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
    assert.deepEqual(coordinator.readRootState(stoppedReady.childSessionId), {
      kind: 'idle',
    });
    assert.equal(interactions.isPoisoned(), false);
    assert.equal(drainRequested, false);

    const externalTurnId = randomUUID();
    const external = await interactiveTurns.handlers['turn.start'](
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
    const queuedBackend = linkedBackends.get(child.childSessionId);
    assert.ok(queuedBackend);
    if (!queuedBackend) return;
    queuedBackend.release();
    await queuedBackend.questionStarted.promise;
    const followupState = coordinator.readRootState(child.childSessionId);
    assert.equal(followupState.kind, 'active');
    if (followupState.kind !== 'active') return;

    const abortController = new AbortController();
    let joinedInitial: Promise<typeof child> | undefined;
    const interrupted = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentStarted.result.turn.runId,
        parentTurnId,
        toolCallId: 'linked-interrupt',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: FAKE_ASK_USER_QUESTION_PROMPT,
      abortSignal: abortController.signal,
      onReady: () => {
        joinedInitial = manager.spawnChildSession(parent.id, {
          spawnedBy: {
            parentRunId: parentStarted.result.turn.runId,
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
    assert.deepEqual(coordinator.readRootState(interrupted.childSessionId), {
      kind: 'idle',
    });
    assert.equal(drainRequested, false);

    const answered = await interactions.handlers['interaction.answer'](
      {
        sessionId: pendingQuestion.sessionId,
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
        frame.snapshot.rootTurn?.runId === parentStarted.result.turn.runId &&
        frame.snapshot.rootTurn.status === 'running' &&
        frame.snapshot.interactions.pending.length === 0,
      'resumed question projection',
    );

    await coordinator.stopRoot({
      sessionId: parent.id,
      turnId: parentTurnId,
      runId: parentStarted.result.turn.runId,
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
      backends.register('ai-sdk', async () => {
        backendFactoryEntered.resolve();
        await releaseBackendFactory.promise;
        throw new Error('injected backend startup failure');
      });
    },
  });

  try {
    const turnId = 'turn-pre-bind-failure';
    const starting = fixture.interactiveTurns.handlers['turn.start'](
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
    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), {
      kind: 'idle',
    });
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
      backends.register('ai-sdk', (context) => {
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
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assertStartedTurn(started);

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
      runId: started.result.turn.runId,
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
      backends.register('ai-sdk', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      });
    },
  });
  let closed = false;

  try {
    const firstTurnId = 'turn-close-first';
    const started = await fixture.interactiveTurns.handlers['turn.start'](
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
        content: {
          text: 'start successor while shutdown drains Interaction authority',
        },
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

    assert.deepEqual(fixture.coordinator.readRootState(fixture.sessionId), {
      kind: 'idle',
    });
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
    ...clientCapabilityCoordinatorTestAdmission(),
    activation: new RuntimePolicyActivationGate(),
    onModelToolsChanged: () => undefined,
  });
  const fixture = await createFailureFixture({
    clientCapabilities,
    registerBackend: (backends) => {
      backends.register('ai-sdk', (context) => new FakeBackend(context));
    },
  });
  const first = clientCapabilities.attachConnection(
    clientCapabilityConnectionIdentity('provider-a'),
    {
      send: async () => {},
    },
  );
  const second = clientCapabilities.attachConnection(
    clientCapabilityConnectionIdentity('provider-b'),
    {
      send: async () => {},
    },
  );

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
              hostPathAccess: 'cwd',
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
    const started = await fixture.interactiveTurns.handlers['turn.start'](
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
    await clientCapabilities.close();
    await fixture.dispose();
  }
});

test('an exact active retry preserves the Client Capability admission binding', {
  timeout: 20_000,
}, async () => {
  const clientCapabilities = new HostClientCapabilityCoordinator({
    ...clientCapabilityCoordinatorTestAdmission(),
    activation: new RuntimePolicyActivationGate(),
    onModelToolsChanged: () => undefined,
  });
  let backend: LinkedChildAuthorityBackend | undefined;
  const fixture = await createFailureFixture({
    clientCapabilities,
    registerBackend: (backends) => {
      backends.register('ai-sdk', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      });
    },
  });
  const first = clientCapabilities.attachConnection(
    clientCapabilityConnectionIdentity('provider-a'),
    {
      send: async () => {},
    },
  );
  const second = clientCapabilities.attachConnection(
    clientCapabilityConnectionIdentity('provider-b'),
    {
      send: async () => {},
    },
  );

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
              hostPathAccess: 'cwd',
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
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      input,
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-a'),
    );
    assert.equal(started.ok, true);
    assertStartedTurn(started);
    const retried = await fixture.interactiveTurns.handlers['turn.start'](
      input,
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-b'),
    );
    assert.equal(retried.ok, true);

    const snapshot = clientCapabilities.snapshotForSession(fixture.sessionId);
    assert.deepEqual(snapshot?.registrationIds, ['registration-a']);
    snapshot?.release();

    await fixture.coordinator.stopRoot({
      sessionId: fixture.sessionId,
      turnId: input.turnId,
      runId: started.result.turn.runId,
    });
  } finally {
    backend?.release();
    first.close();
    second.close();
    await clientCapabilities.close();
    await fixture.dispose();
  }
});

test('mixed-Client queued follow-ups use separate Session successors without connection-local tools', {
  timeout: 20_000,
}, async () => {
  const clientCapabilities = new HostClientCapabilityCoordinator({
    ...clientCapabilityCoordinatorTestAdmission(),
    activation: new RuntimePolicyActivationGate(),
    onModelToolsChanged: () => undefined,
  });
  let backend: LinkedChildAuthorityBackend | undefined;
  const fixture = await createFailureFixture({
    clientCapabilities,
    registerBackend: (backends) => {
      backends.register('ai-sdk', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      });
    },
  });
  const first = clientCapabilities.attachConnection(
    clientCapabilityConnectionIdentity('provider-a'),
    {
      send: async () => {},
    },
  );
  const second = clientCapabilities.attachConnection(
    clientCapabilityConnectionIdentity('provider-b'),
    {
      send: async () => {},
    },
  );

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
              hostPathAccess: 'cwd',
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
    const started = await fixture.interactiveTurns.handlers['turn.start'](
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
    const followupSnapshot = clientCapabilities.snapshotForSession(fixture.sessionId);
    assert.equal(followupSnapshot, undefined);

    await waitUntil(() => backend?.sendCount === 2);
    backend?.release();
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
    assert.deepEqual(
      (await fixture.stores.sessionStore.readMessages(fixture.sessionId))
        .filter((message) => message.type === 'user' && message.id.startsWith('followup-from-'))
        .map((message) => message.id),
      ['followup-from-provider-b', 'followup-from-provider-a'],
    );
  } finally {
    first.close();
    second.close();
    await clientCapabilities.close();
    await fixture.dispose();
  }
});

test('queued follow-up does not bind lost or ambiguous connection-local tools', {
  timeout: 20_000,
}, async () => {
  await assertSessionSuccessorCapabilityDegradation('call');
  await assertSessionSuccessorCapabilityDegradation('turn');
});

async function assertSessionSuccessorCapabilityDegradation(
  affinity: 'call' | 'turn',
): Promise<void> {
  const clientCapabilities = new HostClientCapabilityCoordinator({
    ...clientCapabilityCoordinatorTestAdmission(),
    activation: new RuntimePolicyActivationGate(),
    onModelToolsChanged: () => undefined,
  });
  let backend: LinkedChildAuthorityBackend | undefined;
  const fixture = await createFailureFixture({
    clientCapabilities,
    registerBackend: (backends) => {
      backends.register('ai-sdk', (context) => {
        backend = new LinkedChildAuthorityBackend(context.sessionId);
        return backend;
      });
    },
  });
  const sessionProvider = clientCapabilities.attachConnection(
    clientCapabilityConnectionIdentity('provider-session'),
    {
      send: async () => {},
    },
  );
  const calls: string[] = [];
  let previousProvider!: ReturnType<HostClientCapabilityCoordinator['attachConnection']>;
  previousProvider = clientCapabilities.attachConnection(
    clientCapabilityConnectionIdentity('provider-previous'),
    {
      send: async (frame) => {
        if (frame.kind !== 'client.capability.call') return;
        calls.push('provider-previous');
        previousProvider.accept({
          kind: 'client.capability.accepted',
          invocationId: frame.invocationId,
          admissionEvidence: { kind: 'none' },
        });
        previousProvider.accept({
          kind: 'client.capability.result',
          invocationId: frame.invocationId,
          result: { content: [{ type: 'text', text: 'previous' }] },
        });
      },
    },
  );
  let followupProvider!: ReturnType<HostClientCapabilityCoordinator['attachConnection']>;
  followupProvider = clientCapabilities.attachConnection(
    clientCapabilityConnectionIdentity('provider-followup'),
    {
      send: async (frame) => {
        if (frame.kind !== 'client.capability.call') return;
        calls.push('provider-followup');
        followupProvider.accept({
          kind: 'client.capability.accepted',
          invocationId: frame.invocationId,
          admissionEvidence: { kind: 'none' },
        });
        followupProvider.accept({
          kind: 'client.capability.result',
          invocationId: frame.invocationId,
          result: { content: [{ type: 'text', text: 'followup' }] },
        });
      },
    },
  );

  try {
    const sessionReplaced = await clientCapabilities.handlers['client.capability.replace'](
      {
        registrationId: 'registration-session',
        offers: [
          {
            offerId: 'session-browser',
            version: '0',
            affinity: 'session',
            hostPathAccess: 'cwd',
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
              hostPathAccess: 'cwd',
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
    const started = await fixture.interactiveTurns.handlers['turn.start'](
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
    if (affinity === 'turn') {
      assert.equal(snapshot, undefined);
    } else {
      assert.ok(snapshot);
      const ephemeral = snapshot.tools.find((tool) => tool.name.endsWith('navigate_ephemeral'));
      assert.ok(ephemeral);
      await assert.rejects(
        () =>
          Promise.resolve(
            ephemeral.impl(
              {},
              {
                sessionId: fixture.sessionId,
                turnId: 'followup-turn',
                cwd: '/tmp',
                toolCallId: `followup-${affinity}`,
                abortSignal: new AbortController().signal,
                emitOutput: () => undefined,
              },
            ),
          ),
        (error: unknown) =>
          error instanceof ClientCapabilityInvocationError && error.code === 'capability_ambiguous',
      );
      snapshot.release();
    }
    assert.deepEqual(calls, []);

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
    await clientCapabilities.close();
    await fixture.dispose();
  }
}

test('an exact terminal retry does not require a live Client Capability binding', {
  timeout: 20_000,
}, async () => {
  const clientCapabilities = new HostClientCapabilityCoordinator({
    ...clientCapabilityCoordinatorTestAdmission(),
    activation: new RuntimePolicyActivationGate(),
    onModelToolsChanged: () => undefined,
  });
  const fixture = await createFailureFixture({
    clientCapabilities,
    registerBackend: (backends) => {
      backends.register('ai-sdk', (context) => new FakeBackend(context));
    },
  });
  const provider = clientCapabilities.attachConnection(
    clientCapabilityConnectionIdentity('provider-a'),
    {
      send: async () => {},
    },
  );

  try {
    const replaced = await clientCapabilities.handlers['client.capability.replace'](
      {
        registrationId: 'registration-a',
        offers: [
          {
            offerId: 'opaque',
            version: '0',
            affinity: 'session',
            hostPathAccess: 'cwd',
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
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      input,
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'provider-a'),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assertStartedTurn(started);
    let terminal = started.result.turn;
    for (
      let attempt = 0;
      attempt < 200 &&
      terminal.status !== 'completed' &&
      terminal.status !== 'failed' &&
      terminal.status !== 'cancelled';
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const queried = await fixture.turnControl.handlers['turn.query'](
        { sessionId: input.sessionId, turnId: input.turnId },
        operationContext(fixture.hostEpoch, fixture.acquireResidency, 'observer'),
      );
      assert.equal(queried.ok, true);
      if (!queried.ok) return;
      terminal = queried.result;
    }
    assert.equal(terminal.status, 'completed');

    provider.close();
    const retried = await fixture.interactiveTurns.handlers['turn.start'](
      input,
      operationContext(fixture.hostEpoch, fixture.acquireResidency, 'observer'),
    );
    assert.deepEqual(retried, {
      ok: true,
      result: {
        kind: 'started',
        turn: terminal,
        skillInvocation: { loaded: [], failed: [], receipts: [] },
      },
    });
  } finally {
    provider.close();
    await clientCapabilities.close();
    await fixture.dispose();
  }
});

test('turn.start returns a published fast terminal before backend iterator cleanup', {
  timeout: 20_000,
}, async () => {
  let backend: TerminalThenCleanupBackend | undefined;
  const fixture = await createFailureFixture({
    registerBackend: (backends) => {
      backends.register('ai-sdk', (context) => {
        backend = new TerminalThenCleanupBackend(context.sessionId);
        return backend;
      });
    },
  });

  try {
    const started = await completesWithin(
      fixture.interactiveTurns.handlers['turn.start'](
        {
          sessionId: fixture.sessionId,
          turnId: 'turn-fast-terminal',
          content: { text: 'finish immediately' },
        },
        operationContext(fixture.hostEpoch, fixture.acquireResidency),
      ),
      2_000,
      'fast terminal start acknowledgement',
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assertStartedTurn(started);
    assert.equal(started.result.turn.status, 'completed');
    assert.ok(backend);
    assert.equal(backend.cleanupReleased, false);

    const followup = fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId: 'turn-after-fast-terminal',
        content: { text: 'wait for prior cleanup' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    let followupSettled = false;
    void followup.finally(() => {
      followupSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(followupSettled, false);

    backend.releaseCleanup();
    const followupResult = await completesWithin(followup, 2_000, 'follow-up after cleanup');
    assert.equal(followupResult.ok, true);
  } finally {
    backend?.releaseCleanup();
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
      backends.register('ai-sdk', (context) => {
        backend = new QueuedAdmissionBackend(context.sessionId);
        return backend;
      });
    },
  });

  try {
    const turnId = 'turn-public-stop-admission-race';
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'queue admission behind public stop' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assertStartedTurn(started);
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
    const stopping = fixture.turnControl.handlers['turn.stop'](
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.result.turn.runId,
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
      backends.register('ai-sdk', (context) => {
        backend = new StopReleasedAdmissionBackend(context.sessionId);
        return backend;
      });
    },
  });

  try {
    const turnId = 'turn-public-interrupt-stop-released-admission';
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'admit a question only after stop arrives' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assertStartedTurn(started);
    assert.ok(backend);
    await backend.ready.promise;

    const interrupted = await fixture.messages.handlers['turn.interrupt'](
      {
        originHostEpoch: fixture.hostEpoch,
        interruptId: 'interrupt-stop-released-admission',
        sessionId: fixture.sessionId,
        turnId,
        runId: started.result.turn.runId,
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
      backends.register('ai-sdk', async (context) => {
        backendFactoryEntered.resolve();
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            backendFactoryAborted = true;
            reject(context.abortSignal?.reason ?? new Error('backend factory aborted'));
          };
          if (context.abortSignal?.aborted) abort();
          else
            context.abortSignal?.addEventListener('abort', abort, {
              once: true,
            });
        });
      });
    },
  });

  try {
    const turnId = 'turn-public-interrupt-start-race';
    const starting = fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    await backendFactoryEntered.promise;
    const queried = await fixture.turnControl.handlers['turn.query'](
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
    if (startOutcome.ok) {
      assert.equal(startOutcome.result.kind, 'started');
      if (startOutcome.result.kind === 'started') {
        assert.equal(startOutcome.result.turn.status, 'cancelled');
      }
    }
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
      backends.register('ai-sdk', (context) => {
        backend = new RunningAdmissionBackend(context.sessionId);
        return backend;
      });
    },
  });

  try {
    const turnId = 'turn-running-admission-stop-race';
    const started = await fixture.interactiveTurns.handlers['turn.start'](
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
      backends.register('ai-sdk', (context) => {
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
      llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const unrelatedTurnId = 'turn-unrelated-active-root';
    const unrelatedStarted = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: unrelatedSession.id,
        turnId: unrelatedTurnId,
        content: { text: HOLD_EXTERNAL_PROMPT },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(unrelatedStarted.ok, true);
    if (!unrelatedStarted.ok) return;
    assertStartedTurn(unrelatedStarted);
    assert.ok(unrelatedBackend);

    const turnId = 'turn-admission-before-backend-failure';
    const starting = fixture.interactiveTurns.handlers['turn.start'](
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
    assertStartedTurn(started);

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
      runId: unrelatedStarted.result.turn.runId,
    });
    assert.equal(unrelatedBackend.stopCount, 0);
    const run = await fixture.stores.agentRunStore.readRun(
      fixture.sessionId,
      started.result.turn.runId,
    );
    const events = await fixture.stores.runtimeEventStore.readImmutableRuntimeEvents(
      fixture.sessionId,
      started.result.turn.runId,
    );
    const terminal = classifyTerminalRuntimeLedger(run, events);
    assert.equal(terminal.kind, 'fact');
    if (terminal.kind === 'fact') assert.equal(terminal.fact.runStatus, 'failed');

    await fixture.coordinator.stopRoot({
      sessionId: unrelatedSession.id,
      turnId: unrelatedTurnId,
      runId: unrelatedStarted.result.turn.runId,
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
      backends.register('ai-sdk', (context) => {
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
    const queried = await fixture.turnControl.handlers['turn.query'](
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
      backends.register('ai-sdk', (context) => {
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
      backends.register('ai-sdk', (context) => {
        backend = new AdmissionThenFailureBackend(context.sessionId, aggregateFailure);
        return backend;
      });
    },
  });

  try {
    const turnId = 'turn-aggregate-cleanup-failure';
    const starting = fixture.interactiveTurns.handlers['turn.start'](
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
    assertStartedTurn(started);

    backend!.releaseFailure();
    await waitUntil(() => fixture.coordinator.readRootState(fixture.sessionId).kind === 'idle');
    assert.equal(fixture.drainRequested(), false);

    const run = await fixture.stores.agentRunStore.readRun(
      fixture.sessionId,
      started.result.turn.runId,
    );
    const events = await fixture.stores.runtimeEventStore.readImmutableRuntimeEvents(
      fixture.sessionId,
      started.result.turn.runId,
    );
    const terminal = classifyTerminalRuntimeLedger(run, events);
    assert.equal(terminal.kind, 'fact');
    if (terminal.kind === 'fact') assert.equal(terminal.fact.runStatus, 'failed');
    const queried = await fixture.turnControl.handlers['turn.query'](
      { sessionId: fixture.sessionId, turnId },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(queried.ok, true);
    if (queried.ok && queried.result.status === 'failed') {
      assert.equal(queried.result.failureMessage, run.failureMessage);
      assert.ok(queried.result.failureMessage);
    }

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
      backends.register('ai-sdk', (context) => {
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
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'surface rate limit with owner cleanup failure' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assertStartedTurn(started);

    await waitUntil(() => fixture.drainRequested());
    await waitUntil(() => fixture.coordinator.readRootState(fixture.sessionId).kind === 'idle');
    const run = await fixture.stores.agentRunStore.readRun(
      fixture.sessionId,
      started.result.turn.runId,
    );
    const events = await fixture.stores.runtimeEventStore.readImmutableRuntimeEvents(
      fixture.sessionId,
      started.result.turn.runId,
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
      backends.register('ai-sdk', (context) => {
        backend = new PendingQuestionBackend(context.sessionId);
        return backend;
      });
    },
  });

  try {
    const turnId = 'turn-public-stop-answer-race';
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'answer after the public stop fence' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assertStartedTurn(started);
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
    const stopping = fixture.turnControl.handlers['turn.stop'](
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.result.turn.runId,
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    await stopQueued;
    const answered = fixture.interactions.handlers['interaction.answer'](
      {
        sessionId: fixture.sessionId,
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
      backends.register('ai-sdk', (context) => {
        backend = new TakeoverClosureBackend(context.sessionId);
        return backend;
      });
    },
  });
  let releaseLane: ReturnType<typeof deferred<void>> | undefined;

  try {
    const turnId = 'turn-public-stop-closure-takeover';
    const started = await fixture.interactiveTurns.handlers['turn.start'](
      {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: 'take over the queued closure execution' },
      },
      operationContext(fixture.hostEpoch, fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assertStartedTurn(started);
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
    const publicStop = fixture.turnControl.handlers['turn.stop'](
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.result.turn.runId,
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
  const execution = executeHostedExecutionToSettlement(fixture.coordinator, {
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

type FailureFixture = Awaited<ReturnType<typeof createFailureFixture>>;

function graphExecutions(fixture: FailureFixture): HostAgentGraphExecutionCoordinator {
  return new HostAgentGraphExecutionCoordinator({
    executions: fixture.coordinator,
    runtime: fixture.manager,
    newId: randomUUID,
  });
}

async function seedPendingSafeBoundaryContinuation(
  fixture: FailureFixture,
  workspaceIdentity: string,
  identitySuffix: string,
  sourceOrchestrationMode?: 'graph' | 'swarm',
): Promise<{
  sourceRunId: string;
  sourceRuntimeEventHighWater: number;
  targetRunId: string;
  targetTurnId: string;
}> {
  const sourceRunId = `source-run-${identitySuffix}`;
  const sourceTurnId = `source-turn-${identitySuffix}`;
  const sourceInvocationId = `source-invocation-${identitySuffix}`;
  const targetTurnId = `target-turn-${identitySuffix}`;
  const session = await fixture.stores.sessionStore.readHeaderSnapshot(fixture.sessionId);
  const createdAt = Date.now();
  const sourceRun = {
    runId: sourceRunId,
    invocationId: sourceInvocationId,
    sessionId: fixture.sessionId,
    turnId: sourceTurnId,
    status: 'created' as const,
    backendKind: 'fake' as const,
    llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: session.cwd,
    workspaceIdentity,
    permissionMode: session.permissionMode,
    collaborationMode: session.collaborationMode,
    ...(sourceOrchestrationMode
      ? {
          orchestrationMode: sourceOrchestrationMode,
          orchestrationSource: 'session' as const,
          agentSwarmAuthorization:
            sourceOrchestrationMode === 'swarm' ? ('session_mode' as const) : ('none' as const),
        }
      : {}),
    createdAt,
    updatedAt: createdAt,
  };
  await fixture.stores.agentRunStore.createRun(sourceRun, { durable: true });
  await fixture.stores.runtimeEventStore.appendRuntimeEvent(fixture.sessionId, sourceRunId, {
    id: `source-user-${identitySuffix}`,
    sessionId: fixture.sessionId,
    invocationId: sourceInvocationId,
    runId: sourceRunId,
    turnId: sourceTurnId,
    ts: createdAt,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'Continue after Host restart.' },
  });
  const terminalAt = createdAt + 1;
  await commitTerminalRunWithRuntimeFact({
    runStore: fixture.stores.agentRunStore,
    runtimeEventStore: fixture.stores.runtimeEventStore,
    newId: randomUUID,
    sessionId: fixture.sessionId,
    runId: sourceRunId,
    turnId: sourceTurnId,
    status: 'failed',
    ts: terminalAt,
    terminalEvent: buildRecoveredTerminalRuntimeEvent({
      id: `source-terminal-${identitySuffix}`,
      run: sourceRun,
      status: 'failed',
      ts: terminalAt,
      failureClass: 'app_restarted',
      recoveryReason: 'test_safe_boundary_recovery',
    }),
    failureClass: 'app_restarted',
  });
  const plan = await fixture.manager.planAuthoritativeSafeBoundaryContinuation(fixture.sessionId, {
    sourceRunId,
  });
  assert.equal(plan.disposition, 'continue', JSON.stringify(plan));
  const continuation = plan.continuation;
  if (!continuation?.claimId || !continuation.boundary || !continuation.providerReplayDigest) {
    throw new Error('Unable to plan the safe-boundary continuation fixture');
  }
  const admission = await fixture.stores.agentRunStore.admitRootTurn({
    sessionId: fixture.sessionId,
    turnId: targetTurnId,
    proposedRunId: continuation.runId,
    proposedUserMessageId: null,
    execution: {
      kind: 'safe_boundary_continuation',
      sourceInvocationId,
      sourceRunId,
      sourceTurnId,
      sourceRuntimeEventHighWater: continuation.sourceRuntimeEventHighWater,
      claimId: continuation.claimId,
      boundaryDigest: continuation.boundary.manifestDigest,
      providerReplayDigest: continuation.providerReplayDigest,
      safetyDigest: continuationSafetyDigest(continuation),
      targetInvocationId: continuation.invocationId,
    },
    previousRootTurnId: null,
    normalizedInput: null,
    sourceMessages: [],
    admittedAt: Date.now(),
  });
  assert.equal(admission.kind, 'admitted');
  return {
    sourceRunId,
    sourceRuntimeEventHighWater: continuation.sourceRuntimeEventHighWater,
    targetRunId: continuation.runId,
    targetTurnId,
  };
}

async function registerSessionCapability(
  fixture: FailureFixture,
  capabilities: HostClientCapabilityCoordinator,
  connectionId: string,
  registrationId: string,
  toolNames: readonly string[],
): Promise<void> {
  const replaced = await capabilities.handlers['client.capability.replace'](
    {
      registrationId,
      offers: [
        {
          offerId: 'resume_fixture',
          version: '0',
          affinity: 'session',
          hostPathAccess: 'cwd',
          label: 'Resume fixture',
          tools: toolNames.map((name) => ({
            serverId: 'resume_fixture',
            name,
            inputSchema: { type: 'object', additionalProperties: false },
          })),
        },
      ],
    },
    operationContext(fixture.hostEpoch, fixture.acquireResidency, connectionId),
  );
  assert.equal(replaced.ok, true);
}

async function createFailureFixture(options: {
  registerBackend(backends: BackendRegistry): void;
  directoryHostId?: string;
  corruptSessionRole?: boolean;
  legacyConnectionIdentity?: boolean;
  childTools?: MakaTool[];
  wrapAdmissionStore?(store: RootTurnAdmissionStore): RootTurnAdmissionStore;
  wrapMessageAuthority?(authority: RuntimeMessageAuthority): RuntimeMessageAuthority;
  withInteractions?: boolean;
  withArtifacts?: boolean;
  beforeInteractionPreflight?(): Promise<void>;
  clientCapabilities?: HostClientCapabilityCoordinator;
  continuationSafety?: {
    workspaceIdentity: string;
    availableToolNames: readonly string[] | ((sessionId: string) => readonly string[]);
  };
  agentGraphEpochs?: {
    currentGraphId(rootSessionId: string): Promise<string>;
    beginNextGraphEpoch(rootSessionId: string): Promise<string>;
  };
  prepareSkillInvocation?(input: {
    sessionId: string;
    turnId: string;
    text: string;
    skillIds: readonly string[];
  }): Promise<PreparedSkillInvocationMessage>;
  assertScheduledTaskRecoveryAdmission?(
    admission: RootTurnAdmission,
    state: 'pending_fire_required' | 'run_recorded',
  ): Promise<void>;
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
  const artifacts = options.withArtifacts
    ? await openInteractiveArtifactStoreForWrite(owner.lease)
    : undefined;
  await artifacts?.recover();
  const session = await stores.sessionStore.create({
    cwd: capability.canonicalPath,
    ...(options.legacyConnectionIdentity
      ? {}
      : { llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
  });
  if (options.corruptSessionRole) {
    const database = new DatabaseSync(
      join(capability.canonicalPath, OPERATIONAL_STATE_DATABASE_NAME),
    );
    try {
      database
        .prepare(
          `UPDATE session_metadata
           SET payload_json = json_set(payload_json, '$.role', ?)
           WHERE session_id = ?`,
        )
        .run(WORKHUB_COORDINATION_SESSION_ROLE, session.id);
    } finally {
      database.close();
    }
  }
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
    startFromMessage: (input, admission, commitAdmission) =>
      requireCoordinator(coordinator).startFromMessage(input, admission, commitAdmission),
    prepareMessage: (input) => requireCoordinator(coordinator).prepareMessage(input),
    claimStop: (input, commitQueueFence, admission) =>
      requireCoordinator(coordinator).claimStop(input, commitQueueFence, admission),
  };
  const hostEpoch = 'epoch-message-failure';
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
    admissions: stores.sessionStore,
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
        sandboxBoundaries: stores.sessionStore,
        sessionAdmission,
        sessions: stores.sessionStore,
        preflightSessionSnapshot: async (sessionId, interactionProjection) => {
          await options.beforeInteractionPreflight?.();
          return canonicalProjectionReader.fitsCandidate(sessionId, {
            interactions: interactionProjection,
          });
        },
        refreshCanonicalContinuity: (sessionId, admission) =>
          requireContinuity(continuity).refreshCanonical(sessionId, admission),
        onPoison: requestDrain,
        onSandboxBoundarySettled: async () => {},
      })
    : undefined;
  const backends = new BackendRegistry();
  options.registerBackend(backends);
  const managerDeps = {
    store: stores.sessionStore,
    runStore: stores.agentRunStore,
    runtimeEventStore: stores.runtimeEventStore,
    backends,
    ...(options.childTools ? { childTools: options.childTools } : {}),
    newId: randomUUID,
    now: Date.now,
    messageAuthority: options.wrapMessageAuthority?.(messages) ?? messages,
    ...(options.continuationSafety
      ? {
          safeBoundaryResumeEnabled: true,
          inspectContinuationSafety: async (sessionId: string) => ({
            workspaceIdentity: options.continuationSafety!.workspaceIdentity,
            backgroundOperationsSettled: true,
            availableToolNames:
              typeof options.continuationSafety!.availableToolNames === 'function'
                ? options.continuationSafety!.availableToolNames(sessionId)
                : options.continuationSafety!.availableToolNames,
          }),
        }
      : {}),
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
  const artifactAuthority = artifacts
    ? new HostArtifactCoordinator(artifacts, requestDrain, sessionAdmission, stores.sessionStore)
    : undefined;
  const createCoordinator = (admissionOwner: RootAdmissionOwner) =>
    new RootTurnCoordinator(
      manager,
      stores,
      sessionAdmission,
      admissionOwner,
      interactions ?? {
        assertTerminalFence: async () => undefined,
        claimRunClosure: async () => undefined,
      },
      messages,
      requireContinuity(continuity),
      acquireResidency,
      requestDrain,
      options.clientCapabilities,
      () => NO_EXECUTION_OBSERVER,
      options.assertScheduledTaskRecoveryAdmission,
      artifactAuthority,
      options.prepareSkillInvocation,
      options.agentGraphEpochs,
      undefined,
      options.directoryHostId,
    );
  coordinator = createCoordinator(rootAdmissionOwner);
  const contextOperations = new HostContextCoordinator({
    runtime: manager,
    executions: coordinator,
    sessions: stores.sessionStore,
    requestDrain,
  });
  let turnControl = new HostTurnControlCoordinator({
    executions: coordinator,
    sessionAdmission,
  });
  let interactiveTurns = new HostInteractiveTurnCoordinator({
    executions: coordinator,
    turns: stores.agentRunStore,
    runtime: manager,
  });

  return {
    stores,
    sessionId: session.id,
    hostEpoch,
    messages,
    coordinator,
    contextOperations,
    get turnControl() {
      return turnControl;
    },
    get interactiveTurns() {
      return interactiveTurns;
    },
    currentContinuity: () => requireContinuity(continuity),
    manager,
    interactions,
    artifacts,
    sessionAdmission,
    acquireResidency,
    createRecoveryCoordinator: () => {
      const admissionOwner = new RootAdmissionOwner(stores.agentRunStore);
      const recoveryProjection = new CanonicalSessionProjectionReader({
        stores,
        rootAdmissions: admissionOwner,
        messages,
      });
      requireContinuity(continuity).close();
      canonicalProjection = recoveryProjection;
      continuity = new SessionContinuityCoordinator(
        hostEpoch,
        (sessionId) => recoveryProjection.read(sessionId),
        sessionAdmission,
        requestDrain,
      );
      coordinator = createCoordinator(admissionOwner);
      turnControl = new HostTurnControlCoordinator({
        executions: coordinator,
        sessionAdmission,
      });
      interactiveTurns = new HostInteractiveTurnCoordinator({
        executions: coordinator,
        turns: stores.agentRunStore,
        runtime: manager,
      });
      return coordinator;
    },
    liveResidencies: () => liveResidencies,
    drainRequested: () => drainRequested,
    dispose: async () => {
      requireContinuity(continuity).close();
      artifacts?.close();
      await stores.sessionStore.close?.();
      await owner.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('directory references enforce Host identity without reading the filesystem', async () => {
  const reference = { hostId: 'host-a', path: '/workspace/source' };
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register('ai-sdk', (context) => new FakeBackend(context)),
    directoryHostId: reference.hostId,
  });
  try {
    const context = operationContext(fixture.hostEpoch, fixture.acquireResidency);
    await assert.rejects(
      () =>
        fixture.messages.handlers['turn.message.submit'](
          {
            originHostEpoch: fixture.hostEpoch,
            sessionId: fixture.sessionId,
            messageId: 'foreign-directory',
            placement: 'next_turn',
            content: {
              text: 'inspect foreign directory',
              directoryReferences: [{ ...reference, hostId: 'host-b' }],
            },
          },
          context,
        ),
      RuntimeHostedRootUnavailableError,
    );
    assert.equal(fixture.messages.projection(fixture.sessionId).followup.length, 0);
    assert.equal(fixture.drainRequested(), false);

    const accepted = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: 'local-directory',
        placement: 'next_turn',
        content: { text: 'inspect local directory', directoryReferences: [reference] },
      },
      context,
    );
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    await fixture.coordinator.whenIdle(fixture.sessionId);
    const user = (await fixture.stores.sessionStore.readMessages(fixture.sessionId)).find(
      (message) => message.type === 'user' && message.id === 'local-directory',
    );
    assert.equal(user?.type, 'user');
    if (user?.type !== 'user') throw new Error('Expected directory user message');
    assert.equal(user.text, 'inspect local directory');
    assert.equal(user.displayText, undefined);
    assert.deepEqual(user.directoryReferences, [reference]);
    assert.equal(fixture.drainRequested(), false);
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('turn start and regeneration preserve one Host-bound directory reference', async () => {
  const reference = { hostId: 'host-a', path: '/workspace/source' };
  const sendInputs: BackendSendInput[] = [];
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register(
        'ai-sdk',
        (context) =>
          new (class extends FakeBackend {
            override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
              sendInputs.push(input);
              yield* super.send(input);
            }
          })(context),
      ),
    directoryHostId: reference.hostId,
  });
  try {
    const context = operationContext(fixture.hostEpoch, fixture.acquireResidency);
    assertStartedTurn(
      await fixture.interactiveTurns.handlers['turn.start'](
        {
          sessionId: fixture.sessionId,
          turnId: 'directory-start',
          content: { text: 'inspect', directoryReferences: [reference] },
        },
        context,
      ),
    );
    await fixture.coordinator.whenIdle(fixture.sessionId);
    const regenerated = await fixture.interactiveTurns.handlers['turn.regenerate'](
      {
        sessionId: fixture.sessionId,
        sourceTurnId: 'directory-start',
        turnId: 'directory-regenerated',
      },
      context,
    );
    assert.equal(regenerated.ok, true, JSON.stringify(regenerated));
    await fixture.coordinator.whenIdle(fixture.sessionId);

    assert.equal(sendInputs.length, 2);
    for (const input of sendInputs) {
      assert.equal(input.text, 'inspect');
      assert.deepEqual(input.directoryReferences, [reference]);
    }
    const regeneratedUser = (
      await fixture.stores.sessionStore.readMessages(fixture.sessionId)
    ).find((message) => message.type === 'user' && message.turnId === 'directory-regenerated');
    assert.equal(regeneratedUser?.type, 'user');
    if (regeneratedUser?.type !== 'user') throw new Error('Expected regenerated user message');
    assert.equal(regeneratedUser.text, 'inspect');
    assert.deepEqual(regeneratedUser.directoryReferences, [reference]);
  } finally {
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

test('queued directory references survive text editing and next-Turn delivery', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const reference = { hostId: 'host-a', path: '/workspace/source' };
  const fixture = await createFailureFixture({
    registerBackend: (backends) =>
      backends.register(
        'ai-sdk',
        (context) =>
          new (class extends FakeBackend {
            override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
              if (input.text === 'hold-directory-test') {
                entered.resolve();
                await release.promise;
              }
              yield* super.send(input);
            }
          })(context),
      ),
    directoryHostId: reference.hostId,
  });
  try {
    const context = operationContext(fixture.hostEpoch, fixture.acquireResidency);
    assertStartedTurn(
      await fixture.interactiveTurns.handlers['turn.start'](
        {
          sessionId: fixture.sessionId,
          turnId: 'held-directory-root',
          content: { text: 'hold-directory-test' },
        },
        context,
      ),
    );
    await entered.promise;
    const submitted = await fixture.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        messageId: 'queued-directory',
        content: { text: 'inspect queued', directoryReferences: [reference] },
        placement: 'next_turn',
      },
      context,
    );
    assert.equal(submitted.ok && submitted.result.disposition, 'followup');
    const queue = fixture.messages.projection(fixture.sessionId);
    const entry = queue.followup[0]!;
    assert.deepEqual(entry.content.directoryReferences, [reference]);

    const edited = await fixture.messages.handlers['queue.entry.update'](
      {
        originHostEpoch: fixture.hostEpoch,
        sessionId: fixture.sessionId,
        entryId: entry.entryId,
        updateId: 'edit-directory',
        expectedQueueRevision: queue.queueRevision,
        text: 'edited inspection',
      },
      context,
    );
    assert.equal(edited.ok, true, JSON.stringify(edited));
    release.resolve();
    await fixture.coordinator.whenIdle(fixture.sessionId);
    await waitUntil(async () =>
      (await fixture.stores.sessionStore.readMessages(fixture.sessionId)).some(
        (message) => message.type === 'user' && message.text === 'edited inspection',
      ),
    );
    const user = (await fixture.stores.sessionStore.readMessages(fixture.sessionId)).find(
      (message) => message.type === 'user' && message.text === 'edited inspection',
    );
    assert.equal(user?.type, 'user');
    if (user?.type !== 'user') throw new Error('Expected queued directory user message');
    assert.deepEqual(user.directoryReferences, [reference]);
  } finally {
    release.resolve();
    await fixture.coordinator.close();
    await fixture.messages.close();
    await fixture.dispose();
  }
});

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
    principal: 'local_os_user' as const,
    principalKind: 'local_owner' as const,
    acquireResidency,
  };
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

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  await waitFor(predicate, {
    timeoutMs,
    pollMs: 5,
    message: 'Timed out waiting for test condition',
  });
}

class LinkedChildAuthorityBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly externalHoldStarted = deferred<void>();
  readonly questionStarted = deferred<void>();
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
      this.questionStarted.resolve();
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

class StepCapProbeBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sendInputs: BackendSendInput[] = [];
  providerSteps = 0;

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendInputs.push(input);
    const stepLimit = input.maxSteps ?? 3;
    for (let step = 1; step <= stepLimit; step += 1) {
      this.providerSteps += 1;
      const toolUseId = `tool-${step}`;
      yield {
        type: 'tool_start',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        toolUseId,
        toolName: 'Read',
        args: { path: `notes-${step}.md` },
      };
      yield {
        type: 'tool_result',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        toolUseId,
        isError: false,
        content: { kind: 'text', text: 'ok' },
      };
    }
    yield {
      type: 'complete',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'step_limit',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class BlockingRootBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly started = deferred<void>();
  readonly #released = deferred<void>();
  stopCount = 0;

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.started.resolve();
    await this.#released.promise;
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
    this.release();
  }

  release(): void {
    this.#released.resolve();
  }

  async respondToSandboxBoundary(): Promise<void> {}

  async dispose(): Promise<void> {
    this.release();
  }
}

class ContextFailureBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (input.text === 'provider context overflow') {
      yield {
        type: 'error',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        recoverable: false,
        reason: 'context_overflow',
        message: 'Context window exceeded',
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
      type: 'complete',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'context_budget_exhausted',
      contextBudgetExhaustedDetail: 'head_anchor_exceeds_capacity',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class BlockingContextRecoveryBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly compactStarted = deferred<void>();
  readonly #compactReleased = deferred<void>();
  compactInput: BackendCompactHistoryInput | undefined;
  stopCount = 0;

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'complete',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'end_turn',
    };
  }

  async compactHistory(input: BackendCompactHistoryInput) {
    this.compactInput = input;
    this.compactStarted.resolve();
    await this.#compactReleased.promise;
    return { outcome: { kind: 'unchanged' as const, reason: 'test' } };
  }

  releaseCompact(): void {
    this.#compactReleased.resolve();
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.releaseCompact();
  }
  async respondToSandboxBoundary(): Promise<void> {}
  async dispose(): Promise<void> {
    this.releaseCompact();
  }
}

class GraphFollowupRecoveryBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly graphTurnStarted = deferred<void>();
  readonly followupStarted = deferred<void>();
  readonly compactStarted = deferred<void>();
  readonly #graphTurnReleased = deferred<void>();
  readonly #followupReleased = deferred<void>();
  readonly #compactReleased = deferred<void>();
  compactStartedCount = 0;

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (input.text === HOLD_CONTEXT_RECOVERY_FOLLOWUP_PROMPT) {
      this.followupStarted.resolve();
      await this.#followupReleased.promise;
      yield {
        type: 'complete',
        id: randomUUID(),
        turnId: input.turnId,
        ts: Date.now(),
        stopReason: 'end_turn',
      };
      return;
    }

    this.graphTurnStarted.resolve();
    await this.#graphTurnReleased.promise;
    yield {
      type: 'error',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      recoverable: false,
      reason: 'context_overflow',
      message: 'Context window exceeded',
    };
    yield {
      type: 'complete',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'error',
    };
  }

  async compactHistory(_input: BackendCompactHistoryInput) {
    this.compactStartedCount += 1;
    this.compactStarted.resolve();
    await this.#compactReleased.promise;
    return { outcome: { kind: 'unchanged' as const, reason: 'test' } };
  }

  releaseGraphTurn(): void {
    this.#graphTurnReleased.resolve();
  }

  releaseFollowup(): void {
    this.#followupReleased.resolve();
  }

  releaseCompact(): void {
    this.#compactReleased.resolve();
  }

  async stop(): Promise<void> {
    this.releaseGraphTurn();
    this.releaseFollowup();
  }

  async respondToSandboxBoundary(): Promise<void> {}
  async dispose(): Promise<void> {
    this.releaseGraphTurn();
    this.releaseFollowup();
    this.releaseCompact();
  }
}

class QueuedAdmissionBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
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
  readonly kind = 'ai-sdk' as const;
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
  readonly kind = 'ai-sdk' as const;
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
  readonly kind = 'ai-sdk' as const;
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

class TerminalThenCleanupBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  cleanupReleased = false;
  private readonly cleanup = deferred<void>();

  constructor(readonly sessionId: string) {}

  releaseCleanup(): void {
    this.cleanupReleased = true;
    this.cleanup.resolve();
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'complete',
      id: randomUUID(),
      turnId: input.turnId,
      ts: Date.now(),
      stopReason: 'end_turn',
    };
    await this.cleanup.promise;
  }

  async stop(): Promise<void> {}

  async respondToSandboxBoundary(): Promise<void> {}

  async dispose(): Promise<void> {
    this.releaseCleanup();
  }
}

class PendingQuestionBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
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
  readonly kind = 'ai-sdk' as const;
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
  readonly kind = 'ai-sdk' as const;
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
