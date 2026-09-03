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

import { nextId } from '@maka/core/test-only/async-primitives';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as timerDelay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import {
  applySandboxBoundaryExpansion,
  createGenesisExecutionBoundary,
  isSandboxBoundaryRestartClosure,
} from '@maka/core/sandbox-boundary';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { DEEP_RESEARCH_SESSION_LABEL } from '@maka/core/deep-research';
import { RUNTIME_CONTINUATION_AUTHORITY_V1 } from '@maka/core/runtime-event-store';
import { deriveTurnRecords } from '@maka/core/session';
import { isSessionInlineRun } from '@maka/core/agent-run';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { buildImmutableRuntimePrefix, decodeContinuationClaim } from '@maka/core/runtime-boundary';
import type {
  CreateSandboxBoundaryRequest,
  SandboxBoundaryRequest,
  SandboxBoundaryResponse,
  SandboxBoundarySettlement,
  SettleSandboxBoundaryRequest,
} from '@maka/core/sandbox-boundary';
import type {
  CreateSessionInput,
  SessionListFilter,
  UserMessageInput,
} from '@maka/core/runtime-inputs';
import type { ExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { SessionEvent } from '@maka/core/events';
import type {
  AgentGraphIntentClaim,
  AgentGraphIntentClaimStore,
} from '@maka/core/agent-graph-control';
import type {
  AgentGraphOperatorProvisionRequest,
  AgentGraphOperatorProvisionResult,
} from '@maka/core/agent-graph-topology';
import type {
  AgentRunEvent,
  EmittedAgentRunEvent,
  AgentRunHeader,
  AgentRunStore,
  RootExecutionDescriptor,
} from '@maka/core/agent-run';
import type { ArtifactRecord } from '@maka/core/artifacts';
import type { ContinuationClaimV1, RuntimeBoundaryDigest } from '@maka/core/runtime-boundary';
import type {
  RuntimeContinuationAuthorityStore,
  RuntimeEventStore,
} from '@maka/core/runtime-event-store';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionHeader, SessionSummary, StoredMessage, TurnRecord } from '@maka/core/session';
import type {
  BackendCompactHistoryInput,
  BackendSendInput,
  BackendStopMode,
} from '@maka/core/backend-types';
import { PlanConflictError, emptyPlanSessionState, type PlanStore } from '@maka/core/plan';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { AiSdkBackend } from '../ai-sdk-backend.js';
import {
  BackendRegistry,
  SessionConfigurationRevisionConflictError,
  SessionConfigurationTransitionError,
  SessionManager,
  headerToSummary,
  type BackendFactoryContext,
  type SessionConfigurationStoreUpdate,
  type SessionStore,
  type VersionedSessionHeader,
} from '../session-manager.js';
import {
  RuntimeContextCompactError,
  RuntimeKernel,
  type RuntimeKernelLike,
} from '../runtime-kernel.js';
import { FAKE_ASK_USER_QUESTION_PROMPT, FakeBackend } from '../test-only/fake-backend.js';
import { RuntimeReadModel, RuntimeReadModelError } from '../runtime-read-model.js';
import type { AgentBackend } from '@maka/core/backend-types';
import type { MakaTool } from '../tool-runtime.js';
import type { ShellRunProcessManager } from '../shell-run-manager.js';
import type { RuntimeCommitSink } from '../runtime-commit-sink.js';
import {
  buildHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from '../history-compact-checkpoint.js';
import { buildLlmHistorySummarizer } from '../history-compact-summarizer.js';
import { decodeModelCallAttempt, type ModelCallAttempt } from '@maka/core/model-call-attempt';
import {
  AGENT_WORKSPACE_WORKTREE,
  IMPLEMENTATION_AGENT_DEFINITION,
  IMPLEMENTATION_AGENT_ID,
  LOCAL_READ_AGENT_DEFINITION,
  LOCAL_READ_AGENT_ID,
  LOCAL_READ_AGENT_PROFILE,
  WEB_RESEARCH_AGENT_ID,
} from '../agent-catalog.js';
import {
  RuntimeMessageAuthorityInvariantError,
  type RuntimeHostedRootAuthority,
  type RuntimeMessageRunIdentity,
} from '../message-authority.js';
import {
  RuntimeInteractionInvariantError,
  type CanonicalPermissionOutcomeReader,
  type CanonicalPermissionOutcomeRecord,
  type RuntimeInteractionAuthority,
  type RuntimeInteractionRunIdentity,
  type RuntimeUserQuestionContinuation,
} from '../interaction-authority.js';
import {
  claimAgentGraphRunnableIntent,
  fingerprintAgentGraphRunnableIntent,
} from '../stream-graph-admission.js';
import type { AgentGraphRunnableIntent } from '../stream-graph-readiness.js';

test('sendMessage rejects removed Automation as a live trigger', async () => {
  const runStore = new MemoryAgentRunStore();
  const manager = new SessionManager({
    store: new MemorySessionStore(),
    runStore,
    runtimeEventStore: runStore,
    backends: new BackendRegistry(),
    newId: nextId(),
    now: nextNow(1),
  });
  const session = await manager.createSession(makeInput());

  await assert.rejects(
    () =>
      drain(
        manager.sendMessage(session.id, {
          turnId: 'legacy-turn',
          text: 'automated prompt',
          origin: { kind: 'legacy_automation', automationId: 'automation-1' },
        } as UserMessageInput),
      ),
    /removed Automation authority/,
  );
});

test('sendMessage rejects removed child AgentRun lineage as a live trigger', async () => {
  for (const lineage of [
    { parentRunId: 'parent-run' },
    { resumedFromRunId: 'resumed-run' },
    { retriedFromRunId: 'retried-run' },
  ]) {
    const runStore = new MemoryAgentRunStore();
    const manager = new SessionManager({
      store: new MemorySessionStore(),
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(1),
    });
    const session = await manager.createSession(makeInput());

    await assert.rejects(
      () =>
        drain(
          manager.sendMessage(session.id, {
            turnId: 'legacy-child-turn',
            text: 'removed child AgentRun input',
            ...lineage,
          } as UserMessageInput),
        ),
      /removed child AgentRun lineage/,
    );
    assert.deepStrictEqual(await runStore.listSessionRuns(session.id), []);
  }
});

/**
 * "A turn is running" is a fact about the live process, so the read model takes
 * it from the run rather than from the persisted status. The status cannot
 * serve: it is written only at the END of `AgentRun.begin`, it reads the same
 * before a turn starts and after it ends, and a crash between a turn's end and
 * its status write leaves `running` in storage forever.
 */
test('listSessions preserves known-empty live run state', async () => {
  const store = new MemorySessionStore();
  let runningTurnIds: string[] = [];
  const manager = new SessionManager({
    store,
    backends: new BackendRegistry(),
    newId: nextId(),
    now: nextNow(1),
    runtimeKernel: {
      runningTurnIds: () => [...runningTurnIds],
    } as unknown as RuntimeKernelLike,
  });
  const session = await manager.createSession(makeInput());

  assert.deepEqual((await manager.listSessions())[0]?.runningTurnIds, []);

  runningTurnIds = ['turn-live'];
  assert.deepEqual((await manager.listSessions())[0]?.runningTurnIds, ['turn-live']);
  assert.equal((await store.readHeader(session.id)).status, 'active');
});

test('listChildSessions preserves known-empty live run state', async () => {
  const store = new MemorySessionStore();
  const runningTurnIdsBySession = new Map<string, string[]>();
  const manager = new SessionManager({
    store,
    backends: new BackendRegistry(),
    newId: nextId(),
    now: nextNow(1),
    runtimeKernel: {
      runningTurnIds: (sessionId: string) => [...(runningTurnIdsBySession.get(sessionId) ?? [])],
    } as unknown as RuntimeKernelLike,
  });
  const parent = await manager.createSession(makeInput({ name: 'Parent' }));
  const child = await manager.createSession(
    makeInput({
      name: 'Child',
      subagentParent: {
        kind: 'subagent',
        parentSessionId: parent.id,
        spawnedBy: {
          parentRunId: 'parent-run',
          parentTurnId: 'parent-turn',
          toolCallId: 'tool-call',
        },
        lifecycle: 'foreground',
      },
    }),
  );

  assert.deepEqual((await manager.listChildSessions(parent.id))[0]?.runningTurnIds, []);

  runningTurnIdsBySession.set(child.id, ['turn-live']);
  assert.deepEqual((await manager.listChildSessions(parent.id))[0]?.runningTurnIds, ['turn-live']);
});

describe('SessionManager Plan control boundaries', () => {
  test('an exact approval retry completes Session side effects after a partial failure', async () => {
    const store = new MemorySessionStore();
    const runtimeKernel = new DelegatingRuntimeKernel();
    const sessionId = 'session-1';
    let receipt: object | undefined;
    let committedApprovals = 0;
    const planStore = {
      readOperationReceipt: async () => receipt,
      approveProposal: async () => {
        if (!receipt) {
          committedApprovals += 1;
          receipt = { id: 'approve-operation', type: 'plan_approved' };
        }
        return {
          event: receipt,
          state: { ...emptyPlanSessionState(sessionId), storeVersion: 1 },
        };
      },
    } as unknown as PlanStore;
    const manager = new SessionManager({
      store,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(1),
      planStore,
      runtimeKernel,
    });
    await manager.createSession(makeInput({ collaborationMode: 'plan' }));
    const input = {
      sessionId,
      proposalId: 'proposal-1',
      expectedRevision: 1,
      expectedStoreVersion: 1,
      operationId: 'approve-operation',
    };

    store.failUpdateHeaderFor.add(sessionId);
    await assert.rejects(manager.approvePlan(input), /Cannot update header/);
    store.failUpdateHeaderFor.delete(sessionId);
    runtimeKernel.activeRuns = true;

    await manager.approvePlan(input);

    assert.strictEqual(committedApprovals, 1);
    assert.strictEqual((await store.readHeader(sessionId)).collaborationMode, 'agent');
    assert.deepStrictEqual(runtimeKernel.disposed, [sessionId]);
  });

  test('does not commit a same-mode Plan revision before backend disposal succeeds', async () => {
    const store = new MemorySessionStore();
    const runtimeKernel = new DelegatingRuntimeKernel();
    const sessionId = 'session-1';
    let receipt: object | undefined;
    let committedRevisions = 0;
    const manager = new SessionManager({
      store,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(1),
      runtimeKernel,
      planStore: {
        readOperationReceipt: async () => receipt,
        requestRevision: async () => {
          committedRevisions += 1;
          receipt = { id: 'revision-operation', type: 'plan_revision_requested' };
          return {
            event: receipt,
            state: { ...emptyPlanSessionState(sessionId), storeVersion: 1 },
          };
        },
      } as unknown as PlanStore,
    });
    await manager.createSession(makeInput({ collaborationMode: 'plan' }));

    runtimeKernel.failNextDispose = true;
    await assert.rejects(
      manager.requestPlanRevision(sessionId, 'proposal-1', 'revision-operation'),
      /backend disposal failed/,
    );
    assert.strictEqual(committedRevisions, 0);

    await manager.requestPlanRevision(sessionId, 'proposal-1', 'revision-operation');
    assert.strictEqual(committedRevisions, 1);
    assert.deepStrictEqual(runtimeKernel.disposed, [sessionId]);
  });

  test('does not commit Plan cancellation before backend disposal succeeds', async () => {
    const store = new MemorySessionStore();
    const runtimeKernel = new DelegatingRuntimeKernel();
    const sessionId = 'session-1';
    const planState = {
      ...emptyPlanSessionState(sessionId),
      storeVersion: 2,
      executions: [
        {
          executionId: 'execution-1',
          planId: 'plan-1',
          proposalId: 'proposal-1',
          sessionId,
          status: 'interrupted' as const,
          steps: [],
          startedAt: 1,
          updatedAt: 2,
          interruptedAt: 2,
          interruptionReason: 'Host restart',
        },
      ],
    };
    let receipt: object | undefined;
    let committedCancellations = 0;
    const manager = new SessionManager({
      store,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(1),
      runtimeKernel,
      planStore: {
        readState: async () => structuredClone(planState),
        readOperationReceipt: async () => receipt,
        cancelExecution: async () => {
          committedCancellations += 1;
          receipt = { id: 'cancel-operation', type: 'plan_execution_cancelled' };
          return { event: receipt, state: { ...planState, storeVersion: 3 } };
        },
      } as unknown as PlanStore,
    });
    await manager.createSession(makeInput());

    runtimeKernel.failNextDispose = true;
    await assert.rejects(
      manager.cancelPlanExecution(sessionId, 'execution-1', 'cancel-operation'),
      /backend disposal failed/,
    );
    assert.strictEqual(committedCancellations, 0);

    await manager.cancelPlanExecution(sessionId, 'execution-1', 'cancel-operation');
    assert.strictEqual(committedCancellations, 1);
    assert.deepStrictEqual(runtimeKernel.disposed, [sessionId]);
  });

  test('classifies an ineligible execution cancellation as a domain conflict', async () => {
    const store = new MemorySessionStore();
    const sessionId = 'session-1';
    const planState = {
      ...emptyPlanSessionState(sessionId),
      storeVersion: 2,
      activeExecutionId: 'execution-1',
      executions: [
        {
          executionId: 'execution-1',
          planId: 'plan-1',
          proposalId: 'proposal-1',
          sessionId,
          status: 'active' as const,
          steps: [],
          startedAt: 1,
          updatedAt: 1,
        },
      ],
    };
    const manager = new SessionManager({
      store,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(1),
      planStore: {
        readState: async () => structuredClone(planState),
        readOperationReceipt: async () => undefined,
      } as unknown as PlanStore,
    });
    await manager.createSession(makeInput());

    await assert.rejects(
      manager.cancelPlanExecution(sessionId, 'execution-1', 'cancel-operation'),
      (error: unknown) => {
        assert.ok(error instanceof PlanConflictError);
        assert.match(error.message, /interrupted/);
        return true;
      },
    );
  });

  test('rejects Plan mode for a linked child Session', async () => {
    const store = new VersionedConfigurationMemorySessionStore();
    const manager = new SessionManager({
      store,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(1),
      planStore: {
        readState: async (sessionId: string) => emptyPlanSessionState(sessionId),
      } as unknown as PlanStore,
    });
    const child = await manager.createSession(
      makeInput({
        subagentParent: {
          kind: 'subagent',
          parentSessionId: 'parent-session',
          spawnedBy: {
            parentRunId: 'parent-run',
            parentTurnId: 'parent-turn',
            toolCallId: 'tool-call',
          },
          lifecycle: 'foreground',
        },
      }),
    );

    await assert.rejects(
      manager.transitionSessionConfiguration(child.id, {
        expectedRevision: 1,
        clearConnectionBlock: false,
        configuration: {
          backend: child.backend,
          llmConnectionId: 'test-connection-id',
          llmConnectionSlug: child.llmConnectionSlug,
          connectionLocked: true,
          model: child.model,
          thinkingLevel: child.thinkingLevel,
          permissionMode: child.permissionMode,
          collaborationMode: 'plan',
          orchestrationMode: child.orchestrationMode ?? 'default',
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof SessionConfigurationTransitionError);
        assert.equal(error.code, 'operation_unavailable');
        return true;
      },
    );
    assert.equal((await store.readHeader(child.id)).collaborationMode, 'agent');
  });
});

describe('SessionManager graph operator provisioning', () => {
  test('provisions a graph operator before its active supervisor turn returns', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const parentGate = makeGate();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx, parentGate));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      subagentCatalog: {
        list: async () => [],
        resolve: async (id) => ({
          connectionId: '22222222-2222-4222-8222-222222222222',
          id,
          name: 'Fast graph reader',
          description: 'Cheap graph scans',
          profile: 'local_read',
          connectionSlug: 'worker-connection',
          model: 'worker-model',
          thinkingLevel: 'low',
          enabled: true,
        }),
      },
      newId: nextId(),
      now: nextNow(10),
    });
    const parent = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const parentTurn = manager
      .sendMessage(parent.id, { turnId: 'supervisor-turn', text: 'schedule graph work' })
      [Symbol.asyncIterator]();
    await parentTurn.next();
    const sourceRun = (await runStore.listSessionRuns(parent.id))[0];
    if (!sourceRun) throw new Error('Supervisor Run was not recorded');

    let provisionSettled = false;
    const provision = manager
      .provisionAgentGraphOperator({
        graphId: 'graph-active-supervisor',
        workId: `graph_work_${'8'.repeat(32)}`,
        subagentId: 'fast-reader',
        operatorId: `graph_operator_${'9'.repeat(32)}`,
        source: {
          sessionId: parent.id,
          runId: sourceRun.runId,
          turnId: sourceRun.turnId,
          toolCallId: 'schedule-tool',
        },
        edges: [],
        expectedScheduleRevision: 1,
      })
      .finally(() => {
        provisionSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(provisionSettled, true);
    const provisioned = await provision;
    assert.strictEqual(provisioned.created, true);
    assert.strictEqual(provisioned.header.name, 'Fast graph reader');
    assert.strictEqual(provisioned.header.llmConnectionSlug, 'worker-connection');
    assert.strictEqual(provisioned.header.model, 'worker-model');
    assert.strictEqual(provisioned.header.thinkingLevel, 'low');
    assert.strictEqual(provisioned.header.subagentRuntime?.presetId, 'fast-reader');
    assert.strictEqual(provisioned.provision.agentId, LOCAL_READ_AGENT_ID);

    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('serializes graph operator provisioning with parent permission narrowing', async () => {
    const store = new VersionedConfigurationMemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(20),
      shellRuns: {
        async terminateSession() {
          return undefined;
        },
        async commitSessionClose() {},
        rollbackSessionClose() {},
        resumeSession() {},
      } as never,
    });
    const parent = await manager.createSession(makeInput({ permissionMode: 'bypass' }));
    await runStore.createRun(
      makeRunHeader({
        sessionId: parent.id,
        runId: 'supervisor-run',
        turnId: 'supervisor-turn',
      }),
    );
    const provisionStarted = makeGate();
    const releaseProvision = makeGate();
    store.nextGraphOperatorProvisionGate = {
      started: provisionStarted,
      release: releaseProvision,
    };

    const provision = manager.provisionAgentGraphOperator({
      graphId: 'graph-config-fence',
      workId: `graph_work_${'a'.repeat(32)}`,
      agentId: LOCAL_READ_AGENT_ID,
      operatorId: `graph_operator_${'b'.repeat(32)}`,
      source: {
        sessionId: parent.id,
        runId: 'supervisor-run',
        turnId: 'supervisor-turn',
        toolCallId: 'schedule-tool',
      },
      edges: [],
      expectedScheduleRevision: 1,
    });
    await provisionStarted.promise;

    let transitionSettled = false;
    const transition = manager
      .transitionSessionConfiguration(parent.id, {
        expectedRevision: 1,
        clearConnectionBlock: false,
        configuration: {
          backend: parent.backend,
          llmConnectionId: 'test-connection-id',
          llmConnectionSlug: parent.llmConnectionSlug,
          connectionLocked: true,
          model: parent.model,
          thinkingLevel: parent.thinkingLevel,
          permissionMode: 'ask',
          collaborationMode: parent.collaborationMode ?? 'agent',
          orchestrationMode: parent.orchestrationMode ?? 'default',
        },
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => {
        transitionSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(transitionSettled, false);

    releaseProvision.release();
    const provisioned = await provision;
    const transitionResult = await transition;
    assert.strictEqual(transitionResult.ok, false);
    if (transitionResult.ok) throw new Error('Configuration transition unexpectedly committed');
    assert.ok(transitionResult.error instanceof SessionConfigurationTransitionError);
    assert.strictEqual(transitionResult.error.code, 'operation_conflict');
    assert.strictEqual((await store.readHeader(parent.id)).permissionMode, 'bypass');
    assert.strictEqual(provisioned.header.permissionMode, 'bypass');
  });

  test('snapshots a catalog agent into a metadata-only child with reserved activation ids', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(30),
    });
    const parent = await manager.createSession(
      makeInput({
        cwd: '/tmp/graph-project',
        llmConnectionSlug: 'graph-connection',
        model: 'graph-model',
        thinkingLevel: 'medium',
        permissionMode: 'ask',
      }),
    );
    await runStore.createRun(
      makeRunHeader({
        sessionId: parent.id,
        runId: 'supervisor-run',
        turnId: 'supervisor-turn',
        cwd: '/tmp/graph-project',
      }),
    );

    const result = await manager.provisionAgentGraphOperator({
      graphId: 'graph-1',
      workId: `graph_work_${'1'.repeat(32)}`,
      agentId: LOCAL_READ_AGENT_ID,
      operatorId: `graph_operator_${'2'.repeat(32)}`,
      source: {
        sessionId: parent.id,
        runId: 'supervisor-run',
        turnId: 'supervisor-turn',
        toolCallId: 'schedule-tool',
      },
      edges: [
        {
          edgeId: `graph_edge_${'3'.repeat(32)}`,
          fromOperatorId: 'writer',
          toOperatorId: `graph_operator_${'2'.repeat(32)}`,
        },
      ],
      expectedScheduleRevision: 1,
    });

    assert.strictEqual(result.created, true);
    assert.deepStrictEqual(result.header.subagentParent?.graph, {
      graphId: 'graph-1',
      workId: `graph_work_${'1'.repeat(32)}`,
      operatorId: `graph_operator_${'2'.repeat(32)}`,
    });
    assert.strictEqual(result.header.subagentRuntime?.agentId, LOCAL_READ_AGENT_ID);
    assert.strictEqual(result.header.permissionMode, 'explore');
    assert.strictEqual(result.provision.initialTurnId, result.header.subagentSpawn?.initialTurnId);
    assert.strictEqual(result.provision.initialRunId, result.header.subagentSpawn?.initialRunId);
    assert.deepStrictEqual(await runStore.listSessionRuns(result.header.id), []);
  });

  test('keeps four large graph branches and a replacement off the supervisor data plane', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(90),
    });
    const parent = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await runStore.createRun(
      makeRunHeader({
        sessionId: parent.id,
        runId: 'large-supervisor-run',
        turnId: 'large-supervisor-turn',
      }),
    );

    const rawPayloadBytes = 500 * 1024;
    const oversizedPayload = 'x'.repeat(rawPayloadBytes);
    const outputs = [];
    for (let index = 0; index < 5; index += 1) {
      const identity = String(index + 1).repeat(32);
      const provisioned = await manager.provisionAgentGraphOperator({
        graphId: 'graph-large-output',
        workId: `graph_work_${identity}`,
        agentId: LOCAL_READ_AGENT_ID,
        operatorId: `graph_operator_${identity}`,
        source: {
          sessionId: parent.id,
          runId: 'large-supervisor-run',
          turnId: 'large-supervisor-turn',
          toolCallId: `schedule-large-${index}`,
        },
        edges: [],
        expectedScheduleRevision: index + 1,
      });
      const failed = index === 2;
      const run = makeRunHeader({
        sessionId: provisioned.header.id,
        runId: provisioned.provision.initialRunId,
        turnId: provisioned.provision.initialTurnId,
        status: failed ? 'failed' : 'completed',
        createdAt: 100 + index * 10,
        updatedAt: 109 + index * 10,
        completedAt: 109 + index * 10,
        ...(failed ? { failureClass: 'branch_failed' } : {}),
      });
      await seedRuntimeRun(runStore, run, [
        runtimeEvent({
          id: `large-tool-result-${index}`,
          sessionId: run.sessionId,
          runId: run.runId,
          turnId: run.turnId,
          ts: 105 + index * 10,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: `large-tool-${index}`,
            name: 'Read',
            result: oversizedPayload,
            isError: false,
          },
        }),
        runtimeEvent({
          id: `large-final-${index}`,
          sessionId: run.sessionId,
          runId: run.runId,
          turnId: run.turnId,
          ts: 108 + index * 10,
          role: 'model',
          author: 'agent',
          content: {
            kind: 'text',
            text: failed
              ? 'Branch failed after collecting evidence.'
              : index === 4
                ? 'Replacement branch completed with a verified answer.'
                : `Branch ${index + 1} completed with a verified answer.`,
          },
        }),
        runtimeEvent({
          id: `large-terminal-${index}`,
          sessionId: run.sessionId,
          runId: run.runId,
          turnId: run.turnId,
          ts: 109 + index * 10,
          role: 'system',
          author: 'system',
          status: failed ? 'failed' : 'completed',
          actions: { endInvocation: true },
        }),
      ]);
      outputs.push(
        await manager.readChildAgentOutput(parent.id, {
          execution: {
            kind: 'child_session',
            sessionId: run.sessionId,
            currentRunId: run.runId,
          },
          view: 'result',
          maxBytes: 32 * 1024,
        }),
      );
    }

    const serializedOutputs = JSON.stringify(outputs);
    assert.strictEqual(
      Buffer.byteLength(oversizedPayload, 'utf8') * outputs.length >= 2_500 * 1024,
      true,
    );
    assert.strictEqual(Buffer.byteLength(serializedOutputs, 'utf8') < 64 * 1024, true);
    assert.strictEqual(serializedOutputs.includes(oversizedPayload.slice(0, 1024)), false);
    assert.strictEqual(
      outputs.every((output) => output.runtimeEvents.length === 0),
      true,
    );
    assert.strictEqual(
      outputs.every((output) => output.budget.projectedBytes <= 32 * 1024),
      true,
    );
    assert.strictEqual(outputs[2]?.result?.status, 'failed');
    assert.strictEqual(outputs[2]?.result?.failureClass, 'branch_failed');
    assert.strictEqual(
      outputs[4]?.result?.text,
      'Replacement branch completed with a verified answer.',
    );
  });

  test('does not advertise implementation when the current project cannot use worktrees', async () => {
    const store = new MemorySessionStore();
    const checkedSources: unknown[] = [];
    const manager = new SessionManager({
      store,
      backends: new BackendRegistry(),
      childTools: IMPLEMENTATION_AGENT_DEFINITION.tools.map(testTool),
      worktreeChildExecutor: {
        isAvailable: async (input) => {
          checkedSources.push(input);
          return false;
        },
        provision: async () => {
          throw new Error('unavailable executor must not provision');
        },
        ensure: async () => {},
        capturePatch: async () => new Uint8Array(),
        recover: async () => {},
        retire: async () => {},
      },
      newId: nextId(),
      now: nextNow(40),
    });
    const parent = await manager.createSession(
      makeInput({ cwd: '/tmp/plain-folder', projectId: 'plain-project' }),
    );

    const implementation = (await manager.listChildAgents(parent.id)).definitions.find(
      (definition) => definition.id === IMPLEMENTATION_AGENT_ID,
    );

    assert.deepStrictEqual(checkedSources, [
      { sourceCwd: '/tmp/plain-folder', sourceProjectId: 'plain-project' },
    ]);
    assert.deepStrictEqual(implementation?.availability, {
      status: 'unavailable',
      reason: 'workspace_isolation_unavailable',
      workspace: AGENT_WORKSPACE_WORKTREE,
      requiredRuntime: 'worktree_child_executor',
    });
  });

  test('binds implementation operators to a durable project worktree', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const provisioned: unknown[] = [];
    const binding = {
      schemaVersion: 1 as const,
      kind: 'git_worktree' as const,
      leaseId: `subagent_worktree_${'a'.repeat(32)}`,
      gitCommonDir: '/tmp/project/.git',
      worktreePath: '/tmp/worktrees/implementation-a',
      branch: `maka/subagent/${'a'.repeat(32)}`,
      baseCommit: 'b'.repeat(40),
    };
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      childTools: IMPLEMENTATION_AGENT_DEFINITION.tools
        .filter((name) => name !== 'Write' && name !== 'Edit')
        .map(testTool),
      worktreeChildExecutor: {
        isAvailable: async () => true,
        provision: async (input) => {
          provisioned.push(input);
          return {
            ...binding,
            leaseId: input.leaseId,
            worktreePath: `/tmp/worktrees/${input.leaseId}`,
            branch: `maka/subagent/${input.leaseId.slice('subagent_worktree_'.length)}`,
          };
        },
        ensure: async () => {},
        capturePatch: async () => new Uint8Array(),
        recover: async () => {},
        retire: async () => {},
      },
      listArtifactsForTurn: async () => [],
      publishChildWorkspacePatch: async () => {
        throw new Error('Patch publication is not expected during provisioning');
      },
      assertChildWorkspaceQuiescent: async () => {},
      newId: nextId(),
      now: nextNow(40),
    });
    const parent = await manager.createSession(
      makeInput({
        cwd: '/tmp/project',
        projectId: 'project-1',
        permissionMode: 'ask',
      }),
    );
    await runStore.createRun(
      makeRunHeader({
        sessionId: parent.id,
        runId: 'supervisor-run',
        turnId: 'supervisor-turn',
        cwd: '/tmp/project',
      }),
    );

    const result = await manager.provisionAgentGraphOperator({
      graphId: 'graph-worktree',
      workId: `graph_work_${'4'.repeat(32)}`,
      agentId: IMPLEMENTATION_AGENT_ID,
      operatorId: `graph_operator_${'5'.repeat(32)}`,
      source: {
        sessionId: parent.id,
        runId: 'supervisor-run',
        turnId: 'supervisor-turn',
        toolCallId: 'schedule-tool',
      },
      edges: [],
      expectedScheduleRevision: 1,
    });

    assert.strictEqual(provisioned.length, 1);
    assert.strictEqual(result.header.projectId, 'project-1');
    assert.strictEqual(result.header.permissionMode, 'ask');
    assert.strictEqual(
      result.header.subagentRuntime
        ? 'permissionCeiling' in result.header.subagentRuntime
        : undefined,
      false,
    );
    assert.strictEqual(result.header.cwd, result.header.subagentWorkspace?.worktreePath);
    assert.strictEqual(result.header.subagentWorkspace?.kind, 'git_worktree');
    assert.match(String(result.header.subagentWorkspace?.branch), /^maka\/subagent\//);
    assert.deepStrictEqual(result.header.subagentRuntime?.toolNames, [
      'Read',
      'Glob',
      'Grep',
      'apply_patch',
      'Bash',
      'WriteStdin',
      'StopBackgroundTask',
    ]);
    assert.deepStrictEqual(
      headerToSummary(result.header).subagentWorkspace,
      result.header.subagentWorkspace,
    );
  });

  test('recovers only the latest unpublished implementation patch idempotently', async () => {
    const store = new MemorySessionStore();
    const runStore = new ReverseOrderedAgentRunStore();
    const binding = {
      schemaVersion: 1 as const,
      kind: 'git_worktree' as const,
      leaseId: `subagent_worktree_${'d'.repeat(32)}`,
      gitCommonDir: '/tmp/project/.git',
      worktreePath: '/tmp/worktrees/implementation-recovery',
      branch: `maka/subagent/${'d'.repeat(32)}`,
      baseCommit: 'e'.repeat(40),
    };
    const parent = await store.create(makeInput({ cwd: '/tmp/project' }));
    const { header: child } = await store.createSubagent(
      makeInput({
        cwd: binding.worktreePath,
        permissionMode: 'ask',
        subagentParent: {
          kind: 'subagent',
          parentSessionId: parent.id,
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
          agentId: IMPLEMENTATION_AGENT_ID,
          agentName: IMPLEMENTATION_AGENT_DEFINITION.name,
          profile: 'implementation',
          systemPrompt: IMPLEMENTATION_AGENT_DEFINITION.systemPrompt,
          toolNames: [...IMPLEMENTATION_AGENT_DEFINITION.tools],
          categoryPolicy: {},
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: 'f'.repeat(64),
          initialTurnId: 'child-turn',
          initialRunId: 'child-run',
        },
        subagentWorkspace: binding,
      }),
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: child.id,
        runId: 'child-run',
        turnId: 'child-turn',
        status: 'completed',
        completedAt: 20,
        updatedAt: 20,
        cwd: binding.worktreePath,
        permissionMode: 'ask',
        agentId: IMPLEMENTATION_AGENT_ID,
        agentName: IMPLEMENTATION_AGENT_DEFINITION.name,
      }),
      [
        runtimeEvent({
          id: 'child-complete',
          sessionId: child.id,
          runId: 'child-run',
          turnId: 'child-turn',
          ts: 20,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    const artifacts = new Map<string, ArtifactRecord[]>();
    let captures = 0;
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      worktreeChildExecutor: {
        isAvailable: async () => true,
        provision: async () => binding,
        ensure: async () => {},
        capturePatch: async () => {
          captures += 1;
          return new TextEncoder().encode('terminal patch');
        },
        recover: async () => {},
        retire: async () => {},
      },
      listArtifactsForTurn: async (sessionId, turnId) =>
        artifacts.get(`${sessionId}:${turnId}`) ?? [],
      publishChildWorkspacePatch: async ({ sessionId, turnId, patch }) => {
        const record: ArtifactRecord = {
          id: 'recovered-writeback',
          sessionId,
          turnId,
          createdAt: 30,
          name: 'workspace.patch',
          kind: 'diff',
          relativePath: `${sessionId}/recovered-writeback-workspace.patch`,
          sizeBytes: patch.byteLength,
          mimeType: 'text/x-diff; charset=utf-8',
          source: 'subagent_writeback',
          status: 'live',
        };
        artifacts.set(`${sessionId}:${turnId}`, [record]);
        return record;
      },
      assertChildWorkspaceQuiescent: async () => {},
      newId: nextId(),
      now: nextNow(40),
    });

    await manager.recoverChildWorkspacePatches([parent.id, child.id]);
    await manager.recoverChildWorkspacePatches([child.id]);

    assert.strictEqual(captures, 1);
    assert.strictEqual(artifacts.get(`${child.id}:child-turn`)?.[0]?.source, 'subagent_writeback');

    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: child.id,
        runId: 'newer-child-run',
        turnId: 'newer-child-turn',
        status: 'completed',
        createdAt: 50,
        completedAt: 60,
        updatedAt: 60,
        cwd: binding.worktreePath,
        permissionMode: 'ask',
        agentId: IMPLEMENTATION_AGENT_ID,
        agentName: IMPLEMENTATION_AGENT_DEFINITION.name,
        resumedFromRunId: 'child-run',
      }),
      [
        runtimeEvent({
          id: 'newer-child-complete',
          sessionId: child.id,
          runId: 'newer-child-run',
          turnId: 'newer-child-turn',
          ts: 60,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    const oldArtifact = artifacts.get(`${child.id}:child-turn`)?.[0];
    if (!oldArtifact) throw new Error('Recovered patch Artifact is missing');
    artifacts.set(`${child.id}:newer-child-turn`, [
      {
        ...oldArtifact,
        id: 'newer-writeback',
        turnId: 'newer-child-turn',
        relativePath: `${child.id}/newer-writeback-workspace.patch`,
      },
    ]);
    artifacts.delete(`${child.id}:child-turn`);

    await expectRejects(
      manager.readChildAgentOutput(parent.id, {
        execution: {
          kind: 'child_session',
          sessionId: child.id,
          currentRunId: 'child-run',
        },
      }),
      /cannot reconstruct the historical workspace patch/,
    );
    assert.strictEqual(captures, 1);
  });
});

describe('SessionManager claimed graph intent execution', () => {
  test('fails closed without a trusted hosted graph execution capability', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backendBuilds = 0;
    backends.register('ai-sdk', (ctx) => {
      backendBuilds += 1;
      return new TestBackend(ctx);
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      messageAuthority: hostedRootAuthority(),
      newId: nextId(),
      now: nextNow(20),
    });
    const parent = await manager.createSession(makeInput({ name: 'Supervisor' }));
    const child = await createGraphOperatorSession(store, parent.id);
    const claim = graphIntentClaim({ targetSessionId: child.id }, 'must not start');

    await expectRejects(
      manager.runClaimedAgentGraphIntent(graphExecutionInput(claim, 'must not start')),
      /requires its trusted graph execution capability/,
    );

    assert.deepStrictEqual(await runStore.listSessionRuns(child.id), []);
    assert.deepStrictEqual(await store.readMessages(child.id), []);
    assert.strictEqual(backendBuilds, 0);
  });

  test('hosted execution reads the trusted claim and delegates the exact root descriptor', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const executions: Parameters<RuntimeHostedRootAuthority['executeRoot']>[0][] = [];
    const authority = hostedRootAuthority();
    authority.executeRoot = async (input) => {
      executions.push(input);
      for await (const event of input.start({
        runId: input.runId,
        userMessageId: input.userMessageId,
        onRunStarted: () => input.onReady?.(),
      })) {
        input.onEvent?.(event);
      }
    };
    const parent = await store.create(makeInput({ name: 'Supervisor' }));
    const child = await createGraphOperatorSession(store, parent.id);
    const claim = graphIntentClaim(
      {
        targetSessionId: child.id,
        targetTurnId: 'hosted-graph-turn',
        targetRunId: 'hosted-graph-run',
      },
      'canonical hosted graph prompt',
    );
    const prompt = 'canonical hosted graph prompt';
    const trustedExecution = graphExecutionInput(claim, prompt);
    let trustedReads = 0;
    const trustedClaimStore = trustedExecution.claimStore;
    const callerClaimStore: AgentGraphIntentClaimStore = {
      async claimAgentGraphIntent() {
        throw new Error('caller store must not be used');
      },
      async readAgentGraphIntentClaim() {
        throw new Error('caller store must not be used');
      },
      async listAgentGraphIntentClaims() {
        throw new Error('caller store must not be used');
      },
    };
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      messageAuthority: authority,
      hostedAgentGraphExecution: {
        async readAgentGraphIntentClaim(graphId, intentId) {
          trustedReads += 1;
          return trustedClaimStore.readAgentGraphIntentClaim(graphId, intentId);
        },
        async readRootTurnAdmissionIdentity(sessionId, turnId) {
          const admission = await runStore.readRootTurnAdmission(sessionId, turnId);
          return admission
            ? { runId: admission.runId, userMessageId: admission.userMessageId }
            : undefined;
        },
      },
      newId: nextId(),
      now: nextNow(30),
    });

    const result = await manager.runClaimedAgentGraphIntent({
      ...trustedExecution,
      claimStore: callerClaimStore,
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(trustedReads, 1);
    assert.strictEqual(executions.length, 1);
    assert.partialDeepStrictEqual(executions[0], {
      sessionId: child.id,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
      userMessageId: 'id-1',
    });
    assert.deepStrictEqual((executions[0] as { execution?: unknown }).execution, {
      kind: 'claimed_agent_graph_intent',
      claim,
      agentId: LOCAL_READ_AGENT_ID,
      agentName: LOCAL_READ_AGENT_DEFINITION.name,
    });
    assert.deepStrictEqual((executions[0] as { content?: unknown }).content, { text: prompt });
    assert.partialDeepStrictEqual(
      (await store.readMessages(child.id)).find(
        (message) => message.type === 'user' && message.turnId === claim.targetTurnId,
      ),
      { id: 'id-1', text: prompt },
    );
  });

  test('hosted execution rejects prompt drift from the durable graph claim before admission', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backendBuilds = 0;
    backends.register('ai-sdk', (ctx) => {
      backendBuilds += 1;
      return new TestBackend(ctx);
    });
    const parent = await store.create(makeInput({ name: 'Supervisor' }));
    const child = await createGraphOperatorSession(store, parent.id);
    const proposedClaim = graphIntentClaim({
      targetSessionId: child.id,
      targetTurnId: 'prompt-bound-turn',
      targetRunId: 'prompt-bound-run',
    });
    const intent = graphRunnableIntentForClaim(proposedClaim);
    let persistedClaim: AgentGraphIntentClaim | undefined;
    const durableClaims: AgentGraphIntentClaimStore = {
      async claimAgentGraphIntent(request) {
        if (persistedClaim) return { claim: persistedClaim, created: false };
        persistedClaim = { ...request, claimedAt: 31 };
        return { claim: persistedClaim, created: true };
      },
      async readAgentGraphIntentClaim(graphId, intentId) {
        return persistedClaim?.graphId === graphId && persistedClaim.intentId === intentId
          ? persistedClaim
          : undefined;
      },
      async listAgentGraphIntentClaims(graphId) {
        return persistedClaim && (!graphId || persistedClaim.graphId === graphId)
          ? [persistedClaim]
          : [];
      },
    };
    const admitted = await claimAgentGraphRunnableIntent({
      intent,
      store: durableClaims,
      newId: nextId(),
      targetTurnId: proposedClaim.targetTurnId,
      targetRunId: proposedClaim.targetRunId,
      executionInput: { prompt: 'durably claimed prompt A' },
    });
    let hostedExecutions = 0;
    const authority = hostedRootAuthority();
    authority.executeRoot = async () => {
      hostedExecutions += 1;
    };
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      messageAuthority: authority,
      hostedAgentGraphExecution: hostedGraphExecutionCapability(durableClaims, runStore),
      newId: nextId(),
      now: nextNow(31),
    });

    await expectRejects(
      manager.runClaimedAgentGraphIntent({
        claimStore: durableClaims,
        intent,
        graphId: admitted.claim.graphId,
        intentId: admitted.claim.intentId,
        prompt: 'drifted prompt B',
      }),
      /does not match its durable claim/,
    );

    assert.strictEqual(hostedExecutions, 0);
    assert.strictEqual(backendBuilds, 0);
    assert.deepStrictEqual(await runStore.listSessionRuns(child.id), []);
    assert.deepStrictEqual(await store.readMessages(child.id), []);
    assert.strictEqual(
      await runStore.readRootTurnAdmission(child.id, proposedClaim.targetTurnId),
      undefined,
    );
  });

  test('hosted retry reuses an admitted user message identity before a Run exists', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const parent = await store.create(makeInput({ name: 'Supervisor' }));
    const child = await createGraphOperatorSession(store, parent.id);
    const claim = graphIntentClaim(
      {
        targetSessionId: child.id,
        targetTurnId: 'admitted-graph-turn',
        targetRunId: 'admitted-graph-run',
      },
      'resume admitted graph root',
    );
    const descriptor: RootExecutionDescriptor = {
      kind: 'claimed_agent_graph_intent',
      claim,
      agentId: LOCAL_READ_AGENT_ID,
      agentName: LOCAL_READ_AGENT_DEFINITION.name,
    };
    runStore.seedRootTurnAdmission(child.id, claim.targetTurnId, {
      runId: claim.targetRunId,
      userMessageId: 'durable-graph-user-message',
      execution: descriptor,
    });
    let newIdCalls = 0;
    let newIdCallsAtExecution = -1;
    const authority = hostedRootAuthority();
    authority.executeRoot = async (input) => {
      newIdCallsAtExecution = newIdCalls;
      assert.strictEqual(input.userMessageId, 'durable-graph-user-message');
      for await (const event of input.start({
        runId: input.runId,
        userMessageId: input.userMessageId,
        onRunStarted: () => input.onReady?.(),
      })) {
        input.onEvent?.(event);
      }
    };
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      messageAuthority: authority,
      hostedAgentGraphExecution: hostedGraphExecutionCapability(
        graphExecutionInput(claim, '').claimStore,
        runStore,
      ),
      newId: () => `retry-id-${++newIdCalls}`,
      now: nextNow(33),
    });

    const result = await manager.runClaimedAgentGraphIntent(
      graphExecutionInput(claim, 'resume admitted graph root'),
    );

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(newIdCallsAtExecution, 0);
    assert.partialDeepStrictEqual(
      (await store.readMessages(child.id)).find(
        (message) => message.type === 'user' && message.turnId === claim.targetTurnId,
      ),
      {
        id: 'durable-graph-user-message',
        text: 'resume admitted graph root',
      },
    );
  });

  test('hosted retry rejects an existing Run without its durable RootTurn admission', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backendBuilds = 0;
    backends.register('ai-sdk', (ctx) => {
      backendBuilds += 1;
      return new TestBackend(ctx);
    });
    const parent = await store.create(makeInput({ name: 'Supervisor' }));
    const child = await createGraphOperatorSession(store, parent.id);
    const claim = graphIntentClaim(
      {
        targetSessionId: child.id,
        targetTurnId: 'orphaned-hosted-turn',
        targetRunId: 'orphaned-hosted-run',
      },
      'must not be backfilled',
    );
    await runStore.createRun(
      makeRunHeader({
        sessionId: child.id,
        runId: claim.targetRunId,
        turnId: claim.targetTurnId,
        status: 'completed',
        completedAt: 34,
        permissionMode: 'explore',
        agentId: LOCAL_READ_AGENT_ID,
        agentName: LOCAL_READ_AGENT_DEFINITION.name,
      }),
    );
    let hostedExecutions = 0;
    const authority = hostedRootAuthority();
    authority.executeRoot = async () => {
      hostedExecutions += 1;
    };
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      messageAuthority: authority,
      hostedAgentGraphExecution: hostedGraphExecutionCapability(
        graphExecutionInput(claim, '').claimStore,
        runStore,
      ),
      newId: nextId(),
      now: nextNow(34),
    });

    await expectRejects(
      manager.runClaimedAgentGraphIntent(graphExecutionInput(claim, 'must not be backfilled')),
      /missing its durable RootTurn admission/,
    );

    assert.strictEqual(hostedExecutions, 0);
    assert.strictEqual(backendBuilds, 0);
    assert.deepStrictEqual(await store.readMessages(child.id), []);
    assert.strictEqual((await runStore.readRun(child.id, claim.targetRunId)).status, 'completed');
  });

  test('hosted explicit abort stops only the exact claimed root identity', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const backendGate = makeGate();
    const ready = makeGate();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx, backendGate));
    const stoppedRoots: RuntimeMessageRunIdentity[] = [];
    let stoppedSessions = 0;
    const authority = hostedRootAuthority();
    authority.stopRoot = async (identity) => {
      stoppedRoots.push(identity);
      backendGate.release();
    };
    authority.stopSession = async () => {
      stoppedSessions += 1;
    };
    const parent = await store.create(makeInput({ name: 'Supervisor' }));
    const child = await createGraphOperatorSession(store, parent.id);
    const claim = graphIntentClaim(
      {
        targetSessionId: child.id,
        targetTurnId: 'aborted-hosted-turn',
        targetRunId: 'aborted-hosted-run',
      },
      'abort this exact root',
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      messageAuthority: authority,
      hostedAgentGraphExecution: hostedGraphExecutionCapability(
        graphExecutionInput(claim, '').claimStore,
        runStore,
      ),
      newId: nextId(),
      now: nextNow(35),
    });
    const abort = new AbortController();
    const execution = manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(claim, 'abort this exact root'),
      abortSignal: abort.signal,
      onReady: () => ready.release(),
    });
    await ready.promise;

    abort.abort();
    await execution;

    assert.deepStrictEqual(stoppedRoots, [
      {
        sessionId: child.id,
        turnId: claim.targetTurnId,
        runId: claim.targetRunId,
      },
    ]);
    assert.strictEqual(stoppedSessions, 0);
  });

  test('recovers a pending hosted graph admission without source lineage', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(38),
    });
    const parent = await store.create(makeInput({ name: 'Supervisor' }));
    const child = await createGraphOperatorSession(store, parent.id);
    const claim = graphIntentClaim({
      targetSessionId: child.id,
      targetTurnId: 'recovered-graph-turn',
      targetRunId: 'recovered-graph-run',
    });

    await manager.closePendingHostedAdmission({
      sessionId: child.id,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
      admittedAt: 37,
      execution: {
        kind: 'claimed_agent_graph_intent',
        claim,
        agentId: LOCAL_READ_AGENT_ID,
        agentName: LOCAL_READ_AGENT_DEFINITION.name,
      },
    });

    const run = await runStore.readRun(child.id, claim.targetRunId);
    assert.partialDeepStrictEqual(run, {
      status: 'failed',
      failureClass: 'app_restarted',
      agentId: LOCAL_READ_AGENT_ID,
      agentName: LOCAL_READ_AGENT_DEFINITION.name,
    });
    assert.strictEqual(run.workspaceIdentity, undefined);
    assert.strictEqual(run.resumedFromRunId, undefined);
    assert.strictEqual(run.retriedFromRunId, undefined);
    const terminalEvents = (await runStore.readRuntimeEvents(child.id, claim.targetRunId)).filter(
      (event) => event.status === 'failed',
    );
    assert.strictEqual(terminalEvents.length, 1);
    assert.partialDeepStrictEqual(terminalEvents[0]?.actions?.stateDelta, {
      recovered: true,
      recoveryReason: 'child_internal_admission_without_run',
      executionKind: 'claimed_agent_graph_intent',
      failureClass: 'app_restarted',
    });
    assert.strictEqual(terminalEvents[0]?.actions?.stateDelta?.sourceRunId, undefined);
  });

  test('runs the exact claimed session-inline activation and durably deduplicates retries', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const backendsBySession = new Map<string, TestBackend>();
    backends.register('ai-sdk', (ctx) => {
      const backend = new TestBackend(ctx);
      backendsBySession.set(ctx.sessionId, backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(40),
    });
    const parent = await manager.createSession(makeInput({ name: 'Supervisor' }));
    const child = await createGraphOperatorSession(store, parent.id);
    const claim = graphIntentClaim(
      {
        targetSessionId: child.id,
        targetTurnId: 'graph-turn',
        targetRunId: 'graph-run',
      },
      'summarize the routed records',
    );
    const ready: unknown[] = [];

    const result = await manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(claim, 'summarize the routed records'),
      onReady: (input) => {
        ready.push(input);
      },
    });

    assert.partialDeepStrictEqual(result, {
      claimId: claim.claimId,
      graphId: claim.graphId,
      intentId: claim.intentId,
      operatorId: claim.targetOperatorId,
      childSessionId: child.id,
      turnId: 'graph-turn',
      runId: 'graph-run',
      agentId: LOCAL_READ_AGENT_ID,
      status: 'completed',
      summary: 'ok',
    });
    assert.deepStrictEqual(ready, [
      {
        claimId: claim.claimId,
        graphId: claim.graphId,
        intentId: claim.intentId,
        operatorId: claim.targetOperatorId,
        childSessionId: child.id,
        turnId: 'graph-turn',
        runId: 'graph-run',
        agentId: LOCAL_READ_AGENT_ID,
        agentName: LOCAL_READ_AGENT_DEFINITION.name,
      },
    ]);
    const run = await runStore.readRun(child.id, 'graph-run');
    assert.strictEqual(isSessionInlineRun(run), true);
    assert.strictEqual(run.parentRunId, undefined);
    assert.strictEqual(run.turnId, 'graph-turn');
    assert.partialDeepStrictEqual(
      (await store.readMessages(child.id)).find(
        (message) => message.type === 'user' && message.turnId === 'graph-turn',
      ),
      { text: 'summarize the routed records' },
    );

    await store.updateHeader(child.id, { isArchived: true });
    const retry = await manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(claim, 'summarize the routed records'),
    });
    assert.partialDeepStrictEqual(retry, {
      claimId: result.claimId,
      childSessionId: result.childSessionId,
      turnId: result.turnId,
      runId: result.runId,
      status: 'completed',
      summary: 'ok',
    });
    assert.strictEqual((await runStore.listSessionRuns(child.id)).length, 1);
    assert.strictEqual(backendsBySession.get(child.id)?.sendInputs.length, 1);
    await expectRejects(
      manager.runClaimedAgentGraphIntent({
        ...graphExecutionInput(claim, 'perform different work'),
      }),
      /does not match its durable claim/,
    );
  });

  test('joins concurrent execution of one claim and rejects in-flight input drift', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const childGate = makeGate();
    const started = makeGate();
    let childBackend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      childBackend = new TestBackend(ctx, childGate);
      return childBackend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(60),
    });
    const parent = await manager.createSession(makeInput());
    const child = await createGraphOperatorSession(store, parent.id);
    const claim = graphIntentClaim({ targetSessionId: child.id }, 'one activation');
    const first = manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(claim, 'one activation'),
      onReady: () => started.release(),
    });
    await started.promise;

    const joined = manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(claim, 'one activation'),
    });
    await expectRejects(
      manager.runClaimedAgentGraphIntent({
        ...graphExecutionInput(claim, 'drifted activation'),
      }),
      /does not match its durable claim/,
    );
    childGate.release();

    const [firstResult, joinedResult] = await Promise.all([first, joined]);
    assert.deepStrictEqual(joinedResult, firstResult);
    assert.strictEqual(childBackend?.sendInputs.length, 1);
    assert.strictEqual((await runStore.listSessionRuns(child.id)).length, 1);
  });

  test('serializes different claims per child session without letting a queued abort stop active work', async () => {
    const { store, runStore, manager, child, backend, activeGate, first, claims } =
      await createQueuedGraphScenario();
    const [firstClaim, secondClaim, thirdClaim] = claims;

    const queuedAbort = new AbortController();
    let secondReadyCount = 0;
    const second = manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(secondClaim, 'queued activation'),
      abortSignal: queuedAbort.signal,
      onReady: () => {
        secondReadyCount += 1;
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(secondReadyCount, 0);
    assert.strictEqual(backend?.sendInputs.length, 1);

    queuedAbort.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(backend?.stopCalls, 0);
    assert.strictEqual((await runStore.listSessionRuns(child.id)).length, 1);

    activeGate.release();
    assert.strictEqual((await first).status, 'completed');
    await expectRejects(second, /cancelled before runtime admission/);
    assert.strictEqual(secondReadyCount, 0);
    assert.strictEqual(backend?.stopCalls, 0);
    assert.strictEqual(backend?.sendInputs.length, 1);

    const third = await manager.runClaimedAgentGraphIntent(
      graphExecutionInput(thirdClaim, 'third activation'),
    );
    assert.strictEqual(third.status, 'completed');
    assert.strictEqual(backend?.sendInputs.length, 2);
    assert.strictEqual((await runStore.listSessionRuns(child.id)).length, 2);
  });

  test('evaluates execution admission only after a claimed child-session slot is available', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const firstGate = makeGate();
    const firstReady = makeGate();
    let backend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new TestBackend(ctx, firstGate);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(75),
    });
    const parent = await manager.createSession(makeInput());
    const child = await createGraphOperatorSession(store, parent.id);
    const firstClaim = graphIntentClaim({ targetSessionId: child.id }, 'first activation');
    const queuedClaim = graphIntentClaim(
      {
        claimId: `graph_claim_${'7'.repeat(32)}`,
        intentId: `graph_intent_${'8'.repeat(32)}`,
        targetSessionId: child.id,
        targetTurnId: 'queued-turn',
        targetRunId: 'queued-run',
      },
      'cancelled queued activation',
    );
    const first = manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(firstClaim, 'first activation'),
      onReady: () => firstReady.release(),
    });
    await firstReady.promise;

    let admissionChecks = 0;
    const queued = manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(queuedClaim, 'cancelled queued activation'),
      async admitExecution() {
        admissionChecks += 1;
        return 'cancelled';
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(admissionChecks, 0);

    firstGate.release();
    assert.strictEqual((await first).status, 'completed');
    await expectRejects(queued, /cancelled before runtime admission/);
    assert.strictEqual(admissionChecks, 1);
    assert.strictEqual(backend?.sendInputs.length, 1);
    assert.strictEqual((await runStore.listSessionRuns(child.id)).length, 1);
  });

  test('keeps a stop pending across graph admission with an idle cached backend', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const admissionStarted = makeGate();
    const releaseAdmission = makeGate();
    let backend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(77),
    });
    const parent = await manager.createSession(makeInput());
    const child = await createGraphOperatorSession(store, parent.id);
    await drain(
      manager.sendMessage(child.id, {
        turnId: 'completed-before-admission',
        text: 'warm the cached operator backend',
      }),
    );
    assert.strictEqual(backend?.sendInputs?.length, 1);
    const claim = graphIntentClaim(
      { targetSessionId: child.id },
      'activation stopped during admission',
    );
    const execution = manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(claim, 'activation stopped during admission'),
      async admitExecution() {
        admissionStarted.release();
        await releaseAdmission.promise;
        return 'executing';
      },
    });
    await admissionStarted.promise;

    let stopSettled = false;
    const stop = manager.stopSession(child.id, { source: 'graph_supervisor' }).finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    assert.strictEqual(stopSettled, false);
    assert.strictEqual(backend?.sendInputs?.length, 1);

    releaseAdmission.release();
    await stop;
    const result = await execution;

    assert.strictEqual(result.status, 'cancelled');
    assert.strictEqual(backend?.stopCalls, 1);
    assert.strictEqual(backend?.sendInputs?.length, 1);
    assert.strictEqual((await runStore.readRun(child.id, claim.targetRunId)).status, 'cancelled');
  });

  test('runtime stop settles queued graph claims without letting their slots pass the active claim', async () => {
    const firstAbort = new AbortController();
    const { store, runStore, manager, child, backend, stopStarted, first, claims } =
      await createQueuedGraphScenario(firstAbort.signal);
    const [firstClaim, secondClaim, thirdClaim] = claims;
    let queuedReady = 0;
    const second = manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(secondClaim, 'queued activation'),
      onReady: () => {
        queuedReady += 1;
      },
    });
    const third = manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(thirdClaim, 'third activation'),
      onReady: () => {
        queuedReady += 1;
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    firstAbort.abort();
    await stopStarted.promise;
    const bound = new AbortController();
    let results: Awaited<ReturnType<typeof Promise.allSettled>>;
    try {
      results = await Promise.race([
        Promise.allSettled([first, second, third]),
        timerDelay(2_000, undefined, { signal: bound.signal }).then(() => {
          throw new Error('graph stop composition did not settle within the bound');
        }),
      ]);
    } finally {
      bound.abort();
    }

    assert.strictEqual(results[0]?.status, 'fulfilled');
    assert.strictEqual(results[1]?.status, 'rejected');
    assert.strictEqual(results[2]?.status, 'rejected');
    assert.strictEqual(queuedReady, 0);
    assert.deepStrictEqual(
      backend?.sendInputs.map((input) => input.turnId),
      [firstClaim.targetTurnId],
    );
    assert.deepStrictEqual(
      (await runStore.listSessionRuns(child.id)).map((run) => run.turnId),
      [firstClaim.targetTurnId],
    );
    assert.deepStrictEqual(
      (await store.readMessages(child.id)).filter(
        (message) =>
          'turnId' in message &&
          (message.turnId === secondClaim.targetTurnId ||
            message.turnId === thirdClaim.targetTurnId),
      ),
      [],
    );
  });

  test('recovers an existing nonterminal claimed run without invoking the backend again', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backendBuilds = 0;
    backends.register('ai-sdk', (ctx) => {
      backendBuilds += 1;
      return new TestBackend(ctx);
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(80),
    });
    const parent = await manager.createSession(makeInput());
    const child = await createGraphOperatorSession(store, parent.id);
    const claim = graphIntentClaim({ targetSessionId: child.id }, 'interrupted turn');
    await seedRunningTurn(store, child.id, claim.targetTurnId);
    await seedRun(
      runStore,
      makeRunHeader({
        sessionId: child.id,
        runId: claim.targetRunId,
        turnId: claim.targetTurnId,
        status: 'running',
        permissionMode: 'explore',
        agentId: LOCAL_READ_AGENT_ID,
        agentName: LOCAL_READ_AGENT_DEFINITION.name,
      }),
      [
        makeRunEvent({
          sessionId: child.id,
          runId: claim.targetRunId,
          turnId: claim.targetTurnId,
          type: 'run_started',
          ts: 81,
        }),
      ],
    );

    const recovered = await manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(claim, 'interrupted turn'),
    });

    assert.strictEqual(recovered.status, 'failed');
    assert.strictEqual(recovered.failureClass, 'app_restarted');
    assert.strictEqual(backendBuilds, 0);
    assert.strictEqual((await runStore.listSessionRuns(child.id)).length, 1);
  });

  test('target Session stop owns a claimed graph execution before its first runtime preflight', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(90),
    });
    const parent = await manager.createSession(makeInput());
    const child = await createGraphOperatorSession(store, parent.id);
    const claim = graphIntentClaim(
      {
        targetSessionId: child.id,
        targetTurnId: 'stopped-graph-turn',
        targetRunId: 'stopped-graph-run',
      },
      'must stop before provider dispatch',
    );
    const readStarted = makeGate();
    const releaseRead = makeGate();
    store.nextReadHeaderGate = { started: readStarted, release: releaseRead };

    const executing = manager.runClaimedAgentGraphIntent(
      graphExecutionInput(claim, 'must stop before provider dispatch'),
    );
    await readStarted.promise;
    let stopSettled = false;
    const stopping = manager.stopSession(child.id, { source: 'stop_button' }).finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    assert.strictEqual(stopSettled, false);

    releaseRead.release();
    const [result] = await Promise.all([executing, stopping]);
    assert.strictEqual(result.status, 'cancelled');
    assert.deepStrictEqual(backend?.sendInputs, []);
    assert.strictEqual((await runStore.readRun(child.id, claim.targetRunId)).status, 'cancelled');
    assert.strictEqual((await store.readHeader(child.id)).status === 'blocked', false);
  });

  test('fails closed before runtime when claim routing collides or targets a main session', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backendBuilds = 0;
    backends.register('ai-sdk', (ctx) => {
      backendBuilds += 1;
      return new TestBackend(ctx);
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(100),
    });
    const parent = await manager.createSession(makeInput());
    const unclaimedIntent = graphRunnableIntentForClaim(
      graphIntentClaim({
        graphId: 'graph-unclaimed',
        intentId: `graph_intent_${'f'.repeat(32)}`,
      }),
    );
    await expectRejects(
      manager.runClaimedAgentGraphIntent({
        claimStore: {
          async claimAgentGraphIntent() {
            throw new Error('read-only');
          },
          async readAgentGraphIntentClaim() {
            return undefined;
          },
          async listAgentGraphIntentClaims() {
            return [];
          },
        },
        intent: unclaimedIntent,
        graphId: 'graph-unclaimed',
        intentId: `graph_intent_${'f'.repeat(32)}`,
        prompt: 'must not run',
      }),
      /has not been claimed/,
    );
    const mainSessionClaim = graphIntentClaim({ targetSessionId: parent.id }, 'must not run');
    await expectRejects(
      manager.runClaimedAgentGraphIntent(graphExecutionInput(mainSessionClaim, 'must not run')),
      /target must be a linked child session/,
    );

    const child = await createGraphOperatorSession(store, parent.id);
    const claim = graphIntentClaim({ targetSessionId: child.id }, 'must not run');
    await runStore.createRun(
      makeRunHeader({
        sessionId: child.id,
        runId: 'different-run',
        turnId: claim.targetTurnId,
        status: 'completed',
        permissionMode: 'explore',
        completedAt: 101,
        agentId: LOCAL_READ_AGENT_ID,
        agentName: LOCAL_READ_AGENT_DEFINITION.name,
      }),
    );
    await expectRejects(
      manager.runClaimedAgentGraphIntent(graphExecutionInput(claim, 'must not run')),
      /already owned by run different-run/,
    );

    const archivedChild = await createGraphOperatorSession(store, parent.id);
    await store.updateHeader(archivedChild.id, { isArchived: true });
    const archivedClaim = graphIntentClaim(
      {
        claimId: `graph_claim_${'3'.repeat(32)}`,
        intentId: `graph_intent_${'4'.repeat(32)}`,
        targetSessionId: archivedChild.id,
        targetTurnId: 'archived-turn',
        targetRunId: 'archived-run',
      },
      'must not revive archived work',
    );
    await expectRejects(
      manager.runClaimedAgentGraphIntent(
        graphExecutionInput(archivedClaim, 'must not revive archived work'),
      ),
      /target child session is terminated/,
    );

    const abortedChild = await createGraphOperatorSession(store, parent.id);
    await store.updateHeader(abortedChild.id, { status: 'aborted' });
    const abortedClaim = graphIntentClaim(
      {
        claimId: `graph_claim_${'5'.repeat(32)}`,
        intentId: `graph_intent_${'6'.repeat(32)}`,
        targetSessionId: abortedChild.id,
        targetTurnId: 'aborted-turn',
        targetRunId: 'aborted-run',
      },
      'must not revive aborted work',
    );
    await expectRejects(
      manager.runClaimedAgentGraphIntent(
        graphExecutionInput(abortedClaim, 'must not revive aborted work'),
      ),
      /target child session is terminated/,
    );
    assert.strictEqual(backendBuilds, 0);
  });
});

describe('SessionManager child-session runtime primitive', () => {
  test('creates a fresh read-only child with a session-inline first run and no parent history', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    const contexts: BackendFactoryContext[] = [];
    const backendActivationSessions: string[] = [];
    const backendsBySession = new Map<string, TestBackend>();
    backends.register('ai-sdk', (ctx) => {
      contexts.push(ctx);
      const backend = new TestBackend(ctx, ctx.header.subagentRuntime ? undefined : parentGate);
      backendsBySession.set(ctx.sessionId, backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(100),
      runBackendActivation: async (operation) => {
        const contextIndex = contexts.length;
        const result = await operation();
        const activatedContext = contexts[contextIndex];
        if (!activatedContext) throw new Error('Backend activation did not build a backend');
        backendActivationSessions.push(activatedContext.sessionId);
        return result;
      },
    });
    const parent = await manager.createSession(
      makeInput({
        cwd: '/tmp/project',
        projectId: 'project-1',
        llmConnectionSlug: 'connection-1',
        model: 'model-1',
        thinkingLevel: 'medium',
        permissionMode: 'ask',
      }),
    );
    const parentTurn = manager
      .sendMessage(parent.id, { turnId: 'parent-turn', text: 'private parent history' })
      [Symbol.asyncIterator]();
    await parentTurn.next();
    const [parentRun] = await runStore.listSessionRuns(parent.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const result = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'tool-call-1',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'inspect the storage boundary',
    });

    const childHeader = await store.readHeader(result.childSessionId);
    assert.deepStrictEqual(
      await store.readExecutionBoundary(result.childSessionId),
      await store.readExecutionBoundary(parent.id),
    );
    assert.strictEqual(childHeader.cwd, '/tmp/project');
    assert.strictEqual(childHeader.projectId, 'project-1');
    assert.strictEqual(
      childHeader.workspaceRoot,
      (await store.readHeader(parent.id)).workspaceRoot,
    );
    assert.strictEqual(childHeader.llmConnectionSlug, 'connection-1');
    assert.strictEqual(childHeader.model, 'model-1');
    assert.strictEqual(childHeader.thinkingLevel, 'medium');
    assert.strictEqual(childHeader.permissionMode, 'explore');
    assert.strictEqual(childHeader.connectionLocked, true);
    assert.deepStrictEqual(childHeader.subagentParent, {
      kind: 'subagent',
      parentSessionId: parent.id,
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'tool-call-1',
      },
      lifecycle: 'foreground',
    });
    assert.deepStrictEqual(childHeader.subagentRuntime, {
      schemaVersion: 1,
      definitionVersion: 1,
      agentId: LOCAL_READ_AGENT_ID,
      agentName: 'Local Read',
      profile: LOCAL_READ_AGENT_PROFILE,
      systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
      toolNames: ['Read', 'Glob', 'Grep'],
      categoryPolicy: {},
    });
    assert.strictEqual(childHeader.subagentSpawn?.schemaVersion, 1);
    assert.match(String(childHeader.subagentSpawn?.requestFingerprint), /^[a-f0-9]{64}$/);
    assert.strictEqual(childHeader.subagentSpawn?.initialTurnId, result.turnId);
    assert.strictEqual(childHeader.subagentSpawn?.initialRunId, result.runId);

    const [childRun] = await runStore.listSessionRuns(result.childSessionId);
    if (!childRun) throw new Error('child run was not recorded');
    assert.strictEqual(childRun.runId, result.runId);
    assert.strictEqual(childRun.parentRunId, undefined);
    assert.strictEqual(childRun.agentId, LOCAL_READ_AGENT_ID);
    assert.strictEqual(isSessionInlineRun(childRun), true);
    assert.strictEqual(result.status, 'completed');
    assert.deepStrictEqual(backendActivationSessions, [parent.id, result.childSessionId]);
    assert.strictEqual(
      (await runStore.readRuntimeEvents(result.childSessionId, childRun.runId)).every(
        (event) => event.sessionId === result.childSessionId,
      ),
      true,
    );

    const childContext = contexts.find((ctx) => ctx.sessionId === result.childSessionId);
    assert.strictEqual(childContext?.systemPrompt, LOCAL_READ_AGENT_DEFINITION.systemPrompt);
    assert.deepStrictEqual(
      childContext?.tools?.map((tool) => tool.name),
      ['Read', 'Glob', 'Grep'],
    );
    assert.deepStrictEqual(
      backendsBySession.get(result.childSessionId)?.sendInputs[0]?.context,
      [],
    );
    assert.strictEqual(
      backendsBySession
        .get(result.childSessionId)
        ?.sendInputs[0]?.runtimeContext?.some(
          (event) =>
            event.content?.kind === 'text' && event.content.text === 'private parent history',
        ) ?? false,
      false,
    );

    const parentMessages = await store.readMessages(parent.id);
    const childMessages = await store.readMessages(result.childSessionId);
    assert.strictEqual(
      parentMessages.some(
        (message) => message.type === 'user' && message.text === 'inspect the storage boundary',
      ),
      false,
    );
    assert.strictEqual(
      childMessages.some(
        (message) => message.type === 'user' && message.text === 'inspect the storage boundary',
      ),
      true,
    );
    await manager.setPermissionMode(result.childSessionId, 'bypass');
    assert.strictEqual((await store.readHeader(result.childSessionId)).permissionMode, 'bypass');
    const projection = await manager.listChildAgents(parent.id);
    assert.deepStrictEqual(projection.runs, []);
    assert.strictEqual(projection.executions.length, 1);
    assert.deepStrictEqual(projection.executions[0]?.execution, {
      kind: 'child_session',
      sessionId: result.childSessionId,
      currentRunId: result.runId,
    });
    assert.strictEqual(projection.executions[0]?.status, 'completed');
    const output = await manager.readChildAgentOutput(parent.id, {
      execution: {
        kind: 'child_session',
        sessionId: result.childSessionId,
      },
    });
    assert.deepStrictEqual(output.execution, {
      kind: 'child_session',
      sessionId: result.childSessionId,
      currentRunId: result.runId,
    });
    assert.strictEqual(output.header.sessionId, result.childSessionId);
    assert.strictEqual(output.header.runId, result.runId);
    const unrelatedParent = await manager.createSession(makeInput({ name: 'Unrelated parent' }));
    await expectRejects(
      manager.readChildAgentOutput(unrelatedParent.id, {
        execution: {
          kind: 'child_session',
          sessionId: result.childSessionId,
        },
      }),
      /could not find the requested child session/,
    );

    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('freezes a configured subagent model target independently from the parent', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    backends.register(
      'ai-sdk',
      (ctx) => new TestBackend(ctx, ctx.header.subagentRuntime ? undefined : parentGate),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      subagentCatalog: {
        list: async () => [
          {
            id: 'fast-reader',
            name: 'Fast reader',
            description: 'Cheap scans',
            profile: 'local_read',
            connectionSlug: 'worker-connection',
            model: 'worker-model',
            thinkingLevel: 'low',
            enabled: true,
            availability: { status: 'available' },
          },
        ],
        resolve: async (id) => {
          if (id !== 'fast-reader') throw new Error('unknown preset');
          return {
            connectionId: '33333333-3333-4333-8333-333333333333',
            id,
            name: 'Fast reader',
            description: 'Cheap scans',
            profile: 'local_read',
            connectionSlug: 'worker-connection',
            model: 'worker-model',
            thinkingLevel: 'low',
            enabled: true,
          };
        },
      },
      newId: nextId(),
      now: nextNow(150),
    });
    const parent = await manager.createSession(
      makeInput({
        llmConnectionSlug: 'parent-connection',
        model: 'parent-model',
        thinkingLevel: 'high',
      }),
    );
    const parentTurn = manager
      .sendMessage(parent.id, { turnId: 'parent-turn-preset', text: 'delegate' })
      [Symbol.asyncIterator]();
    await parentTurn.next();
    const [parentRun] = await runStore.listSessionRuns(parent.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const result = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'tool-call-preset',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      subagentId: 'fast-reader',
      prompt: 'inspect cheaply',
    });
    const child = await store.readHeader(result.childSessionId);

    assert.strictEqual(child.llmConnectionSlug, 'worker-connection');
    assert.strictEqual(child.llmConnectionId, '33333333-3333-4333-8333-333333333333');
    assert.strictEqual(child.model, 'worker-model');
    assert.strictEqual(child.thinkingLevel, 'low');
    assert.strictEqual(child.subagentRuntime?.presetId, 'fast-reader');
    assert.strictEqual(child.subagentRuntime?.agentName, 'Fast reader');
    assert.strictEqual(child.connectionLocked, true);
    assert.strictEqual((await manager.listChildAgents(parent.id)).presets[0]?.id, 'fast-reader');

    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('child sessions preserve an explicit no-project association', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    backends.register(
      'ai-sdk',
      (ctx) => new TestBackend(ctx, ctx.header.subagentRuntime ? undefined : parentGate),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(200),
    });
    const parent = await manager.createSession(makeInput({ projectId: null }));
    const parentTurn = manager
      .sendMessage(parent.id, { turnId: 'parent-turn', text: 'keep the parent active' })
      [Symbol.asyncIterator]();
    await parentTurn.next();
    const [parentRun] = await runStore.listSessionRuns(parent.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const child = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'tool-call-no-project',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'inspect without a project',
    });

    assert.strictEqual((await store.readHeader(child.childSessionId)).projectId, null);
    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('hosted child spawn joins the exact in-flight identity and rejects request drift', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    const childGate = makeGate();
    const backendsBySession = new Map<string, TestBackend>();
    backends.register('ai-sdk', (ctx) => {
      const backend = new TestBackend(ctx, ctx.header.subagentRuntime ? childGate : parentGate);
      backendsBySession.set(ctx.sessionId, backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(150),
      messageAuthority: hostedRootAuthority(),
    });
    const parent = await manager.createSession(makeInput());
    const parentTurn = manager
      .sendMessage(parent.id, { turnId: 'parent-turn', text: 'keep parent active' })
      [Symbol.asyncIterator]();
    await parentTurn.next();
    const [parentRun] = await runStore.listSessionRuns(parent.id);
    if (!parentRun) throw new Error('parent run was not recorded');
    const spawnInput = {
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'same-tool-call',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'one durable task',
    } as const;
    const ready = makeGate();
    const first = manager.spawnChildSession(parent.id, {
      ...spawnInput,
      onReady: () => ready.release(),
    });
    await ready.promise;
    const joined = manager.spawnChildSession(parent.id, spawnInput);
    await expectRejects(
      manager.spawnChildSession(parent.id, { ...spawnInput, prompt: 'different work' }),
      /reused for different work/,
    );
    assert.strictEqual((await manager.listChildSessions(parent.id)).length, 1);

    childGate.release();
    const [firstResult, joinedResult] = await Promise.all([first, joined]);
    assert.strictEqual(joinedResult.childSessionId, firstResult.childSessionId);
    assert.strictEqual(joinedResult.runId, firstResult.runId);
    assert.strictEqual((await runStore.listSessionRuns(firstResult.childSessionId)).length, 1);

    const durableRetry = await manager.spawnChildSession(parent.id, spawnInput);
    assert.strictEqual(durableRetry.childSessionId, firstResult.childSessionId);
    assert.strictEqual(durableRetry.runId, firstResult.runId);
    assert.strictEqual(durableRetry.summary, 'ok');
    assert.strictEqual((await manager.listChildSessions(parent.id)).length, 1);
    assert.strictEqual(backendsBySession.get(firstResult.childSessionId)?.sendInputs.length, 1);

    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('starts a metadata-only retry once, notifies once, and rechecks cancellation', async () => {
    const store = new MemorySessionStore();
    const abortController = new AbortController();
    const runStore = new MemoryAgentRunStore({
      beforeRunRead: (sessionId, runId) => {
        if (sessionId === 'session-3' && runId === 'cancelled-child-run') {
          abortController.abort();
        }
      },
    });
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    backends.register(
      'ai-sdk',
      (ctx) => new TestBackend(ctx, ctx.header.subagentRuntime ? undefined : parentGate),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(170),
    });
    const parent = await manager.createSession(makeInput());
    const parentTurn = manager
      .sendMessage(parent.id, { turnId: 'parent-turn', text: 'keep parent active' })
      [Symbol.asyncIterator]();
    await parentTurn.next();
    const [parentRun] = await runStore.listSessionRuns(parent.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const seedMetadataOnlyChild = async (
      toolCallId: string,
      prompt: string,
      initialTurnId: string,
      initialRunId: string,
    ): Promise<SessionHeader> => {
      const requestFingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            1,
            parent.id,
            parentRun.runId,
            parentRun.turnId,
            toolCallId,
            LOCAL_READ_AGENT_PROFILE,
            prompt,
            null,
            null,
          ]),
        )
        .digest('hex');
      return (
        await store.createSubagent(
          makeInput({
            permissionMode: 'explore',
            collaborationMode: 'agent',
            orchestrationMode: 'default',
            subagentParent: {
              kind: 'subagent',
              parentSessionId: parent.id,
              spawnedBy: {
                parentRunId: parentRun.runId,
                parentTurnId: parentRun.turnId,
                toolCallId,
              },
              lifecycle: 'foreground',
            },
            subagentRuntime: {
              schemaVersion: 1,
              definitionVersion: LOCAL_READ_AGENT_DEFINITION.definitionVersion,
              agentId: LOCAL_READ_AGENT_ID,
              agentName: LOCAL_READ_AGENT_DEFINITION.name,
              profile: LOCAL_READ_AGENT_PROFILE,
              systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
              toolNames: [...LOCAL_READ_AGENT_DEFINITION.tools],
              categoryPolicy: {},
            },
            subagentSpawn: {
              schemaVersion: 1,
              requestFingerprint,
              initialTurnId,
              initialRunId,
            },
          }),
        )
      ).header;
    };

    const metadataOnly = await seedMetadataOnlyChild(
      'metadata-only-tool',
      'resume after metadata commit',
      'metadata-only-turn',
      'metadata-only-run',
    );
    let readyCalls = 0;
    const resumed = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'metadata-only-tool',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'resume after metadata commit',
      onReady: () => {
        readyCalls += 1;
      },
    });
    assert.strictEqual(resumed.childSessionId, metadataOnly.id);
    assert.strictEqual(resumed.runId, 'metadata-only-run');
    assert.strictEqual(readyCalls, 1);
    assert.strictEqual((await runStore.listSessionRuns(metadataOnly.id)).length, 1);

    const cancelled = await seedMetadataOnlyChild(
      'cancelled-metadata-tool',
      'must remain cancelled',
      'cancelled-child-turn',
      'cancelled-child-run',
    );
    let cancelledReadyCalls = 0;
    await expectRejects(
      manager.spawnChildSession(parent.id, {
        spawnedBy: {
          parentRunId: parentRun.runId,
          parentTurnId: parentRun.turnId,
          toolCallId: 'cancelled-metadata-tool',
        },
        agentProfile: LOCAL_READ_AGENT_PROFILE,
        prompt: 'must remain cancelled',
        abortSignal: abortController.signal,
        onReady: () => {
          cancelledReadyCalls += 1;
        },
      }),
      /cancelled before its first run/,
    );
    assert.strictEqual(cancelledReadyCalls, 0);
    assert.deepStrictEqual(await runStore.listSessionRuns(cancelled.id), []);

    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('reopens a child from its exact runtime snapshot after the builtin profile changes', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    const contexts: BackendFactoryContext[] = [];
    backends.register('ai-sdk', (ctx) => {
      contexts.push(ctx);
      return new TestBackend(ctx, ctx.header.subagentRuntime ? undefined : parentGate);
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(175),
    });
    const parent = await manager.createSession(makeInput());
    const parentTurn = manager
      .sendMessage(parent.id, { turnId: 'parent-turn', text: 'keep parent active' })
      [Symbol.asyncIterator]();
    await parentTurn.next();
    const [parentRun] = await runStore.listSessionRuns(parent.id);
    if (!parentRun) throw new Error('parent run was not recorded');
    const child = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'snapshot-tool-call',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'first child turn',
    });
    const durablePrompt = (await store.readHeader(child.childSessionId)).subagentRuntime
      ?.systemPrompt;
    if (!durablePrompt) throw new Error('child runtime snapshot was not persisted');

    const originalPrompt = LOCAL_READ_AGENT_DEFINITION.systemPrompt;
    let parentTurnDrained = false;
    const drainParentTurn = async (): Promise<void> => {
      parentGate.release();
      while (!(await parentTurn.next()).done) {}
      parentTurnDrained = true;
    };
    try {
      LOCAL_READ_AGENT_DEFINITION.systemPrompt = 'Changed catalog prompt that must not leak.';
      let refreshSettled = false;
      const refresh = manager.refreshIdleBackends().finally(() => {
        refreshSettled = true;
      });
      await Promise.resolve();
      assert.strictEqual(refreshSettled, false);
      assert.strictEqual(contexts.filter((ctx) => ctx.sessionId === parent.id).length, 1);
      await drainParentTurn();
      await refresh;
      await drain(
        manager.sendMessage(child.childSessionId, {
          turnId: 'child-follow-up',
          text: 'use the durable profile',
        }),
      );
    } finally {
      if (!parentTurnDrained) await drainParentTurn();
      LOCAL_READ_AGENT_DEFINITION.systemPrompt = originalPrompt;
    }

    const childContexts = contexts.filter((ctx) => ctx.sessionId === child.childSessionId);
    assert.strictEqual(childContexts.length, 2);
    assert.strictEqual(childContexts[1]?.systemPrompt, durablePrompt);
    assert.deepStrictEqual(
      childContexts[1]?.tools?.map((tool) => tool.name),
      ['Read', 'Glob', 'Grep'],
    );

    const missingToolManager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob')],
      newId: nextId(),
      now: nextNow(185),
    });
    await expectRejects(
      drain(
        missingToolManager.sendMessage(child.childSessionId, {
          turnId: 'missing-tool-follow-up',
          text: 'must fail closed',
        }),
      ),
      /runtime tool snapshot is unavailable/,
    );
  });

  test('reopens after restart with isolated history, tool activity, usage, and compaction', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    const compactCalls: Array<{ turnId: string; runtimeContextCount: number }> = [];
    const childBackends: LifecycleChildBackend[] = [];
    backends.register('ai-sdk', (ctx) => {
      if (!ctx.header.subagentRuntime) return new TestBackend(ctx, parentGate);
      const backend = new LifecycleChildBackend(ctx, compactCalls);
      childBackends.push(backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(186),
    });
    const parent = await manager.createSession(makeInput());
    const parentTurn = manager
      .sendMessage(parent.id, { turnId: 'parent-turn', text: 'private parent context' })
      [Symbol.asyncIterator]();
    await parentTurn.next();
    const [parentRun] = await runStore.listSessionRuns(parent.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const child = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'restart-observation-tool',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'inspect README before restart',
    });

    // A new manager represents a restarted Runtime Host. It must activate the
    // child through the durable Session header and replay only child history.
    const restarted = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(196),
    });
    await drain(
      restarted.sendMessage(child.childSessionId, {
        turnId: 'child-follow-up',
        text: 'inspect it again after restart',
      }),
    );
    const restartedBackend = childBackends.at(-1);
    const followUpContext = restartedBackend?.sendInputs.at(-1)?.runtimeContext ?? [];
    assert.strictEqual(
      followUpContext.some((event) => event.runId === child.runId),
      true,
    );
    assert.strictEqual(
      followUpContext.some(
        (event) =>
          event.content?.kind === 'text' && event.content.text.includes('private parent context'),
      ),
      false,
    );

    await drain(restarted.compactSession(child.childSessionId, { turnId: 'child-compact' }));
    assert.strictEqual(compactCalls.length, 1);
    assert.strictEqual(compactCalls[0]?.turnId, 'child-compact');

    const childMessages = await restarted.getMessages(child.childSessionId);
    assert.strictEqual(
      childMessages.some((message) => message.type === 'tool_call'),
      true,
    );
    assert.strictEqual(
      childMessages.some((message) => message.type === 'tool_result'),
      true,
    );
    assert.strictEqual(
      childMessages.some((message) => message.type === 'token_usage'),
      true,
    );
    assert.strictEqual(
      childMessages.some(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'child-compact' &&
          message.status === 'completed',
      ),
      true,
    );
    const parentMessages = await restarted.getMessages(parent.id);
    assert.strictEqual(
      parentMessages.some(
        (message) =>
          message.turnId === child.turnId ||
          message.turnId === 'child-follow-up' ||
          message.turnId === 'child-compact',
      ),
      false,
    );

    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('recovers an idempotent retry whose persisted initial run is no longer active', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx, parentGate));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(190),
    });
    const parent = await manager.createSession(makeInput());
    const parentTurn = manager
      .sendMessage(parent.id, { turnId: 'parent-turn', text: 'keep parent active' })
      [Symbol.asyncIterator]();
    await parentTurn.next();
    const [parentRun] = await runStore.listSessionRuns(parent.id);
    if (!parentRun) throw new Error('parent run was not recorded');
    const toolCallId = 'recovery-tool-call';
    const prompt = 'recover this exact request';
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          1,
          parent.id,
          parentRun.runId,
          parentRun.turnId,
          toolCallId,
          LOCAL_READ_AGENT_PROFILE,
          prompt,
          null,
          null,
        ]),
      )
      .digest('hex');
    const { header: child } = await store.createSubagent(
      makeInput({
        name: 'Stale child',
        permissionMode: 'explore',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
        subagentParent: {
          kind: 'subagent',
          parentSessionId: parent.id,
          spawnedBy: {
            parentRunId: parentRun.runId,
            parentTurnId: parentRun.turnId,
            toolCallId,
          },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: LOCAL_READ_AGENT_DEFINITION.definitionVersion,
          agentId: LOCAL_READ_AGENT_ID,
          agentName: LOCAL_READ_AGENT_DEFINITION.name,
          profile: LOCAL_READ_AGENT_PROFILE,
          systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
          toolNames: [...LOCAL_READ_AGENT_DEFINITION.tools],
          categoryPolicy: {},
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint,
          initialTurnId: 'stale-child-turn',
          initialRunId: 'stale-child-run',
        },
      }),
    );
    await seedRunningTurn(store, child.id, 'stale-child-turn');
    await seedRun(
      runStore,
      makeRunHeader({
        sessionId: child.id,
        runId: 'stale-child-run',
        turnId: 'stale-child-turn',
        status: 'running',
        permissionMode: 'explore',
        agentId: LOCAL_READ_AGENT_ID,
        agentName: LOCAL_READ_AGENT_DEFINITION.name,
      }),
      [
        makeRunEvent({
          sessionId: child.id,
          runId: 'stale-child-run',
          turnId: 'stale-child-turn',
          type: 'run_started',
          ts: 191,
        }),
      ],
    );

    const recovered = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId,
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt,
    });
    assert.strictEqual(recovered.childSessionId, child.id);
    assert.strictEqual(recovered.runId, 'stale-child-run');
    assert.strictEqual(recovered.status, 'failed');
    assert.strictEqual(recovered.failureClass, 'app_restarted');
    assert.strictEqual((await manager.listChildSessions(parent.id)).length, 1);

    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('requires the exact parent run to remain active before admitting child work', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(200),
    });
    const parent = await manager.createSession(makeInput());
    await drain(
      manager.sendMessage(parent.id, { turnId: 'parent-turn', text: 'already complete' }),
    );
    const [parentRun] = await runStore.listSessionRuns(parent.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    await expectRejects(
      manager.spawnChildSession(parent.id, {
        spawnedBy: {
          parentRunId: parentRun.runId,
          parentTurnId: parentRun.turnId,
          toolCallId: 'tool-call-1',
        },
        agentProfile: LOCAL_READ_AGENT_PROFILE,
        prompt: 'must not start',
      }),
      /parent run is not active/,
    );
    assert.deepStrictEqual(await manager.listChildSessions(parent.id), []);
  });

  test('admits child work through an external parent-run authority', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    let externalParent:
      | {
          sessionId: string;
          runId: string;
          turnId: string;
        }
      | undefined;
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      isParentRunActive: (sessionId, runId, turnId) =>
        externalParent !== undefined &&
        externalParent.sessionId === sessionId &&
        externalParent.runId === runId &&
        externalParent.turnId === turnId,
      newId: nextId(),
      now: nextNow(250),
    });
    const parent = await manager.createSession(makeInput());
    await drain(manager.sendMessage(parent.id, { turnId: 'parent-turn', text: 'parent' }));
    const [parentRun] = await runStore.listSessionRuns(parent.id);
    if (!parentRun) throw new Error('parent run was not recorded');
    externalParent = {
      sessionId: parent.id,
      runId: parentRun.runId,
      turnId: parentRun.turnId,
    };

    const child = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'tool-call-1',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'inspect',
    });

    assert.strictEqual(child.status, 'completed');
    assert.strictEqual(child.childSessionId === parent.id, false);
  });

  test('child stop is isolated while parent stop reaches every foreground child session', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    const childGates = [makeGate(), makeGate()];
    let childGateIndex = 0;
    const backendsBySession = new Map<string, TestBackend>();
    backends.register('ai-sdk', (ctx) => {
      const gate = ctx.header.subagentRuntime ? childGates[childGateIndex++] : parentGate;
      const backend = new TestBackend(ctx, gate);
      backendsBySession.set(ctx.sessionId, backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(300),
    });
    const parent = await manager.createSession(makeInput());
    const parentTurn = manager
      .sendMessage(parent.id, { turnId: 'parent-turn', text: 'coordinate children' })
      [Symbol.asyncIterator]();
    await parentTurn.next();
    const [parentRun] = await runStore.listSessionRuns(parent.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const childOneStarted = makeGate();
    let childOneId = '';
    const childOne = manager.spawnChildSession(parent.id, {
      name: 'Child one',
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'tool-call-1',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'first child',
      onReady: ({ childSessionId }) => {
        childOneId = childSessionId;
      },
      onEvent: (event) => {
        if (event.type === 'text_delta') childOneStarted.release();
      },
    });
    await childOneStarted.promise;

    const childTwoStarted = makeGate();
    let childTwoId = '';
    const childTwo = manager.spawnChildSession(parent.id, {
      name: 'Child two',
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'tool-call-2',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'second child',
      onReady: ({ childSessionId }) => {
        childTwoId = childSessionId;
      },
      onEvent: (event) => {
        if (event.type === 'text_delta') childTwoStarted.release();
      },
    });
    await childTwoStarted.promise;

    await manager.stopSession(childOneId, { source: 'stop_button' });
    assert.strictEqual(backendsBySession.get(childOneId)?.stopCalls, 1);
    assert.strictEqual(backendsBySession.get(childTwoId)?.stopCalls, 0);
    assert.strictEqual(backendsBySession.get(parent.id)?.stopCalls, 0);
    assert.strictEqual((await runStore.readRun(parent.id, parentRun.runId)).status, 'running');

    await manager.stopSession(parent.id, { source: 'stop_button' });
    assert.strictEqual(backendsBySession.get(parent.id)?.stopCalls, 1);
    assert.strictEqual(backendsBySession.get(childOneId)?.stopCalls, 1);
    assert.strictEqual(backendsBySession.get(childTwoId)?.stopCalls, 1);

    parentGate.release();
    for (const gate of childGates) gate.release();
    while (!(await parentTurn.next()).done) {}
    const [childOneResult, childTwoResult] = await Promise.all([childOne, childTwo]);
    assert.strictEqual(childOneResult.status, 'cancelled');
    assert.strictEqual(childTwoResult.status, 'cancelled');
  });

  test('startup recovery repairs an interrupted child inline run only in the child session', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(400),
    });
    const parent = await manager.createSession(makeInput());
    await store.appendMessage(parent.id, {
      type: 'system_note',
      id: 'parent-marker',
      ts: 1,
      kind: 'session_start',
      data: { marker: 'parent stays untouched' },
    });
    const child = await manager.createSession(
      makeInput({
        name: 'Interrupted child',
        status: 'running',
        permissionMode: 'explore',
        subagentParent: {
          kind: 'subagent',
          parentSessionId: parent.id,
          spawnedBy: {
            parentRunId: 'parent-run',
            parentTurnId: 'parent-turn',
            toolCallId: 'tool-call',
          },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: 1,
          agentId: LOCAL_READ_AGENT_ID,
          agentName: 'Local Read',
          profile: LOCAL_READ_AGENT_PROFILE,
          systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
          toolNames: ['Read', 'Glob', 'Grep'],
          categoryPolicy: { read: 'allow' },
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: 'a'.repeat(64),
          initialTurnId: 'child-turn',
          initialRunId: 'child-run',
        },
      }),
    );
    await seedRunningTurn(store, child.id, 'child-turn');
    await seedRun(
      runStore,
      makeRunHeader({
        sessionId: child.id,
        runId: 'child-run',
        turnId: 'child-turn',
        status: 'running',
        permissionMode: 'explore',
        agentId: LOCAL_READ_AGENT_ID,
        agentName: 'Local Read',
      }),
      [
        makeRunEvent({
          sessionId: child.id,
          runId: 'child-run',
          turnId: 'child-turn',
          type: 'run_started',
          ts: 11,
        }),
        makeRunEvent({
          sessionId: child.id,
          runId: 'child-run',
          turnId: 'child-turn',
          type: 'model_stream_started',
          ts: 12,
        }),
      ],
    );
    const parentMessagesBefore = await store.readMessages(parent.id);

    const recovered = await manager.recoverInterruptedSessions();

    assert.deepStrictEqual(recovered, [child.id]);
    const recoveredRun = await runStore.readRun(child.id, 'child-run');
    assert.strictEqual(recoveredRun.parentRunId, undefined);
    assert.strictEqual(isSessionInlineRun(recoveredRun), true);
    assert.strictEqual(recoveredRun.status, 'failed');
    assert.strictEqual(recoveredRun.failureClass, 'app_restarted');
    assert.strictEqual(
      (await store.readMessages(child.id)).some(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'child-turn' &&
          message.status === 'failed',
      ),
      true,
    );
    assert.deepStrictEqual(await store.readMessages(parent.id), parentMessagesBefore);
  });
});

describe('SessionManager manual compaction and quiescent session changes', () => {
  test('runs backend history compaction as a runtime turn and persists diagnostics', async () => {
    const store = new MemorySessionStore();
    const runStore = new OrderingAgentRunStore();
    const backends = new BackendRegistry();
    const compactCalls: Array<{ turnId: string; runtimeContextCount: number }> = [];
    backends.register('ai-sdk', (ctx) => new CompactingTestBackend(ctx, compactCalls));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(10_000),
    });
    const session = await manager.createSession(
      makeInput({ permissionMode: 'bypass', llmConnectionId: 'connection-compact' }),
    );

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));
    const sourceRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-1',
    );
    assert.ok(sourceRun);
    runStore.operations = [];
    const events = await collectSessionEvents(
      manager.compactSession(session.id, { turnId: 'turn-compact' }),
    );

    assert.deepStrictEqual(compactCalls, [
      {
        turnId: 'turn-compact',
        runtimeContextCount: 3,
        sourceRoutes: [
          {
            runId: sourceRun.runId,
            connectionId: sourceRun.llmConnectionId,
            modelId: sourceRun.modelId,
          },
        ],
      },
    ]);
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ['token_usage', 'complete'],
    );
    const usage = events[0];
    if (usage?.type !== 'token_usage') throw new Error('expected token_usage');
    assert.strictEqual(usage.contextBudget?.compactionDecisions?.[0]?.decision, 'replaced');
    const complete = events[1];
    if (complete?.type !== 'complete') throw new Error('expected complete');
    assert.strictEqual(complete.contextCompactionOutcome?.kind, 'compacted');

    const messages = await store.readMessages(session.id);
    assert.strictEqual(
      messages.some((message) => message.type === 'user' && message.text.includes('compact')),
      false,
    );
    assert.strictEqual(
      messages.some(
        (message) => message.type === 'token_usage' && message.turnId === 'turn-compact',
      ),
      true,
    );
    assert.strictEqual(
      messages.some(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'turn-compact' &&
          message.status === 'completed',
      ),
      true,
    );

    const compactRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-compact',
    );
    assert.strictEqual(compactRun?.status, 'completed');
    assert.deepStrictEqual(runStore.operations, ['terminalRuntimeEvent', 'completedRunHeader']);
    assert.strictEqual(
      (await runStore.readRuntimeEvents(session.id, compactRun!.runId)).some(
        (event) => event.actions?.stateDelta?.contextCompactionOutcome,
      ),
      true,
    );
    await manager.stopSession(session.id, { source: 'stop_button' });
  });

  test('manual compaction settles one canonical record for the run the kernel opened', async () => {
    // `sessions:compact` and CLI `/compact` both land here. The call has no
    // send to inherit a run from, so the kernel states the run it opened and
    // the record must carry it — otherwise a real, billed summarization is
    // silently unmetered (#1679).
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const modelCalls: ModelCallAttempt[] = [];
    const summarizerModel = new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            type: 'text',
            // Structured so it passes the summarizer's checkpoint validation
            // (#3029) while keeping the sentinel greppable.
            text: '## Goal\nMANUAL_COMPACT_SUMMARY\n\n## Progress\n- done\n\n## Next Steps\n1. continue\n\n## Critical Context\n- (none)',
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 41, noCache: 41, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 9, text: 9, reasoning: 0 },
          raw: { input_tokens: 41, output_tokens: 9 },
        },
        warnings: [],
      },
    });
    backends.register('ai-sdk', (ctx) =>
      createTestAiSdkBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
        appendMessage: async () => {},
        connection: {
          slug: 'mock-main',
          providerType: 'anthropic',
          defaultModel: 'mock-model-id',
        },
        apiKey: 'sk-test',
        modelId: 'mock-model-id',
        modelFactory: () =>
          new MockLanguageModelV4({
            doStream: async () => ({
              stream: simulateReadableStream({
                chunks: [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'text-1' },
                  { type: 'text-delta', id: 'text-1', delta: 'ok '.repeat(80) },
                  { type: 'text-end', id: 'text-1' },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'stop' },
                    usage: {
                      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 10, text: 10, reasoning: 0 },
                    },
                  },
                ] as LanguageModelV4StreamPart[],
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
            }),
          }),
        tools: [],
        newId: nextId(),
        now: nextNow(1),
        contextBudget: {
          name: 'manual-compact-accounting',
          charsPerToken: 1,
        },
        summarizeHistoryCompact: buildLlmHistorySummarizer({
          resolveModel: () => summarizerModel,
        }),
        recordHistoryCompactCheckpoint: () => {},
        recordModelCallAttempt: ({ attempt }) => {
          modelCalls.push(attempt);
        },
      }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(13_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'first '.repeat(400) }));
    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));
    await drain(manager.compactSession(session.id, { turnId: 'turn-compact' }));

    const compactRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-compact',
    );
    assert.ok(compactRun, 'the kernel opens a run for a manual compaction');
    const compactions = modelCalls
      .map((attempt) => decodeModelCallAttempt(attempt))
      .filter((attempt) => attempt.callKind === 'history_compact');
    assert.equal(compactions.length, 1, 'one manual compaction is one record');
    assert.equal(
      compactions[0]?.runId,
      compactRun.runId,
      'attributed to the run the kernel opened, not to whatever ran last',
    );
    assert.equal(compactions[0]?.turnId, 'turn-compact');
    assert.equal(compactions[0]?.inputTokens, 41);
    assert.equal(compactions[0]?.usageBasis, 'reported');
    await manager.stopSession(session.id, { source: 'stop_button' });
  });

  test('persists one visible warning when manual compaction fails open', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new FailOpenCompactingBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));
    await drain(manager.compactSession(session.id, { turnId: 'turn-compact' }));

    const warnings = (await store.readMessages(session.id)).filter(
      (message) =>
        message.type === 'system_note' &&
        message.turnId === 'turn-compact' &&
        message.kind === 'context_compaction_failed_open',
    );
    assert.strictEqual(warnings.length, 1);
  });

  test('manual compaction stopped before backend start does not write compact artifacts', async () => {
    const store = new MemorySessionStore();
    const readGate = makeGate();
    const readStarted = makeGate();
    let blockPriorRead = false;
    const runStore = new MemoryAgentRunStore({
      beforeRuntimeEventRead: async () => {
        if (!blockPriorRead) return;
        readStarted.release();
        await readGate.promise;
      },
    });
    const backends = new BackendRegistry();
    const compactCalls: Array<{ turnId: string; runtimeContextCount: number }> = [];
    backends.register('ai-sdk', (ctx) => new CompactingTestBackend(ctx, compactCalls));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(15_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));
    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    blockPriorRead = true;
    const compactPromise = collectSessionEvents(
      manager.compactSession(session.id, { turnId: 'turn-compact' }),
    );
    await readStarted.promise;
    let stopSettled = false;
    const stop = manager.stopSession(session.id, { source: 'stop_button' }).finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(stopSettled, false);
    assert.deepStrictEqual(compactCalls, []);

    readGate.release();
    await stop;
    const compactEvents = await compactPromise.catch(() => []);

    assert.deepStrictEqual(compactCalls, []);
    assert.strictEqual(
      compactEvents.some((event) => event.type === 'token_usage'),
      false,
    );
    const compactRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-compact',
    );
    assert.strictEqual(compactRun?.status, 'cancelled');
  });

  test('cold manual compaction normalizes only its execution cancellation reason', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const factoryStarts = new Map<string, ReturnType<typeof makeGate>>();
    const factoryModes = new Map<string, 'execution_cancellation' | 'abort_error'>();
    backends.register('ai-sdk', async (ctx) => {
      const started = factoryStarts.get(ctx.sessionId);
      const mode = factoryModes.get(ctx.sessionId);
      if (!started || !mode) throw new Error('cold compact factory was not configured');
      const signal = ctx.abortSignal;
      if (!signal) throw new Error('cold compact factory did not receive an abort signal');
      started.release();
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      if (mode === 'abort_error') {
        const error = new Error('cold compact factory timed out');
        error.name = 'AbortError';
        throw error;
      }
      throw signal.reason;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(15_500),
    });
    const cancelledSession = await manager.createSession(makeInput({ permissionMode: 'bypass' }));
    const abortErrorSession = await manager.createSession(makeInput({ permissionMode: 'bypass' }));
    const cancelledStart = makeGate();
    const abortErrorStart = makeGate();
    factoryStarts.set(cancelledSession.id, cancelledStart);
    factoryStarts.set(abortErrorSession.id, abortErrorStart);
    factoryModes.set(cancelledSession.id, 'execution_cancellation');
    factoryModes.set(abortErrorSession.id, 'abort_error');

    const cancelledCompact = collectSessionEvents(
      manager.compactSession(cancelledSession.id, { turnId: 'compact-cancelled-factory' }),
    );
    await cancelledStart.promise;
    const cancelledStop = manager.stopSession(cancelledSession.id, {
      source: 'stop_button',
    });
    const [cancelledEvents] = await Promise.all([cancelledCompact, cancelledStop]);
    assert.deepStrictEqual(cancelledEvents, []);

    const abortErrorCompact = collectSessionEvents(
      manager.compactSession(abortErrorSession.id, { turnId: 'compact-abort-error-factory' }),
    );
    await abortErrorStart.promise;
    const abortErrorRejection = assert.rejects(abortErrorCompact, /cold compact factory timed out/);
    const abortErrorStop = manager.stopSession(abortErrorSession.id, {
      source: 'stop_button',
    });
    await Promise.all([abortErrorRejection, abortErrorStop]);

    const [cancelledRun] = await runStore.listSessionRuns(cancelledSession.id);
    const [abortErrorRun] = await runStore.listSessionRuns(abortErrorSession.id);
    assert.strictEqual(cancelledRun?.status, 'cancelled');
    assert.strictEqual(abortErrorRun?.status, 'cancelled');
  });

  test('stopSession waits for compaction blocked before Run reservation', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const compactCalls: Array<{ turnId: string; runtimeContextCount: number }> = [];
    backends.register('ai-sdk', (ctx) => new CompactingTestBackend(ctx, compactCalls));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(17_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));
    const readStarted = makeGate();
    const releaseRead = makeGate();
    store.nextReadHeaderGate = { started: readStarted, release: releaseRead };

    const compact = collectSessionEvents(
      manager.compactSession(session.id, { turnId: 'turn-compact-pending' }),
    );
    await readStarted.promise;
    let stopSettled = false;
    const stop = manager.stopSession(session.id, { source: 'stop_button' }).finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(stopSettled, false);
    assert.deepStrictEqual(compactCalls, []);

    releaseRead.release();
    await stop;
    await compact.catch(() => []);

    assert.deepStrictEqual(compactCalls, []);
    const compactRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-compact-pending',
    );
    assert.strictEqual(compactRun?.status, 'cancelled');
  });

  test('manual compaction is stopped through the active runtime run lifecycle', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const compactGate = makeGate();
    const compactStarted = makeGate();
    let compactingBackend: BlockingCompactBackend | undefined;
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new BlockingCompactBackend(ctx, {
          compactGate,
          onCompactStart: (backend) => {
            compactingBackend = backend;
            compactStarted.release();
          },
        }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(20_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));
    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const compactPromise = collectSessionEvents(
      manager.compactSession(session.id, { turnId: 'turn-compact' }),
    );
    await compactStarted.promise;
    await manager.stopSession(session.id, { source: 'stop_button' });
    compactGate.release();
    const compactEvents = await compactPromise.catch(() => []);

    assert.strictEqual(compactingBackend?.stopCalls, 1);
    assert.strictEqual(
      compactEvents.some((event) => event.type === 'token_usage'),
      false,
    );
    const compactRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-compact',
    );
    assert.strictEqual(compactRun?.status, 'cancelled');
  });

  test('compactSession rejects while a turn is running and writes no compact artifacts', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const sendGate = makeGate();
    const turnStarted = makeGate();
    const compactCalls: Array<{ turnId: string; runtimeContextCount: number }> = [];
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) => new ActiveTurnBackend(ctx, { turnStarted, sendGate, compactCalls }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(25_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    const sendPromise = (async () => {
      for await (const _event of manager.sendMessage(session.id, {
        turnId: 'turn-1',
        text: 'hi',
      })) {
        // turn held open at the send gate; drained after the compact assertion
      }
    })();
    await turnStarted.promise;

    const compactError = await collectSessionEvents(
      manager.compactSession(session.id, { turnId: 'turn-compact' }),
    ).catch((error: unknown) => error);
    assert.strictEqual(compactError instanceof RuntimeContextCompactError, true);
    assert.strictEqual((compactError as RuntimeContextCompactError).code, 'session_busy');

    assert.deepStrictEqual(compactCalls, []);
    const messages = await store.readMessages(session.id);
    assert.strictEqual(
      messages.some((message) => message.turnId === 'turn-compact'),
      false,
    );
    const compactRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-compact',
    );
    assert.strictEqual(compactRun, undefined);

    sendGate.release();
    await sendPromise;
  });

  test('configuration transitions fence active runs and unavailable resource side effects', async () => {
    const store = new VersionedConfigurationMemorySessionStore();
    const kernel = new DelegatingRuntimeKernel();
    const manager = new SessionManager({
      store,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(26_400),
      runtimeKernel: kernel,
    });
    const session = await manager.createSession(
      makeInput({ permissionMode: 'bypass', orchestrationMode: 'default' }),
    );
    const baseConfiguration = {
      backend: session.backend,
      llmConnectionId: 'test-connection-id',
      llmConnectionSlug: session.llmConnectionSlug,
      connectionLocked: true,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      permissionMode: session.permissionMode,
      collaborationMode: session.collaborationMode ?? 'agent',
      orchestrationMode: 'graph' as const,
    };

    kernel.activeRuns = true;
    await assert.rejects(
      manager.transitionSessionConfiguration(session.id, {
        expectedRevision: 1,
        clearConnectionBlock: false,
        configuration: baseConfiguration,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SessionConfigurationTransitionError);
        assert.equal(error.code, 'session_busy');
        return true;
      },
    );
    assert.deepEqual(kernel.disposed, []);

    kernel.activeRuns = false;
    const committed = await manager.transitionSessionConfiguration(session.id, {
      expectedRevision: 1,
      clearConnectionBlock: false,
      configuration: baseConfiguration,
    });
    assert.equal(committed.revision, 2);
    assert.equal(committed.header.orchestrationMode, 'graph');
    assert.deepEqual(kernel.disposed, [session.id]);

    await assert.rejects(
      manager.transitionSessionConfiguration(session.id, {
        expectedRevision: 2,
        clearConnectionBlock: false,
        configuration: {
          ...baseConfiguration,
          permissionMode: 'explore',
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof SessionConfigurationTransitionError);
        assert.equal(error.code, 'operation_unavailable');
        return true;
      },
    );
    assert.deepEqual(kernel.disposed, [session.id]);
  });

  test('configuration transitions clear a connection block only on explicit Host authority', async () => {
    const store = new VersionedConfigurationMemorySessionStore();
    const manager = new SessionManager({
      store,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(26_425),
    });
    const session = await manager.createSession(makeInput());
    await store.updateHeader(session.id, {
      status: 'blocked',
      blockedReason: 'NO_REAL_CONNECTION',
    });
    const configuration = {
      backend: session.backend,
      llmConnectionId: 'test-connection-id',
      llmConnectionSlug: session.llmConnectionSlug,
      connectionLocked: true,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      permissionMode: session.permissionMode,
      collaborationMode: session.collaborationMode ?? 'agent',
      orchestrationMode: session.orchestrationMode ?? 'default',
    };

    const preserved = await manager.transitionSessionConfiguration(session.id, {
      expectedRevision: 1,
      clearConnectionBlock: false,
      configuration,
    });
    assert.equal(preserved.header.blockedReason, 'NO_REAL_CONNECTION');
    assert.equal(preserved.header.status, 'blocked');

    const recovered = await manager.transitionSessionConfiguration(session.id, {
      expectedRevision: 2,
      clearConnectionBlock: true,
      configuration,
    });
    assert.equal(recovered.header.blockedReason, undefined);
    assert.equal(recovered.header.status, 'active');
  });

  test('workspace relocation uses the same quiescent revision fence as execution configuration', async () => {
    const store = new VersionedConfigurationMemorySessionStore();
    const kernel = new DelegatingRuntimeKernel();
    const resourceCalls: string[] = [];
    const manager = new SessionManager({
      store,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(26_425),
      runtimeKernel: kernel,
      shellRuns: {
        async terminateSession(sessionId: string) {
          resourceCalls.push(`terminate:${sessionId}`);
          return { sessionId, token: Symbol('relocate') };
        },
        async commitSessionClose() {
          resourceCalls.push('commit');
        },
        rollbackSessionClose() {
          resourceCalls.push('rollback');
        },
        resumeSession(sessionId: string) {
          resourceCalls.push(`resume:${sessionId}`);
        },
      } as never,
    });
    const session = await manager.createSession(makeInput({ cwd: '/workspace/old' }));

    kernel.activeRuns = true;
    await assert.rejects(
      manager.relocateSessionWorkspace(session.id, {
        expectedRevision: 1,
        cwd: '/workspace/new',
      }),
      (error: unknown) => {
        assert.ok(error instanceof SessionConfigurationTransitionError);
        assert.equal(error.code, 'session_busy');
        return true;
      },
    );

    kernel.activeRuns = false;
    const committed = await manager.relocateSessionWorkspace(session.id, {
      expectedRevision: 1,
      cwd: '/workspace/new',
      projectId: 'project-2',
    });
    assert.equal(committed.revision, 2);
    assert.equal(committed.header.cwd, '/workspace/new');
    assert.equal(committed.header.projectId, 'project-2');
    assert.deepEqual(kernel.disposed, [session.id]);
    assert.deepEqual(resourceCalls, [`terminate:${session.id}`, 'commit', `resume:${session.id}`]);

    await assert.rejects(
      manager.relocateSessionWorkspace(session.id, {
        expectedRevision: 1,
        cwd: '/workspace/stale',
      }),
      (error: unknown) => {
        assert.ok(error instanceof SessionConfigurationRevisionConflictError);
        assert.equal(error.actualRevision, 2);
        return true;
      },
    );
    assert.equal((await store.readHeader(session.id)).cwd, '/workspace/new');
  });

  test('configuration transitions reject a claimed turn without waiting for it to settle', async () => {
    const store = new VersionedConfigurationMemorySessionStore();
    const readStarted = makeGate();
    const releaseRead = makeGate();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      backends,
      newId: nextId(),
      now: nextNow(26_450),
    });
    const session = await manager.createSession(makeInput({ orchestrationMode: 'default' }));
    store.nextReadHeaderGate = { started: readStarted, release: releaseRead };

    const turn = drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'start' }));
    await readStarted.promise;
    const transitionResult = await manager
      .transitionSessionConfiguration(session.id, {
        expectedRevision: 1,
        clearConnectionBlock: false,
        configuration: {
          backend: session.backend,
          llmConnectionId: 'test-connection-id',
          llmConnectionSlug: session.llmConnectionSlug,
          connectionLocked: true,
          model: session.model,
          thinkingLevel: session.thinkingLevel,
          permissionMode: session.permissionMode,
          collaborationMode: session.collaborationMode ?? 'agent',
          orchestrationMode: 'graph',
        },
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    assert.equal(transitionResult.ok, false);
    if (transitionResult.ok) assert.fail('Configuration transition unexpectedly committed');
    assert.ok(transitionResult.error instanceof SessionConfigurationTransitionError);
    assert.equal(transitionResult.error.code, 'session_busy');
    assert.equal((await store.readHeader(session.id)).orchestrationMode, 'default');

    releaseRead.release();
    await turn;
  });

  test('a claimed turn waits for an in-flight session mutation before reading its header', async () => {
    const store = new VersionedConfigurationMemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const updateStarted = makeGate();
    const releaseUpdate = makeGate();
    const activatedModels: string[] = [];
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => {
      activatedModels.push(ctx.header.model);
      return new TestBackend(ctx);
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(26_475),
    });
    const session = await manager.createSession(makeInput({ model: 'old-model' }));
    store.nextConfigurationUpdateGate = {
      started: updateStarted,
      release: releaseUpdate,
    };
    const transition = manager.transitionSessionConfiguration(session.id, {
      expectedRevision: 1,
      clearConnectionBlock: false,
      configuration: {
        backend: session.backend,
        llmConnectionId: 'test-connection-id',
        llmConnectionSlug: session.llmConnectionSlug,
        connectionLocked: true,
        model: 'new-model',
        thinkingLevel: session.thinkingLevel,
        permissionMode: session.permissionMode,
        collaborationMode: session.collaborationMode ?? 'agent',
        orchestrationMode: session.orchestrationMode ?? 'default',
      },
    });
    await updateStarted.promise;

    const turn = drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'start' }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(activatedModels, []);
    assert.equal((await store.readHeader(session.id)).transcriptLedgerVersion, undefined);

    releaseUpdate.release();
    await transition;
    await turn;
    assert.deepEqual(activatedModels, ['new-model']);
    assert.equal((await store.readHeader(session.id)).transcriptLedgerVersion, 1);
  });

  test('backend refresh propagates delayed disposal failure after an active turn settles', async () => {
    const store = new MemorySessionStore();
    const sendGate = makeGate();
    const turnStarted = makeGate();
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new (class extends ActiveTurnBackend {
          override async dispose(): Promise<void> {
            throw new Error('injected delayed disposal failure');
          }
        })(ctx, { turnStarted, sendGate, compactCalls: [] }),
    );
    const manager = new SessionManager({
      store,
      backends,
      newId: nextId(),
      now: nextNow(26_500),
    });
    const session = await manager.createSession(makeInput());
    const firstTurn = drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hi' }));
    await turnStarted.promise;

    const refreshResult = manager.refreshIdleBackends().then(
      () => undefined,
      (error: unknown) => error,
    );
    sendGate.release();
    await firstTurn;

    const refreshError = await refreshResult;
    assert.strictEqual(refreshError instanceof Error, true);
    assert.strictEqual((refreshError as Error).message, 'injected delayed disposal failure');
  });

  test('backend refresh joins an in-flight best-effort disposal and observes its failure', async () => {
    const store = new MemorySessionStore();
    const disposeStarted = makeGate();
    const releaseDispose = makeGate();
    let disposeCalls = 0;
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new (class extends TestBackend {
          override async dispose(): Promise<void> {
            disposeCalls += 1;
            disposeStarted.release();
            await releaseDispose.promise;
            throw new Error('injected concurrent disposal failure');
          }
        })(ctx),
    );
    const newId = nextId();
    const now = nextNow(26_750);
    const runtimeKernel = new RuntimeKernel({ store, backends, newId, now });
    const manager = new SessionManager({
      store,
      backends,
      runtimeKernel,
      newId,
      now,
    });
    const session = await manager.createSession(makeInput());
    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'cache me' }));

    const bestEffort = runtimeKernel.invalidateBackend(session.id);
    await disposeStarted.promise;
    let strictSettled = false;
    const strictResult = manager.refreshIdleBackends().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    void strictResult.finally(() => {
      strictSettled = true;
    });
    await Promise.resolve();
    assert.strictEqual(strictSettled, false);

    releaseDispose.release();
    await bestEffort;
    const strict = await strictResult;

    assert.strictEqual(strict.ok, false);
    if (strict.ok) throw new Error('Strict refresh unexpectedly succeeded');
    assert.strictEqual(strict.error instanceof Error, true);
    assert.strictEqual((strict.error as Error).message, 'injected concurrent disposal failure');
    assert.strictEqual(disposeCalls, 1);
  });

  test('backend activation waits for disposal and a later mutation invalidates its replacement', async () => {
    const store = new MemorySessionStore();
    const firstDisposeStarted = makeGate();
    const releaseFirstDispose = makeGate();
    const replacementPreBuildReached = makeGate();
    const releaseReplacementPreBuild = makeGate();
    let replacementCheckpointArmed = true;
    const runStore = new MemoryAgentRunStore({
      beforeRuntimeEventAppend: async (_sessionId, _runId, event) => {
        if (!replacementCheckpointArmed || event.turnId !== 'turn-b') return;
        replacementCheckpointArmed = false;
        replacementPreBuildReached.release();
        await releaseReplacementPreBuild.promise;
      },
    });
    const { runBackendActivation, runMutation } = makeTestRuntimePolicyGate();
    let builds = 0;
    const disposed: number[] = [];
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => {
      const generation = ++builds;
      return new (class extends TestBackend {
        override async dispose(): Promise<void> {
          disposed.push(generation);
          if (generation === 1) {
            firstDisposeStarted.release();
            await releaseFirstDispose.promise;
          }
        }
      })(ctx);
    });
    const newId = nextId();
    const now = nextNow(26_875);
    const runtimeKernel = new RuntimeKernel({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId,
      now,
      runBackendActivation,
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      runtimeKernel,
      newId,
      now,
    });
    const session = await manager.createSession(makeInput());
    await drain(manager.sendMessage(session.id, { turnId: 'turn-a', text: 'build A' }));

    const bestEffort = runtimeKernel.invalidateBackend(session.id);
    await firstDisposeStarted.promise;
    const replacementTurn = drain(
      manager.sendMessage(session.id, { turnId: 'turn-b', text: 'build B' }),
    );
    await replacementPreBuildReached.promise;
    releaseReplacementPreBuild.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(builds, 1);
    const mutation = runMutation(() => manager.refreshIdleBackends());

    releaseFirstDispose.release();
    await bestEffort;
    await replacementTurn;
    await mutation;

    assert.strictEqual(builds, 2);
    assert.deepStrictEqual(disposed, [1, 2]);
    await drain(manager.sendMessage(session.id, { turnId: 'turn-c', text: 'build C' }));
    assert.strictEqual(builds, 3);
  });

  test('backend refresh invalidates only cached sessions without listing persisted history', async () => {
    const store = new MemorySessionStore();
    const disposed: string[] = [];
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new (class extends TestBackend {
          override async dispose(): Promise<void> {
            disposed.push(this.sessionId);
          }
        })(ctx),
    );
    const manager = new SessionManager({
      store,
      backends,
      newId: nextId(),
      now: nextNow(27_000),
    });
    const cached = await manager.createSession(makeInput());
    await manager.createSession(makeInput());
    await drain(manager.sendMessage(cached.id, { turnId: 'turn-1', text: 'cache me' }));
    store.list = async () => {
      throw new Error('refresh must not list persisted sessions');
    };

    await manager.refreshIdleBackends();

    assert.deepStrictEqual(disposed, [cached.id]);
  });
});

describe('SessionManager permission mode updates', () => {
  test('revokes background shell authority before narrowing Auto to Explore', async () => {
    const store = new AtomicBoundaryMemorySessionStore();
    const calls: string[] = [];
    const manager = new SessionManager({
      store,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(985),
      shellRuns: {
        async terminateSession(sessionId: string) {
          calls.push(`terminate:${sessionId}`);
          return { sessionId, token: Symbol('test') };
        },
        async commitSessionClose() {
          calls.push('commit');
        },
        rollbackSessionClose() {
          calls.push('rollback');
        },
        resumeSession(sessionId: string) {
          calls.push(`resume:${sessionId}`);
        },
      } as never,
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));

    await manager.setPermissionMode(session.id, 'explore');

    assert.deepStrictEqual(calls, [`terminate:${session.id}`, 'commit', `resume:${session.id}`]);
    const boundary = await store.readExecutionBoundary(session.id);
    assert.strictEqual(boundary.kind, 'managed');
    if (boundary.kind === 'managed') assert.strictEqual(boundary.profile.name, 'read-only');
  });

  test('revokes descendant background shell authority through the direct boundary API', async () => {
    const store = new AtomicBoundaryMemorySessionStore();
    const calls: string[] = [];
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(990),
      shellRuns: {
        async terminateSession(sessionId: string) {
          calls.push(`terminate:${sessionId}`);
          return { sessionId, token: Symbol('test') };
        },
        async commitSessionClose() {
          calls.push('commit');
        },
        rollbackSessionClose() {
          calls.push('rollback');
        },
        resumeSession(sessionId: string) {
          calls.push(`resume:${sessionId}`);
        },
      } as never,
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));
    const child = await manager.createSession(
      makeInput({
        permissionMode: 'bypass',
        subagentParent: {
          kind: 'subagent',
          parentSessionId: session.id,
          spawnedBy: {
            parentRunId: 'parent-run',
            parentTurnId: 'parent-turn',
            toolCallId: 'child-tool',
          },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: LOCAL_READ_AGENT_DEFINITION.definitionVersion,
          agentId: LOCAL_READ_AGENT_ID,
          agentName: LOCAL_READ_AGENT_DEFINITION.name,
          profile: LOCAL_READ_AGENT_PROFILE,
          systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
          toolNames: ['Read', 'Glob', 'Grep'],
          categoryPolicy: {},
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: 'a'.repeat(64),
          initialTurnId: 'child-turn',
          initialRunId: 'child-run',
        },
      }),
    );
    const grandchild = await manager.createSession(
      makeInput({
        permissionMode: 'bypass',
        subagentParent: {
          kind: 'subagent',
          parentSessionId: child.id,
          spawnedBy: {
            parentRunId: 'child-run',
            parentTurnId: 'child-turn',
            toolCallId: 'grandchild-tool',
          },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: 1,
          definitionVersion: LOCAL_READ_AGENT_DEFINITION.definitionVersion,
          agentId: LOCAL_READ_AGENT_ID,
          agentName: LOCAL_READ_AGENT_DEFINITION.name,
          profile: LOCAL_READ_AGENT_PROFILE,
          systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
          toolNames: ['Read', 'Glob', 'Grep'],
          categoryPolicy: {},
        },
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: 'b'.repeat(64),
          initialTurnId: 'grandchild-turn',
          initialRunId: 'grandchild-run',
        },
      }),
    );
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent' }));
    await drain(manager.sendMessage(child.id, { turnId: 'child-turn', text: 'child' }));
    await drain(
      manager.sendMessage(grandchild.id, { turnId: 'grandchild-turn', text: 'grandchild' }),
    );
    store.disposeCount = 0;

    await manager.setExecutionBoundaryKind(session.id, 'managed');

    assert.deepStrictEqual(calls, [
      `terminate:${session.id}`,
      `terminate:${child.id}`,
      `terminate:${grandchild.id}`,
      'commit',
      'commit',
      'commit',
      `resume:${session.id}`,
    ]);
    assert.strictEqual(store.disposeCount, 3);
  });

  test('keeps mode changes blocked until all overlapping turns finish', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const firstGate = makeGate();
    const secondGate = makeGate();
    const gates = [firstGate, secondGate];
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx, gates.shift()));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(4_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));

    const first = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: 'first' })
      [Symbol.asyncIterator]();
    await first.next();
    const second = manager
      .sendMessage(session.id, { turnId: 'turn-2', text: 'second' })
      [Symbol.asyncIterator]();
    await second.next();

    firstGate.release();
    await first.next();
    await first.next();
    assert.strictEqual((await store.readHeader(session.id)).status, 'running');
    const afterFirstRuns = await runStore.listSessionRuns(session.id);
    assert.strictEqual(afterFirstRuns.find((run) => run.turnId === 'turn-1')?.status, 'completed');
    assert.strictEqual(afterFirstRuns.find((run) => run.turnId === 'turn-2')?.status, 'running');

    await expectRejects(manager.setPermissionMode(session.id, 'bypass'), /当前任务正在运行/);

    secondGate.release();
    await second.next();
    await second.next();
    assert.strictEqual((await store.readHeader(session.id)).status, 'active');
    const finalRuns = await runStore.listSessionRuns(session.id);
    assert.deepStrictEqual(
      finalRuns.map((run) => [run.turnId, run.status]),
      [
        ['turn-1', 'completed'],
        ['turn-2', 'completed'],
      ],
    );
    const firstEvents = await runStore.readEvents(session.id, finalRuns[0]!.runId);
    assert.ok(firstEvents.map((event) => event.type).includes('run_created'));
    assert.ok(firstEvents.map((event) => event.type).includes('run_started'));
    assert.ok(firstEvents.map((event) => event.type).includes('run_completed'));

    const summary = await manager.setPermissionMode(session.id, 'bypass');
    assert.strictEqual(summary.permissionMode, 'bypass');
  });

  test('leaving explore clears the deep research label so visible read-only copy stays truthful', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(6_000) });
    const session = await manager.createSession(
      makeInput({
        permissionMode: 'explore',
        labels: [DEEP_RESEARCH_SESSION_LABEL, 'kept'],
      }),
    );

    const summary = await manager.setPermissionMode(session.id, 'ask');

    assert.strictEqual(summary.permissionMode, 'ask');
    assert.deepStrictEqual(summary.labels, ['kept']);
    assert.deepStrictEqual((await store.readHeader(session.id)).labels, ['kept']);

    const messages = await store.readMessages(session.id);
    const modeNote = messages.find(
      (message) => message.type === 'system_note' && message.kind === 'mode_change',
    );
    if (modeNote?.type !== 'system_note') throw new Error('mode_change note was not written');
    assert.deepStrictEqual(modeNote.data, { from: 'explore', to: 'ask' });
  });

  test('starts a new turn without workspace identity when safety inspection fails', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new FinalTextTestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      safeBoundaryResumeEnabled: true,
      inspectContinuationSafety: async () => {
        throw new Error('workspace marker is unavailable');
      },
      newId: nextId(),
      now: nextNow(6_526),
    });
    const session = await manager.createSession(
      makeInput({ llmConnectionId: '11111111-1111-4111-8111-111111111111' }),
    );

    const events = await collectSessionEvents(
      manager.sendMessage(session.id, {
        turnId: 'turn-workspace-identity-unavailable',
        text: 'continue without resumability',
      }),
    );

    assert.deepStrictEqual(
      events.map((event) => event.type),
      ['text_complete', 'complete'],
    );
    const [run] = await runStore.listSessionRuns(session.id);
    assert.strictEqual(run?.llmConnectionId, '11111111-1111-4111-8111-111111111111');
    assert.strictEqual(run?.workspaceIdentity, undefined);
  });

  test('does not inspect continuation safety on normal turns while resume is disabled', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let inspectionCalls = 0;
    backends.register('ai-sdk', (ctx) => new FinalTextTestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: async () => {
        inspectionCalls += 1;
        return {
          workspaceIdentity: 'workspace-should-not-be-read',
          backgroundOperationsSettled: true,
          availableToolNames: [],
        };
      },
      newId: nextId(),
      now: nextNow(6_527),
    });
    const session = await manager.createSession(makeInput());

    await collectSessionEvents(
      manager.sendMessage(session.id, {
        turnId: 'turn-resume-disabled',
        text: 'normal happy path',
      }),
    );

    assert.strictEqual(inspectionCalls, 0);
    const [run] = await runStore.listSessionRuns(session.id);
    assert.strictEqual(run?.workspaceIdentity, undefined);
  });

  test('declares the T1 protocol for an AiSdk run when the host wires the durable boundary', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new CountingFinalTextBackend(ctx, () => {}));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      toolBoundaryProtocol: 't1_after_preflight_v1',
      backends,
      newId: nextId(),
      now: nextNow(6_060),
    });
    const session = await manager.createSession(makeInput());

    await collectSessionEvents(
      manager.sendMessage(session.id, {
        turnId: 'turn-with-tool-boundary',
        text: 'hello',
      }),
    );

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('expected run');
    const events = await runStore.readRuntimeEvents(session.id, run.runId);
    assert.deepStrictEqual(events[0]?.actions?.runtimeProtocol, {
      toolBoundary: 't1_after_preflight_v1',
    });
  });

  test('plans continuation from authoritative host facts without caller-supplied safety claims', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', () => {
      throw new Error('continuation planning must not build a backend');
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      safeBoundaryResumeEnabled: true,
      inspectContinuationSafety: async () => ({
        workspaceIdentity: 'workspace-authoritative',
        backgroundOperationsSettled: true,
        availableToolNames: [],
      }),
      newId: nextId(),
      now: nextNow(6_530),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run-authoritative-plan';
    const sourceTurnId = 'source-turn-authoritative-plan';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: sourceRunId,
        sessionId: session.id,
        turnId: sourceTurnId,
        status: 'failed',
        cwd: header.cwd,
        workspaceIdentity: 'workspace-authoritative',
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
        failureClass: 'app_restarted',
      }),
      [
        runtimeEvent({
          id: 'source-user-authoritative-plan',
          invocationId: 'source-invocation-authoritative-plan',
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue from host facts' },
        }),
        runtimeEvent({
          id: 'source-terminal-authoritative-plan',
          invocationId: 'source-invocation-authoritative-plan',
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
        }),
      ],
    );

    const plan = await manager.planAuthoritativeSafeBoundaryContinuation(session.id, {
      sourceRunId,
    });

    assert.strictEqual(plan.disposition, 'continue');
    assert.deepStrictEqual(plan.continuation?.safetySnapshot, {
      workspaceIdentity: 'workspace-authoritative',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
  });

  test('parks when authoritative continuation safety inspection fails', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      safeBoundaryResumeEnabled: true,
      inspectContinuationSafety: async () => {
        throw new Error('safety authority unavailable');
      },
      newId: nextId(),
      now: nextNow(6_535),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    await runStore.createRun(
      makeRunHeader({
        runId: 'source-run-safety-failure',
        sessionId: session.id,
        turnId: 'source-turn-safety-failure',
        status: 'failed',
        cwd: header.cwd,
        workspaceIdentity: 'workspace-safety-failure',
        completedAt: 2,
        failureClass: 'app_restarted',
      }),
    );

    const plan = await manager.planAuthoritativeSafeBoundaryContinuation(session.id, {
      sourceRunId: 'source-run-safety-failure',
    });

    assert.strictEqual(plan.disposition, 'park');
    assert.deepStrictEqual(plan.rejectionReasons, ['safety_observation_unavailable']);
  });

  test('keeps the authoritative continuation entry disabled unless the host enables it', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const lifecycleEvents: Array<{ type: string; rejectionReasons?: readonly string[] }> = [];
    const manager = new SessionManager({
      store,
      backends,
      onContinuationLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
      newId: nextId(),
      now: nextNow(6_535),
    });

    const plan = await manager.planAuthoritativeSafeBoundaryContinuation('session-disabled', {
      sourceRunId: 'source-run-disabled',
    });

    assert.strictEqual(plan.disposition, 'park');
    assert.deepStrictEqual(plan.rejectionReasons, ['resume_feature_disabled']);
    assert.deepStrictEqual(lifecycleEvents, [
      {
        type: 'plan_parked',
        sessionId: 'session-disabled',
        sourceRunId: 'source-run-disabled',
        rejectionReasons: ['resume_feature_disabled'],
      },
    ]);
  });

  test('discovers the newest resumable top-level source run from durable state', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', () => {
      throw new Error('continuation planning must not build a backend');
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      safeBoundaryResumeEnabled: true,
      inspectContinuationSafety: inspectStableContinuationSafety,
      newId: nextId(),
      now: nextNow(6_540),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    for (const [index, runId] of ['source-run-older', 'source-run-newer'].entries()) {
      const turnId = `source-turn-${index}`;
      const invocationId = `source-invocation-${index}`;
      await seedRuntimeRun(
        runStore,
        makeRunHeader({
          runId,
          sessionId: session.id,
          turnId,
          status: 'failed',
          cwd: header.cwd,
          workspaceIdentity: 'workspace-1',
          createdAt: index + 1,
          updatedAt: index + 2,
          completedAt: index + 2,
          failureClass: 'app_restarted',
        }),
        [
          runtimeEvent({
            id: `source-user-${index}`,
            invocationId,
            runId,
            sessionId: session.id,
            turnId,
            ts: index + 1,
            role: 'user',
            author: 'user',
            content: { kind: 'text', text: `continue source ${index}` },
          }),
          runtimeEvent({
            id: `source-terminal-${index}`,
            invocationId,
            runId,
            sessionId: session.id,
            turnId,
            ts: index + 2,
            status: 'failed',
            actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
          }),
        ],
      );
    }

    const plan = await manager.planLatestAuthoritativeSafeBoundaryContinuation(session.id);

    assert.strictEqual(plan.disposition, 'continue');
    assert.strictEqual(plan.continuation?.sourceRunId, 'source-run-newer');
  });

  test('RuntimeKernel drives the backend while preserving the SessionEvent stream', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const runtimeEventStore = new MemoryRuntimeEventStore();
    const backends = new BackendRegistry();
    let backend: FinalTextTestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new FinalTextTestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore,
      backends,
      newId: nextId(),
      now: nextNow(6_500),
    });
    const session = await manager.createSession(makeInput());

    const sessionEvents = await collectSessionEvents(
      manager.sendMessage(session.id, {
        turnId: 'turn-1',
        text: 'hello',
        toolMode: 'code_mode',
      }),
    );

    assert.deepStrictEqual(
      sessionEvents.map((event) => event.type),
      ['text_complete', 'complete'],
    );
    assert.deepStrictEqual(
      sessionEvents.map((event) => event.id),
      ['turn-1-final', 'turn-1-complete'],
    );
    assert.strictEqual(backend?.sendInputs[0]?.toolMode, 'code_mode');

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('AgentRunStore run was not created');
    const runtimeEvents = await runtimeEventStore.readRuntimeEvents(session.id, run.runId);
    assert.deepStrictEqual(backend?.sendInputs[0]?.headAnchorRuntimeEvent, runtimeEvents[0]);
    assert.deepStrictEqual(
      runtimeEvents.map((event) => event.runId),
      [run.runId, run.runId, run.runId],
    );
    assert.deepStrictEqual(
      runtimeEvents.map((event) => event.sessionId),
      [session.id, session.id, session.id],
    );
    assert.deepStrictEqual(
      runtimeEvents.map((event) => event.turnId),
      ['turn-1', 'turn-1', 'turn-1'],
    );
    assert.deepStrictEqual(
      runtimeEvents.map((event) => event.role),
      ['user', 'model', 'system'],
    );
    assert.deepStrictEqual(runtimeEvents[0]?.content, { kind: 'text', text: 'hello' });
    assert.deepStrictEqual(runtimeEvents[1]?.content, { kind: 'text', text: 'ok' });
    assert.strictEqual(runtimeEvents[2]?.status, 'completed');
  });

  test('snapshots mutable turn content before durable commit and backend dispatch', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const durableEvents = new MemoryRuntimeEventStore();
    const initialCommitReached = makeGate();
    const releaseInitialCommit = makeGate();
    let heldInitialCommit = false;
    const runtimeEventStore: RuntimeEventStore = {
      appendRuntimeEvent: async (sessionId, runId, event) => {
        await durableEvents.appendRuntimeEvent(sessionId, runId, event);
        if (!heldInitialCommit && event.role === 'user') {
          heldInitialCommit = true;
          initialCommitReached.release();
          await releaseInitialCommit.promise;
        }
      },
      ensureTerminalRuntimeEventDurable: (sessionId, runId, event) =>
        durableEvents.ensureTerminalRuntimeEventDurable(sessionId, runId, event),
      readRuntimeEvents: (sessionId, runId) => durableEvents.readRuntimeEvents(sessionId, runId),
      readSessionRuntimeEventEntries: (sessionId) =>
        durableEvents.readSessionRuntimeEventEntries(sessionId),
      readSessionRuntimeEvents: (sessionId) => durableEvents.readSessionRuntimeEvents(sessionId),
    };
    const backends = new BackendRegistry();
    let providerInput: BackendSendInput | undefined;
    let providerAttachmentMutationRejected = false;
    let headAnchorMutationRejected = false;
    backends.register('ai-sdk', (ctx) => ({
      kind: 'ai-sdk' as const,
      sessionId: ctx.sessionId,
      async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
        providerInput = input;
        try {
          if (input.attachments?.[0]) input.attachments[0].name = 'backend-mutated';
        } catch {
          providerAttachmentMutationRejected = true;
        }
        try {
          const content = input.headAnchorRuntimeEvent?.content;
          if (content?.kind === 'text' && content.attachments?.[0]) {
            content.attachments[0].name = 'backend-mutated-anchor';
          }
        } catch {
          headAnchorMutationRejected = true;
        }
        yield {
          type: 'complete',
          id: `${input.turnId}-complete`,
          turnId: input.turnId,
          ts: 2,
          stopReason: 'end_turn',
        };
      },
      async stop() {},
      async respondToSandboxBoundary() {},
      async dispose() {},
    }));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore,
      backends,
      newId: nextId(),
      now: nextNow(6_510),
    });
    const session = await manager.createSession(makeInput());
    const attachments: NonNullable<UserMessageInput['attachments']> = [
      {
        kind: 'code',
        name: 'accepted.ts',
        mimeType: 'text/typescript',
        bytes: 10,
        ref: { kind: 'workspace_file', relativePath: 'accepted.ts' },
      },
    ];
    const quotes: NonNullable<UserMessageInput['quotes']> = [
      { text: 'accepted quote', sourceTurnId: 'source-turn' },
    ];
    const inlineReferences: NonNullable<UserMessageInput['inlineReferences']> = [
      { kind: 'workspace_file', value: '@accepted.ts', label: 'accepted.ts', start: 0 },
    ];

    const execution = collectSessionEvents(
      manager.sendMessage(session.id, {
        turnId: 'turn-snapshot',
        text: 'inspect the attachment',
        attachments,
        quotes,
        inlineReferences,
      }),
    );
    await initialCommitReached.promise;
    attachments[0]!.name = 'caller-mutated';
    attachments[0]!.ref = { kind: 'workspace_file', relativePath: 'caller-mutated.ts' };
    quotes[0]!.text = 'caller-mutated quote';
    inlineReferences[0]!.label = 'caller-mutated.ts';
    releaseInitialCommit.release();
    await execution;

    assert.strictEqual(providerAttachmentMutationRejected, true);
    assert.strictEqual(headAnchorMutationRejected, true);
    assert.deepStrictEqual(providerInput?.attachments?.[0], {
      kind: 'code',
      name: 'accepted.ts',
      mimeType: 'text/typescript',
      bytes: 10,
      ref: { kind: 'workspace_file', relativePath: 'accepted.ts' },
    });
    assert.deepStrictEqual(providerInput?.quotes, [
      { text: 'accepted quote', sourceTurnId: 'source-turn' },
    ]);
    assert.strictEqual(Object.isFrozen(providerInput?.attachments), true);
    assert.strictEqual(Object.isFrozen(providerInput?.attachments?.[0]?.ref), true);
    const headContent = providerInput?.headAnchorRuntimeEvent?.content;
    assert.strictEqual(headContent?.kind, 'text');
    if (headContent?.kind !== 'text') throw new Error('Expected text head anchor');
    assert.deepStrictEqual(headContent.attachments, providerInput?.attachments);
    assert.strictEqual(headContent.attachments === providerInput?.attachments, false);
    assert.strictEqual(Object.isFrozen(providerInput?.headAnchorRuntimeEvent), true);
    assert.strictEqual(Object.isFrozen(headContent), true);

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('AgentRunStore run was not created');
    const [storedUserEvent] = await durableEvents.readRuntimeEvents(session.id, run.runId);
    assert.deepStrictEqual(storedUserEvent?.content, {
      kind: 'text',
      text: 'inspect the attachment',
      attachments: [
        {
          kind: 'code',
          name: 'accepted.ts',
          mimeType: 'text/typescript',
          bytes: 10,
          ref: { kind: 'workspace_file', relativePath: 'accepted.ts' },
        },
      ],
      quotes: [{ text: 'accepted quote', sourceTurnId: 'source-turn' }],
      inlineReferences: [
        { kind: 'workspace_file', value: '@accepted.ts', label: 'accepted.ts', start: 0 },
      ],
    });
    const storedUserMessage = (await store.readMessages(session.id)).find(
      (message) => message.type === 'user' && message.turnId === 'turn-snapshot',
    );
    assert.deepStrictEqual(
      storedUserMessage?.type === 'user' ? storedUserMessage.attachments : undefined,
      providerInput?.attachments,
    );
  });

  test('RuntimeKernel preserves the per-turn step cap through backend dispatch', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let providerSteps = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        providerSteps += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: `tool-${providerSteps}`,
                toolName: 'Read',
                input: JSON.stringify({ path: `notes-${providerSteps}.md` }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ] as LanguageModelV4StreamPart[],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    backends.register('ai-sdk', (ctx) =>
      createTestAiSdkBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
        appendMessage: ctx.appendMessage ?? (async () => {}),
        connection: {
          slug: 'mock-main',
          providerType: 'anthropic',
          defaultModel: 'mock-model-id',
        },
        apiKey: 'sk-test',
        modelId: 'mock-model-id',
        modelFactory: () => model,
        tools: [
          {
            name: 'Read',
            description: 'Read a file',
            parameters: z.object({ path: z.string() }),
            impl: async () => ({ ok: true }),
          },
        ],
        maxSteps: 3,
        ...(ctx.loadTurnRuntimeEvents ? { loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents } : {}),
        newId: nextId(),
        now: nextNow(1),
      }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_525),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    const events = await collectSessionEvents(
      manager.sendMessage(session.id, {
        turnId: 'turn-step-cap',
        text: 'Keep calling Read.',
        maxSteps: 1,
      }),
    );

    assert.strictEqual(providerSteps, 1);
    assert.partialDeepStrictEqual(
      events.find((event) => event.type === 'token_usage' && event.runtimeSteps !== undefined),
      { type: 'token_usage', runtimeSteps: 1 },
    );
    assert.partialDeepStrictEqual(events.at(-1), { type: 'complete', stopReason: 'step_limit' });
  });

  test('executes an approved continuation after a path move without another user message', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const lifecycleEvents: Array<{ type: string }> = [];
    let backend: FinalTextTestBackend | undefined;
    const providerStateIdentity = `sha256:${'c'.repeat(64)}` as const;
    backends.register('ai-sdk', {
      prepare: async () => ({
        providerStateIdentity,
        build: (ctx) => {
          backend = new FinalTextTestBackend(ctx);
          return backend;
        },
      }),
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      toolBoundaryProtocol: 't1_after_preflight_v1',
      backends,
      childTools: [testTool('Read')],
      inspectContinuationSafety: async () => ({
        workspaceIdentity: 'workspace-1',
        backgroundOperationsSettled: true,
        availableToolNames: ['Read'],
      }),
      onContinuationLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
      newId: nextId(),
      now: nextNow(6_550),
    });
    const session = await manager.createSession(
      makeInput({ llmConnectionId: 'connection-continuation' }),
    );
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run';
    const sourceTurnId = 'source-turn';
    const sourceInvocationId = 'source-invocation';
    await runStore.createRun({
      runId: sourceRunId,
      invocationId: sourceInvocationId,
      sessionId: session.id,
      turnId: sourceTurnId,
      status: 'failed',
      failureClass: 'runtime_interrupted',
      backendKind: header.backend,
      llmConnectionId: header.llmConnectionId,
      providerStateIdentity,
      llmConnectionSlug: header.llmConnectionSlug,
      modelId: header.model,
      cwd: header.cwd,
      permissionMode: header.permissionMode,
      orchestrationMode: 'swarm',
      orchestrationSource: 'turn_override',
      agentSwarmAuthorization: 'turn_override',
      toolMode: 'code_mode',
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    });
    const sourceEvents: RuntimeEvent[] = [
      {
        id: 'source-user',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 1,
        partial: false,
        author: 'user',
        role: 'user',
        content: { kind: 'text', text: 'continue safely' },
      },
      {
        id: 'source-thinking',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 2,
        partial: false,
        author: 'agent',
        role: 'model',
        content: {
          kind: 'thinking',
          text: 'same-route provider reasoning',
          signature: 'same-route-signature',
        },
        refs: { stepId: 'source-step' },
      },
      {
        id: 'source-tool-call',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 3,
        partial: false,
        author: 'agent',
        role: 'model',
        content: {
          kind: 'function_call',
          id: 'source-read',
          name: 'Read',
          args: { path: 'package.json' },
        },
        refs: { stepId: 'source-step' },
      },
      {
        id: 'source-tool-result',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 4,
        partial: false,
        author: 'tool',
        role: 'tool',
        content: {
          kind: 'function_response',
          id: 'source-read',
          name: 'Read',
          result: 'package contents',
        },
      },
      {
        id: 'source-terminal',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 5,
        partial: false,
        author: 'system',
        role: 'system',
        status: 'failed',
        actions: { endInvocation: true, stateDelta: { failureClass: 'runtime_interrupted' } },
      },
    ];
    for (const event of sourceEvents) {
      await runStore.appendRuntimeEvent(session.id, sourceRunId, event);
    }

    const plan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: ['Read'],
    });
    assert.strictEqual(plan.disposition, 'continue');
    if (!plan.continuation) throw new Error('expected continuation');

    const movedCwd = '/fresh-sandbox/repo';
    await store.updateHeader(session.id, { cwd: movedCwd });
    const sessionEvents = await collectSessionEvents(
      manager.resumeSafeBoundaryContinuation(plan.continuation),
    );

    assert.deepStrictEqual(
      sessionEvents.map((event) => event.type),
      ['text_complete', 'complete'],
    );
    const continuationRun = await runStore.readRun(session.id, plan.continuation.runId);
    assert.strictEqual(continuationRun.invocationId, plan.continuation.invocationId);
    assert.strictEqual(continuationRun.turnId, plan.continuation.turnId);
    assert.strictEqual(continuationRun.parentRunId, sourceRunId);
    assert.strictEqual(continuationRun.parentTurnId, sourceTurnId);
    assert.strictEqual(continuationRun.cwd, movedCwd);
    assert.strictEqual(continuationRun.status, 'completed');
    assert.strictEqual(continuationRun.providerStateIdentity, providerStateIdentity);
    assert.partialDeepStrictEqual(continuationRun, {
      orchestrationMode: 'swarm',
      orchestrationSource: 'turn_override',
      agentSwarmAuthorization: 'turn_override',
      toolMode: 'code_mode',
    });
    assert.strictEqual(backend?.sendInputs[0]?.toolMode, 'code_mode');
    assert.deepStrictEqual(
      backend?.sendInputs[0]?.runtimeContextRunHeaders?.map((runHeader) => ({
        runId: runHeader.runId,
        llmConnectionId: runHeader.llmConnectionId,
        modelId: runHeader.modelId,
        providerStateIdentity: runHeader.providerStateIdentity,
      })),
      [
        {
          runId: sourceRunId,
          llmConnectionId: header.llmConnectionId,
          modelId: header.model,
          providerStateIdentity,
        },
      ],
    );
    const continuationEvents = await runStore.readRuntimeEvents(
      session.id,
      plan.continuation.runId,
    );
    assert.partialDeepStrictEqual(continuationEvents[0]?.actions?.continuationStart, {
      protocol: 'continuation_start_v2',
      claimId: plan.continuation.claimId,
      boundaryDigest: plan.continuation.boundary?.manifestDigest,
      immediateSource: {
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        highWater: sourceEvents.length,
        prefixDigest: plan.continuation.boundary?.segments.at(-1)?.prefixDigest,
      },
      replayManifestDigest: plan.continuation.boundary?.manifestDigest,
      providerProjectionVersion: 2,
      providerReplayDigest: plan.continuation.providerReplayDigest,
    });
    assert.deepStrictEqual(continuationEvents[0]?.actions?.runtimeProtocol, {
      toolBoundary: 't1_after_preflight_v1',
    });
    assert.strictEqual(continuationEvents[0]?.refs, undefined);
    assert.strictEqual(
      continuationEvents.some((event) => event.role === 'user'),
      false,
    );
    assert.strictEqual(
      (await store.readMessages(session.id)).some((message) => message.type === 'user'),
      false,
    );
    assert.deepStrictEqual(await runStore.readRuntimeEvents(session.id, sourceRunId), sourceEvents);
    assert.deepStrictEqual(
      lifecycleEvents.map((event) => event.type),
      ['plan_approved', 'execution_started', 'execution_completed'],
    );

    await collectSessionEvents(
      manager.sendMessage(session.id, {
        turnId: 'turn-after-continuation',
        text: 'what happened after recovery?',
      }),
    );
    const followUpContext = backend?.sendInputs.at(-1)?.runtimeContext ?? [];
    assert.strictEqual(
      followUpContext.some((event) => event.runId === plan.continuation?.runId),
      true,
    );
    const followUpRun = (await runStore.listSessionRuns(session.id)).find(
      (runHeader) => runHeader.turnId === 'turn-after-continuation',
    );
    assert.strictEqual(followUpRun?.providerStateIdentity, providerStateIdentity);
  });

  test('authenticates the exact target-aware continuation projection that reaches the provider', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let providerRequest: unknown;
    const model = new MockLanguageModelV4({
      doStream: async (request) => {
        providerRequest = request;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'continued' },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ] as LanguageModelV4StreamPart[],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    backends.register('ai-sdk', (ctx) =>
      createTestAiSdkBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
        appendMessage: ctx.appendMessage ?? (async () => {}),
        connection: {
          slug: ctx.header.llmConnectionSlug,
          providerType: 'anthropic',
          defaultModel: ctx.header.model,
        },
        apiKey: 'sk-test',
        modelId: ctx.header.model,
        modelFactory: () => model,
        tools: [
          {
            name: 'Read',
            description: 'Read a file',
            parameters: z.object({ path: z.string() }),
            impl: async () => ({ ok: true }),
          },
        ],
        ...(ctx.loadTurnRuntimeEvents ? { loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents } : {}),
        newId: (() => {
          let id = 0;
          return () => `cross-route-backend-${++id}`;
        })(),
        now: nextNow(1),
      }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      toolBoundaryProtocol: 't1_after_preflight_v1',
      backends,
      childTools: [testTool('Read')],
      inspectContinuationSafety: async () => ({
        workspaceIdentity: 'workspace-1',
        backgroundOperationsSettled: true,
        availableToolNames: ['Read'],
      }),
      newId: nextId(),
      now: nextNow(6_575),
    });
    const session = await manager.createSession(
      makeInput({
        llmConnectionId: 'connection-a',
        llmConnectionSlug: 'anthropic-a',
        model: 'claude-a',
        permissionMode: 'bypass',
      }),
    );
    const sourceRunId = 'source-run-cross-route';
    const sourceInvocationId = 'source-invocation-cross-route';
    const sourceTurnId = 'source-turn-cross-route';
    await runStore.createRun({
      runId: sourceRunId,
      invocationId: sourceInvocationId,
      sessionId: session.id,
      turnId: sourceTurnId,
      status: 'failed',
      failureClass: 'runtime_interrupted',
      backendKind: 'ai-sdk',
      llmConnectionId: 'connection-a',
      llmConnectionSlug: 'anthropic-a',
      modelId: 'claude-a',
      cwd: '/tmp/cwd',
      workspaceIdentity: 'workspace-1',
      permissionMode: 'bypass',
      orchestrationMode: 'default',
      orchestrationSource: 'session',
      toolMode: 'code_mode',
      createdAt: 1,
      updatedAt: 5,
      completedAt: 5,
    });
    const sourceEvents: RuntimeEvent[] = [
      {
        id: 'cross-route-user',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 1,
        partial: false,
        author: 'user',
        role: 'user',
        content: { kind: 'text', text: 'continue across routes' },
      },
      {
        id: 'cross-route-thinking',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 2,
        partial: false,
        author: 'agent',
        role: 'model',
        content: {
          kind: 'thinking',
          text: 'source-only reasoning',
          signature: 'source-only-signature',
        },
        refs: { stepId: 'cross-route-step' },
      },
      {
        id: 'cross-route-tool-call',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 3,
        partial: false,
        author: 'agent',
        role: 'model',
        content: {
          kind: 'function_call',
          id: 'cross-route-read',
          name: 'Read',
          args: { path: 'package.json' },
        },
        refs: { stepId: 'cross-route-step' },
      },
      {
        id: 'cross-route-tool-result',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 4,
        partial: false,
        author: 'tool',
        role: 'tool',
        content: {
          kind: 'function_response',
          id: 'cross-route-read',
          name: 'Read',
          result: 'package contents',
        },
      },
      {
        id: 'cross-route-terminal',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 5,
        partial: false,
        author: 'system',
        role: 'system',
        status: 'failed',
        actions: { endInvocation: true, stateDelta: { failureClass: 'runtime_interrupted' } },
      },
    ];
    for (const event of sourceEvents) {
      await runStore.appendRuntimeEvent(session.id, sourceRunId, event);
    }
    const planInput = {
      sourceRunId,
      currentCwd: '/tmp/cwd',
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true as const,
      availableToolNames: ['Read'],
    };
    const stalePlan = await manager.planSafeBoundaryContinuation(session.id, planInput);
    assert.strictEqual(stalePlan.disposition, 'continue');
    if (!stalePlan.continuation) throw new Error('expected stale continuation');
    const staleContinuation = stalePlan.continuation;
    await store.updateHeader(session.id, {
      llmConnectionId: 'connection-b',
      llmConnectionSlug: 'anthropic-b',
      model: 'claude-b',
    });
    await assert.rejects(
      () => collectSessionEvents(manager.resumeSafeBoundaryContinuation(staleContinuation)),
      /replay changed after planning/,
    );
    assert.strictEqual(providerRequest, undefined);

    const sameProjectionStalePlan = await manager.planSafeBoundaryContinuation(
      session.id,
      planInput,
    );
    assert.strictEqual(sameProjectionStalePlan.disposition, 'continue');
    if (!sameProjectionStalePlan.continuation) {
      throw new Error('expected same-projection stale continuation');
    }
    await store.updateHeader(session.id, {
      llmConnectionId: 'connection-c',
      llmConnectionSlug: 'anthropic-c',
      model: 'claude-c',
    });
    await assert.rejects(
      () =>
        collectSessionEvents(
          manager.resumeSafeBoundaryContinuation(sameProjectionStalePlan.continuation!),
        ),
      /replay changed after planning/,
    );
    assert.strictEqual(providerRequest, undefined);

    const plan = await manager.planSafeBoundaryContinuation(session.id, planInput);
    assert.strictEqual(plan.disposition, 'continue');
    if (!plan.continuation) throw new Error('expected continuation');

    const sessionEvents = await collectSessionEvents(
      manager.resumeSafeBoundaryContinuation(plan.continuation),
    );

    assert.ok(providerRequest, JSON.stringify(sessionEvents));
    const promptJson = JSON.stringify(providerRequest);
    assert.doesNotMatch(promptJson, /source-only reasoning/);
    assert.doesNotMatch(promptJson, /source-only-signature/);
    assert.match(promptJson, /continue across routes/, promptJson);
    assert.match(promptJson, /cross-route-read/);
    assert.match(promptJson, /package contents/);
    assert.notEqual(
      plan.continuation.providerReplayDigest,
      sameProjectionStalePlan.continuation.providerReplayDigest,
    );
    const continuationEvents = await runStore.readRuntimeEvents(
      session.id,
      plan.continuation.runId,
    );
    assert.strictEqual(
      continuationEvents[0]?.actions?.continuationStart?.providerReplayDigest,
      plan.continuation.providerReplayDigest,
    );
  });

  test('strict backend refresh settles after an active continuation finalizes', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const turnStarted = makeGate();
    const sendGate = makeGate();
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new ActiveTurnBackend(ctx, {
          turnStarted,
          sendGate,
          compactCalls: [],
        }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: inspectStableContinuationSafety,
      newId: nextId(),
      now: nextNow(6_558),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'stopped-source-run';
    const sourceTurnId = 'stopped-source-turn';
    const sourceInvocationId = 'stopped-source-invocation';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: sourceRunId,
        invocationId: sourceInvocationId,
        sessionId: session.id,
        turnId: sourceTurnId,
        status: 'failed',
        failureClass: 'runtime_interrupted',
        cwd: header.cwd,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
      }),
      [
        runtimeEvent({
          id: 'stopped-source-user',
          invocationId: sourceInvocationId,
          sessionId: session.id,
          runId: sourceRunId,
          turnId: sourceTurnId,
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue until stopped' },
        }),
        runtimeEvent({
          id: 'stopped-source-terminal',
          invocationId: sourceInvocationId,
          sessionId: session.id,
          runId: sourceRunId,
          turnId: sourceTurnId,
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'runtime_interrupted' } },
        }),
      ],
    );
    const plan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    if (!plan.continuation) throw new Error('expected continuation');

    const execution = collectSessionEvents(
      manager.resumeSafeBoundaryContinuation(plan.continuation),
    );
    await turnStarted.promise;
    let refreshSettled = false;
    const refresh = manager.refreshIdleBackends();
    void refresh.finally(() => {
      refreshSettled = true;
    });
    await Promise.resolve();
    assert.strictEqual(refreshSettled, false);
    await manager.stopSession(session.id, { source: 'stop_button' });
    sendGate.release();
    await execution;
    await refresh;
    assert.strictEqual(store.disposeCount, 1);

    const cachedMessages = await store.readMessages(session.id);
    assert.partialDeepStrictEqual(
      cachedMessages
        .filter(
          (message) =>
            message.type === 'turn_state' && message.turnId === plan.continuation?.turnId,
        )
        .at(-1),
      {
        type: 'turn_state',
        status: 'aborted',
        abortSource: 'renderer.stop_button',
        parentTurnId: sourceTurnId,
      },
    );
  });

  test('parks repeated planning after the source run already produced a continuation', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new FinalTextTestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: inspectStableContinuationSafety,
      newId: nextId(),
      now: nextNow(6_565),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run-idempotent';
    const sourceTurnId = 'source-turn-idempotent';
    const sourceInvocationId = 'source-invocation-idempotent';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: sourceRunId,
        sessionId: session.id,
        turnId: sourceTurnId,
        status: 'failed',
        cwd: header.cwd,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
        failureClass: 'app_restarted',
      }),
      [
        runtimeEvent({
          id: 'source-user-idempotent',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue once' },
        }),
        runtimeEvent({
          id: 'source-terminal-idempotent',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
        }),
      ],
    );

    const firstPlan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    if (!firstPlan.continuation) throw new Error('expected first continuation');
    await collectSessionEvents(manager.resumeSafeBoundaryContinuation(firstPlan.continuation));

    const repeatedPlan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });

    assert.strictEqual(repeatedPlan.disposition, 'park');
    assert.deepStrictEqual(repeatedPlan.rejectionReasons, ['continuation_already_exists']);

    const targetRunId = firstPlan.continuation.runId;
    const targetRun = await runStore.readRun(session.id, targetRunId);
    await runStore.updateRun(session.id, targetRunId, {
      modelId: 'tampered-model',
      updatedAt: targetRun.updatedAt + 1,
    });
    const targetIdentityMismatch = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    assert.deepStrictEqual(targetIdentityMismatch.rejectionReasons, [
      'continuation_claim_repair_required',
    ]);

    await runStore.updateRun(session.id, targetRunId, {
      modelId: targetRun.modelId,
      status: 'failed',
      failureClass: 'tampered_terminal_state',
      updatedAt: targetRun.updatedAt + 2,
    });
    const targetTerminalMismatch = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    assert.deepStrictEqual(targetTerminalMismatch.rejectionReasons, [
      'continuation_claim_repair_required',
    ]);

    await runStore.updateRun(session.id, targetRunId, {
      status: targetRun.status,
      failureClass: targetRun.failureClass,
      completedAt: targetRun.completedAt,
      updatedAt: targetRun.updatedAt,
    });
    await runStore.appendRuntimeEvent(
      session.id,
      targetRunId,
      runtimeEvent({
        id: 'post-terminal-continuation-output',
        invocationId: targetRun.invocationId ?? targetRun.runId,
        runId: targetRun.runId,
        sessionId: targetRun.sessionId,
        turnId: targetRun.turnId,
        ts: targetRun.updatedAt + 1,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'must not follow a terminal fact' },
      }),
    );
    const postTerminalMismatch = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    assert.deepStrictEqual(postTerminalMismatch.rejectionReasons, [
      'continuation_claim_repair_required',
    ]);
  });

  test('rejects continuation while a normal turn is still registering', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new FinalTextTestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: inspectStableContinuationSafety,
      newId: nextId(),
      now: nextNow(6_575),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: 'race-source-run',
        invocationId: 'race-source-invocation',
        sessionId: session.id,
        turnId: 'race-source-turn',
        status: 'failed',
        failureClass: 'runtime_interrupted',
        cwd: header.cwd,
        workspaceIdentity: 'workspace-1',
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
      }),
      [
        runtimeEvent({
          id: 'race-source-user',
          invocationId: 'race-source-invocation',
          sessionId: session.id,
          runId: 'race-source-run',
          turnId: 'race-source-turn',
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue safely' },
        }),
        runtimeEvent({
          id: 'race-source-terminal',
          invocationId: 'race-source-invocation',
          sessionId: session.id,
          runId: 'race-source-run',
          turnId: 'race-source-turn',
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'runtime_interrupted' } },
        }),
      ],
    );
    const plan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId: 'race-source-run',
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    if (!plan.continuation) throw new Error('expected continuation');

    const readStarted = makeGate();
    const releaseRead = makeGate();
    store.nextReadHeaderGate = { started: readStarted, release: releaseRead };
    const pendingTurn = manager
      .sendMessage(session.id, {
        turnId: 'turn-still-registering',
        text: 'new work',
      })
      [Symbol.asyncIterator]();
    const pendingFirst = pendingTurn.next();
    await readStarted.promise;

    await expectRejects(
      collectSessionEvents(manager.resumeSafeBoundaryContinuation(plan.continuation)),
      /another run is active/,
    );

    releaseRead.release();
    await pendingFirst;
    while (!(await pendingTurn.next()).done) {}

    const continuationReadStarted = makeGate();
    const releaseContinuationRead = makeGate();
    store.nextReadHeaderGate = {
      started: continuationReadStarted,
      release: releaseContinuationRead,
    };
    const pendingContinuation = manager
      .resumeSafeBoundaryContinuation(plan.continuation)
      [Symbol.asyncIterator]();
    const continuationFirst = pendingContinuation.next();
    await continuationReadStarted.promise;
    await expectRejects(
      collectSessionEvents(
        manager.sendMessage(session.id, {
          turnId: 'turn-racing-continuation',
          text: 'must not race',
        }),
      ),
      /runtime continuation is being claimed/,
    );
    releaseContinuationRead.release();
    await continuationFirst;
    while (!(await pendingContinuation.next()).done) {}
  });

  test('rejects a stale second plan after another continuation claims the same source', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backendCalls = 0;
    backends.register(
      'ai-sdk',
      (ctx) =>
        new CountingFinalTextBackend(ctx, () => {
          backendCalls += 1;
        }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: inspectStableContinuationSafety,
      newId: nextId(),
      now: nextNow(6_570),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run-stale-plan';
    const sourceTurnId = 'source-turn-stale-plan';
    const sourceInvocationId = 'source-invocation-stale-plan';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: sourceRunId,
        sessionId: session.id,
        turnId: sourceTurnId,
        status: 'failed',
        cwd: header.cwd,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
        failureClass: 'app_restarted',
      }),
      [
        runtimeEvent({
          id: 'source-user-stale-plan',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue exactly once' },
        }),
        runtimeEvent({
          id: 'source-terminal-stale-plan',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
        }),
      ],
    );
    const planInput = {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [] as string[],
    };
    const firstPlan = await manager.planSafeBoundaryContinuation(session.id, planInput);
    const stalePlan = await manager.planSafeBoundaryContinuation(session.id, planInput);
    if (!firstPlan.continuation || !stalePlan.continuation) {
      throw new Error('expected two pre-claim continuation plans');
    }

    await collectSessionEvents(manager.resumeSafeBoundaryContinuation(firstPlan.continuation));
    await expectRejects(
      collectSessionEvents(manager.resumeSafeBoundaryContinuation(stalePlan.continuation)),
      /boundary is already claimed/i,
    );

    assert.strictEqual(backendCalls, 1);
  });

  test('serializes concurrent continuation claims for the same source boundary', async () => {
    const store = new MemorySessionStore();
    const runStore = new ContinuationClaimBarrierRunStore();
    const backends = new BackendRegistry();
    let backendCalls = 0;
    backends.register(
      'ai-sdk',
      (ctx) =>
        new CountingFinalTextBackend(ctx, () => {
          backendCalls += 1;
        }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: inspectStableContinuationSafety,
      newId: nextId(),
      now: nextNow(6_572),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run-concurrent-claim';
    const sourceTurnId = 'source-turn-concurrent-claim';
    const sourceInvocationId = 'source-invocation-concurrent-claim';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: sourceRunId,
        sessionId: session.id,
        turnId: sourceTurnId,
        status: 'failed',
        cwd: header.cwd,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
        failureClass: 'app_restarted',
      }),
      [
        runtimeEvent({
          id: 'source-user-concurrent-claim',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue once under concurrency' },
        }),
        runtimeEvent({
          id: 'source-terminal-concurrent-claim',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
        }),
      ],
    );
    const planInput = {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [] as string[],
    };
    const firstPlan = await manager.planSafeBoundaryContinuation(session.id, planInput);
    const secondPlan = await manager.planSafeBoundaryContinuation(session.id, planInput);
    if (!firstPlan.continuation || !secondPlan.continuation) {
      throw new Error('expected two pre-claim continuation plans');
    }
    runStore.armContinuationClaimBarrier();

    const firstExecution = collectSessionEvents(
      manager.resumeSafeBoundaryContinuation(firstPlan.continuation),
    );
    await runStore.waitForContinuationClaimRead();
    const secondResult = await Promise.allSettled([
      collectSessionEvents(manager.resumeSafeBoundaryContinuation(secondPlan.continuation)),
    ]);
    runStore.releaseContinuationClaimRead();
    const firstResult = await Promise.allSettled([firstExecution]);
    const results = [...firstResult, ...secondResult];

    assert.strictEqual(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.strictEqual(results.filter((result) => result.status === 'rejected').length, 1);
    assert.strictEqual(backendCalls, 1);
  });

  test('does not call the backend and claim recovery closes a continuation-start persistence failure', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failRuntimeEventAppendAfter: 2 });
    const backends = new BackendRegistry();
    let backendCalls = 0;
    backends.register(
      'ai-sdk',
      (ctx) =>
        new CountingFinalTextBackend(ctx, () => {
          backendCalls += 1;
        }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: inspectStableContinuationSafety,
      newId: nextId(),
      now: nextNow(6_575),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run-write-failure';
    const sourceTurnId = 'source-turn-write-failure';
    const sourceInvocationId = 'source-invocation-write-failure';
    await runStore.createRun({
      runId: sourceRunId,
      sessionId: session.id,
      turnId: sourceTurnId,
      status: 'failed',
      backendKind: header.backend,
      llmConnectionSlug: header.llmConnectionSlug,
      modelId: header.model,
      cwd: header.cwd,
      permissionMode: header.permissionMode,
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
      failureClass: 'app_restarted',
    });
    const sourceEvents: RuntimeEvent[] = [
      {
        id: 'source-user-write-failure',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 1,
        partial: false,
        author: 'user',
        role: 'user',
        content: { kind: 'text', text: 'continue safely' },
      },
      {
        id: 'source-terminal-write-failure',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 2,
        partial: false,
        author: 'system',
        role: 'system',
        status: 'failed',
        actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
      },
    ];
    for (const event of sourceEvents) {
      await runStore.appendRuntimeEvent(session.id, sourceRunId, event);
    }
    const plan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    if (!plan.continuation) throw new Error('expected continuation');

    await expectRejects(
      collectSessionEvents(manager.resumeSafeBoundaryContinuation(plan.continuation)),
      /runtime event append failed/,
    );

    assert.strictEqual(backendCalls, 0);
    const targetRun = await runStore.readRun(session.id, plan.continuation.runId);
    assert.strictEqual(['created', 'running'].includes(targetRun.status), true);
    assert.strictEqual(targetRun.completedAt, undefined);
    assert.deepStrictEqual(
      await runStore.readRuntimeEvents(session.id, plan.continuation.runId),
      [],
    );

    await manager.recoverInterruptedSessions();

    const recoveredRun = await runStore.readRun(session.id, plan.continuation.runId);
    const recoveredEvents = await runStore.readRuntimeEvents(session.id, plan.continuation.runId);
    assert.strictEqual(recoveredRun.status, 'failed');
    assert.strictEqual(
      recoveredRun.failureClass,
      'continuation_abandoned_before_provider_dispatch',
    );
    assert.strictEqual(recoveredEvents.length, 2);
    assert.strictEqual(
      recoveredEvents[0]?.actions?.continuationStart?.claimId,
      plan.continuation.claimId,
    );
    assert.strictEqual(recoveredEvents.filter(isTerminalRuntimeEvent).length, 1);
    assert.partialDeepStrictEqual(recoveredEvents.at(-1)?.actions?.stateDelta, {
      recovered: true,
      recoveryReason: 'continuation_abandoned_before_provider_dispatch',
      failureClass: 'continuation_abandoned_before_provider_dispatch',
    });
  });

  test('stop after the durable continuation-start commit fences backend dispatch', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const continuationCommitted = makeGate();
    const releaseContinuationCommit = makeGate();
    let backendCalls = 0;
    backends.register(
      'ai-sdk',
      (ctx) =>
        new CountingFinalTextBackend(ctx, () => {
          backendCalls += 1;
        }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: inspectStableContinuationSafety,
      continuationFailpoint: async (point) => {
        if (point !== 'after_continuation_start_committed') return;
        continuationCommitted.release();
        await releaseContinuationCommit.promise;
      },
      newId: nextId(),
      now: nextNow(6_576),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run-post-commit-stop';
    const sourceTurnId = 'source-turn-post-commit-stop';
    const sourceInvocationId = 'source-invocation-post-commit-stop';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: sourceRunId,
        sessionId: session.id,
        turnId: sourceTurnId,
        status: 'failed',
        cwd: header.cwd,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
        failureClass: 'app_restarted',
      }),
      [
        runtimeEvent({
          id: 'source-user-post-commit-stop',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue only if the Run still owns dispatch' },
        }),
        runtimeEvent({
          id: 'source-terminal-post-commit-stop',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
        }),
      ],
    );
    const plan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    if (!plan.continuation) throw new Error('expected continuation');

    const execution = collectSessionEvents(
      manager.resumeSafeBoundaryContinuation(plan.continuation),
    );
    await continuationCommitted.promise;
    const stop = manager.stopSession(session.id, { source: 'stop_button' });
    releaseContinuationCommit.release();
    await stop;
    await execution.catch(() => []);

    assert.strictEqual(backendCalls, 0);
    const targetRun = await runStore.readRun(session.id, plan.continuation.runId);
    assert.strictEqual(targetRun.status, 'cancelled');
    const targetEvents = await runStore.readRuntimeEvents(session.id, plan.continuation.runId);
    assert.strictEqual(
      targetEvents.filter((event) => event.actions?.continuationStart !== undefined).length,
      1,
    );
    assert.strictEqual(targetEvents.filter(isTerminalRuntimeEvent).length, 1);
  });

  test('does not call the backend when the durable continuation claim cannot be created', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failContinuationCreate: true });
    const backends = new BackendRegistry();
    let backendCalls = 0;
    backends.register(
      'ai-sdk',
      (ctx) =>
        new CountingFinalTextBackend(ctx, () => {
          backendCalls += 1;
        }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: inspectStableContinuationSafety,
      newId: nextId(),
      now: nextNow(6_577),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run-claim-create-failure';
    const sourceTurnId = 'source-turn-claim-create-failure';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: sourceRunId,
        sessionId: session.id,
        turnId: sourceTurnId,
        status: 'failed',
        cwd: header.cwd,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
        failureClass: 'app_restarted',
      }),
      [
        runtimeEvent({
          id: 'source-user-claim-create-failure',
          invocationId: 'source-invocation-claim-create-failure',
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue only with a durable claim' },
        }),
        runtimeEvent({
          id: 'source-terminal-claim-create-failure',
          invocationId: 'source-invocation-claim-create-failure',
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
        }),
      ],
    );
    const plan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    if (!plan.continuation) throw new Error('expected continuation');

    await expectRejects(
      collectSessionEvents(manager.resumeSafeBoundaryContinuation(plan.continuation)),
      /continuation claim create failed/,
    );

    assert.strictEqual(backendCalls, 0);
    await expectRejects(runStore.readRun(session.id, plan.continuation.runId), /unknown run/i);
  });

  test('revalidates terminal ledger consistency before executing a planned continuation', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backendCalls = 0;
    backends.register(
      'ai-sdk',
      (ctx) =>
        new CountingFinalTextBackend(ctx, () => {
          backendCalls += 1;
        }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: inspectStableContinuationSafety,
      newId: nextId(),
      now: nextNow(6_590),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run-race';
    const sourceTurnId = 'source-turn-race';
    const sourceInvocationId = 'source-invocation-race';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: sourceRunId,
        sessionId: session.id,
        turnId: sourceTurnId,
        status: 'failed',
        cwd: header.cwd,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
        failureClass: 'app_restarted',
      }),
      [
        runtimeEvent({
          id: 'source-user-race',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue safely' },
        }),
        runtimeEvent({
          id: 'source-terminal-race',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
        }),
      ],
    );
    const plan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    if (!plan.continuation) throw new Error('expected continuation');

    await runStore.updateRun(session.id, sourceRunId, {
      status: 'completed',
      updatedAt: 3,
      completedAt: 3,
    });

    await expectRejects(
      collectSessionEvents(manager.resumeSafeBoundaryContinuation(plan.continuation)),
      /terminal/i,
    );
    assert.strictEqual(backendCalls, 0);
  });

  test('startup recovery retries claim-only terminal projection without dispatching the provider', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failUpdateRunStatusOnce: 'failed' });
    const backends = new BackendRegistry();
    let backendCalls = 0;
    let failOnce = true;
    backends.register(
      'ai-sdk',
      (ctx) =>
        new CountingFinalTextBackend(ctx, () => {
          backendCalls += 1;
        }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: inspectStableContinuationSafety,
      continuationFailpoint: async (point) => {
        if (point === 'after_continuation_claim_committed' && failOnce) {
          failOnce = false;
          throw new Error('simulated claim-only crash');
        }
      },
      newId: nextId(),
      now: nextNow(6_591),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run-claim-only-crash';
    const sourceTurnId = 'source-turn-claim-only-crash';
    const sourceInvocationId = 'source-invocation-claim-only-crash';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: sourceRunId,
        invocationId: sourceInvocationId,
        sessionId: session.id,
        turnId: sourceTurnId,
        status: 'failed',
        cwd: header.cwd,
        workspaceIdentity: 'workspace-1',
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
        failureClass: 'app_restarted',
      }),
      [
        runtimeEvent({
          id: 'source-user-claim-only-crash',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue after a claim-only crash' },
        }),
        runtimeEvent({
          id: 'source-terminal-claim-only-crash',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
        }),
      ],
    );
    const plan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    if (!plan.continuation) throw new Error('expected continuation');

    await expectRejects(
      collectSessionEvents(manager.resumeSafeBoundaryContinuation(plan.continuation)),
      /simulated claim-only crash/,
    );
    await expectRejects(runStore.readRun(session.id, plan.continuation.runId), /unknown run/i);
    assert.strictEqual(backendCalls, 0);

    assert.ok(!(await manager.recoverInterruptedSessions()).includes(session.id));
    const durableRepairEvents = await runStore.readRuntimeEvents(
      session.id,
      plan.continuation.runId,
    );
    assert.strictEqual(durableRepairEvents.length, 2);
    assert.strictEqual(durableRepairEvents.filter(isTerminalRuntimeEvent).length, 1);
    assert.strictEqual(
      (await runStore.readRun(session.id, plan.continuation.runId)).status,
      'created',
    );

    assert.ok((await manager.recoverInterruptedSessions()).includes(session.id));
    const repairedRun = await runStore.readRun(session.id, plan.continuation.runId);
    assert.strictEqual(repairedRun.status, 'failed');
    assert.strictEqual(repairedRun.failureClass, 'continuation_abandoned_before_provider_dispatch');
    assert.strictEqual(
      repairedRun.continuationSource && 'protocol' in repairedRun.continuationSource
        ? repairedRun.continuationSource.protocol
        : undefined,
      'continuation_source_v2',
    );
    assert.strictEqual(
      repairedRun.continuationSource && 'claimId' in repairedRun.continuationSource
        ? repairedRun.continuationSource.claimId
        : undefined,
      plan.continuation.claimId,
    );
    const repairedEvents = await runStore.readRuntimeEvents(session.id, plan.continuation.runId);
    assert.strictEqual(repairedEvents.length, 2);
    assert.strictEqual(
      repairedEvents[0]?.actions?.continuationStart?.claimId,
      plan.continuation.claimId,
    );
    assert.strictEqual(repairedEvents[1]?.status, 'failed');
    assert.strictEqual(backendCalls, 0);

    const snapshot = JSON.stringify({
      run: repairedRun,
      events: repairedEvents,
    });
    await manager.recoverInterruptedSessions();
    assert.strictEqual(
      JSON.stringify({
        run: await runStore.readRun(session.id, plan.continuation.runId),
        events: await runStore.readRuntimeEvents(session.id, plan.continuation.runId),
      }),
      snapshot,
    );
    assert.strictEqual(backendCalls, 0);

    const nextPlan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId: plan.continuation.runId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    assert.strictEqual(nextPlan.disposition, 'continue');
  });

  test('rejects continuation when the authoritative workspace identity changes after planning', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backendCalls = 0;
    let workspaceIdentity = 'workspace-1';
    const lifecycleEvents: Array<{ type: string; errorClass?: string }> = [];
    backends.register(
      'ai-sdk',
      (ctx) =>
        new CountingFinalTextBackend(ctx, () => {
          backendCalls += 1;
        }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: async () => ({
        workspaceIdentity,
        backgroundOperationsSettled: true,
        availableToolNames: [],
      }),
      newId: nextId(),
      now: nextNow(6_595),
      onContinuationLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run-workspace-race';
    const sourceTurnId = 'source-turn-workspace-race';
    const sourceInvocationId = 'source-invocation-workspace-race';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: sourceRunId,
        sessionId: session.id,
        turnId: sourceTurnId,
        status: 'failed',
        cwd: header.cwd,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
        failureClass: 'app_restarted',
      }),
      [
        runtimeEvent({
          id: 'source-user-workspace-race',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue in the same workspace' },
        }),
        runtimeEvent({
          id: 'source-terminal-workspace-race',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
        }),
      ],
    );
    const plan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: workspaceIdentity,
      currentWorkspaceIdentity: workspaceIdentity,
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    if (!plan.continuation) throw new Error('expected continuation');
    workspaceIdentity = 'workspace-2';

    await expectRejects(
      collectSessionEvents(manager.resumeSafeBoundaryContinuation(plan.continuation)),
      /workspace identity changed/i,
    );
    assert.strictEqual(backendCalls, 0);
    assert.deepStrictEqual(lifecycleEvents.at(-1), {
      type: 'execution_failed',
      sessionId: session.id,
      sourceRunId,
      targetRunId: plan.continuation.runId,
      errorClass: 'workspace_identity_changed',
    });
  });

  test('requires exact tool-catalog equality between continuation planning and execution', async () => {
    const scenarios = [
      { name: 'added', planned: ['Write'], current: ['Read', 'Write'] },
      { name: 'removed', planned: ['Read', 'Write'], current: ['Write'] },
      { name: 'replaced', planned: ['Write'], current: ['Edit'] },
    ] as const;

    for (const scenario of scenarios) {
      const store = new MemorySessionStore();
      const runStore = new MemoryAgentRunStore();
      const backends = new BackendRegistry();
      let backendCalls = 0;
      let availableToolNames: readonly string[] = scenario.planned;
      backends.register(
        'ai-sdk',
        (ctx) =>
          new CountingFinalTextBackend(ctx, () => {
            backendCalls += 1;
          }),
      );
      const manager = new SessionManager({
        store,
        runStore,
        runtimeEventStore: runStore,
        backends,
        inspectContinuationSafety: async () => ({
          workspaceIdentity: 'workspace-1',
          backgroundOperationsSettled: true,
          availableToolNames,
        }),
        newId: nextId(),
        now: nextNow(6_597),
      });
      const session = await manager.createSession(makeInput());
      const header = await store.readHeader(session.id);
      const sourceRunId = `source-run-tool-catalog-${scenario.name}`;
      const sourceTurnId = `source-turn-tool-catalog-${scenario.name}`;
      const sourceInvocationId = `source-invocation-tool-catalog-${scenario.name}`;
      await seedRuntimeRun(
        runStore,
        makeRunHeader({
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          status: 'failed',
          cwd: header.cwd,
          createdAt: 1,
          updatedAt: 2,
          completedAt: 2,
          failureClass: 'app_restarted',
        }),
        [
          runtimeEvent({
            id: `source-user-tool-catalog-${scenario.name}`,
            invocationId: sourceInvocationId,
            runId: sourceRunId,
            sessionId: session.id,
            turnId: sourceTurnId,
            ts: 1,
            role: 'user',
            author: 'user',
            content: { kind: 'text', text: 'continue with the same tools' },
          }),
          runtimeEvent({
            id: `source-terminal-tool-catalog-${scenario.name}`,
            invocationId: sourceInvocationId,
            runId: sourceRunId,
            sessionId: session.id,
            turnId: sourceTurnId,
            ts: 2,
            status: 'failed',
            actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
          }),
        ],
      );
      const plan = await manager.planSafeBoundaryContinuation(session.id, {
        sourceRunId,
        currentCwd: header.cwd,
        sourceWorkspaceIdentity: 'workspace-1',
        currentWorkspaceIdentity: 'workspace-1',
        backgroundOperationsSettled: true,
        availableToolNames: scenario.planned,
      });
      if (!plan.continuation) throw new Error(`expected ${scenario.name} continuation`);
      availableToolNames = scenario.current;

      await expectRejects(
        collectSessionEvents(manager.resumeSafeBoundaryContinuation(plan.continuation)),
        /tool catalog changed/i,
      );
      assert.strictEqual(backendCalls, 0);
    }
  });

  test('revalidates continuation safety inside the backend activation barrier', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backendCalls = 0;
    let availableToolNames: readonly string[] = ['Write'];
    backends.register(
      'ai-sdk',
      (ctx) =>
        new CountingFinalTextBackend(ctx, () => {
          backendCalls += 1;
        }),
    );
    const newId = nextId();
    const now = nextNow(6_599);
    const runtimeKernel = new RuntimeKernel({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      inspectContinuationSafety: async () => ({
        workspaceIdentity: 'workspace-1',
        backgroundOperationsSettled: true,
        availableToolNames,
      }),
      runBackendActivation: async (operation) => {
        availableToolNames = ['Read', 'Write'];
        return operation();
      },
      newId,
      now,
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      runtimeKernel,
      inspectContinuationSafety: async () => ({
        workspaceIdentity: 'workspace-1',
        backgroundOperationsSettled: true,
        availableToolNames,
      }),
      newId,
      now,
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run-activation-safety-race';
    const sourceTurnId = 'source-turn-activation-safety-race';
    const sourceInvocationId = 'source-invocation-activation-safety-race';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: sourceRunId,
        sessionId: session.id,
        turnId: sourceTurnId,
        status: 'failed',
        cwd: header.cwd,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
        failureClass: 'app_restarted',
      }),
      [
        runtimeEvent({
          id: 'source-user-activation-safety-race',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue under one activation snapshot' },
        }),
        runtimeEvent({
          id: 'source-terminal-activation-safety-race',
          invocationId: sourceInvocationId,
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
        }),
      ],
    );
    const plan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames,
    });
    if (!plan.continuation) throw new Error('expected continuation');

    await expectRejects(
      collectSessionEvents(manager.resumeSafeBoundaryContinuation(plan.continuation)),
      /tool catalog changed/i,
    );

    assert.strictEqual(backendCalls, 0);
    await expectRejects(runStore.readRun(session.id, plan.continuation.runId), /Unknown run/);
  });

  test('fails closed when continuation execution has no authoritative safety inspector', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backendCalls = 0;
    backends.register(
      'ai-sdk',
      (ctx) =>
        new CountingFinalTextBackend(ctx, () => {
          backendCalls += 1;
        }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_600),
    });
    const session = await manager.createSession(makeInput());
    const header = await store.readHeader(session.id);
    const sourceRunId = 'source-run-no-safety-inspector';
    const sourceTurnId = 'source-turn-no-safety-inspector';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        runId: sourceRunId,
        sessionId: session.id,
        turnId: sourceTurnId,
        status: 'failed',
        cwd: header.cwd,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
        failureClass: 'app_restarted',
      }),
      [
        runtimeEvent({
          id: 'source-user-no-safety-inspector',
          invocationId: 'source-invocation-no-safety-inspector',
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'continue only with authoritative facts' },
        }),
        runtimeEvent({
          id: 'source-terminal-no-safety-inspector',
          invocationId: 'source-invocation-no-safety-inspector',
          runId: sourceRunId,
          sessionId: session.id,
          turnId: sourceTurnId,
          ts: 2,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
        }),
      ],
    );
    const plan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    if (!plan.continuation) throw new Error('expected continuation');

    await expectRejects(
      collectSessionEvents(manager.resumeSafeBoundaryContinuation(plan.continuation)),
      /safety inspector/i,
    );
    assert.strictEqual(backendCalls, 0);
  });

  test('sendMessage preserves token usage fields while resuming from an empty prior runtime ledger', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const newId = nextId();
    const now = nextNow(7_000);
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId,
      now,
    });
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'prior question' },
      {
        type: 'assistant',
        id: 'legacy-assistant',
        turnId: 'turn-1',
        ts: 102,
        text: 'prior answer',
        modelId: 'fake-model',
      },
      {
        type: 'token_usage',
        id: 'legacy-usage',
        turnId: 'turn-1',
        ts: 103,
        input: 100,
        output: 25,
        runtimeSteps: 3,
        contextRemaining: 9000,
        providerRequestTraceId: 'provider-trace-1',
      },
      {
        type: 'turn_state',
        id: 'legacy-state',
        turnId: 'turn-1',
        ts: 104,
        status: 'completed',
        partialOutputRetained: true,
      },
    ]);
    await runStore.createRun(
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'completed',
        createdAt: 100,
        updatedAt: 104,
        completedAt: 104,
      }),
    );

    const restarted = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId,
      now,
    });
    const sessionEvents = await collectSessionEvents(
      restarted.sendMessage(session.id, { turnId: 'turn-2', text: 'follow up' }),
    );

    assert.deepStrictEqual(
      sessionEvents.map((event) => event.type),
      ['text_delta', 'complete'],
    );
    assert.deepStrictEqual(
      backend?.sendInputs[0]?.context.map((message) => message.type),
      ['user', 'assistant', 'token_usage', 'turn_state'],
    );
    assert.deepStrictEqual(
      backend?.sendInputs[0]?.context.map((message) =>
        'text' in message ? message.text : message.type,
      ),
      ['prior question', 'prior answer', 'token_usage', 'turn_state'],
    );
    assert.deepStrictEqual(
      backend?.sendInputs[0]?.runtimeContext?.map((event) => event.runId),
      ['run-1', 'run-1', 'run-1', 'run-1'],
    );
    const resumedUsage = backend?.sendInputs[0]?.runtimeContext?.find(
      (event) => event.actions?.tokenUsage,
    );
    assert.strictEqual(resumedUsage?.actions?.tokenUsage?.runtimeSteps, 3);
    assert.strictEqual(resumedUsage?.actions?.tokenUsage?.contextRemaining, 9000);
    assert.strictEqual(resumedUsage?.refs?.providerRequestTraceId, 'provider-trace-1');
    const repairedRuntimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');
    assert.deepStrictEqual(
      repairedRuntimeEvents.map((event) => event.refs?.storedMessageId),
      ['legacy-user', 'legacy-assistant', 'legacy-usage', 'legacy-state'],
    );
    assert.strictEqual(repairedRuntimeEvents.at(-1)?.status, 'completed');
  });

  test('sendMessage completes interrupted imported history beside native runs', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failRuntimeEventAppendAfter: 3 });
    const backends = new BackendRegistry();
    let backend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(7_025),
    });
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'imported-user-1', turnId: 'turn-1', ts: 101, text: 'First question' },
      {
        type: 'assistant',
        id: 'imported-assistant-1',
        turnId: 'turn-1',
        ts: 102,
        text: 'First answer',
        modelId: 'external-model',
      },
      {
        type: 'turn_state',
        id: 'imported-state-1',
        turnId: 'turn-1',
        ts: 103,
        status: 'completed',
        partialOutputRetained: true,
      },
      { type: 'user', id: 'imported-user-2', turnId: 'turn-2', ts: 104, text: 'Second question' },
      {
        type: 'assistant',
        id: 'imported-assistant-2',
        turnId: 'turn-2',
        ts: 105,
        text: 'Second answer',
        modelId: 'external-model',
      },
      {
        type: 'turn_state',
        id: 'imported-state-2',
        turnId: 'turn-2',
        ts: 106,
        status: 'completed',
        partialOutputRetained: true,
      },
    ]);

    await expectRejects(
      manager.prepareImportedSessionHistory(session.id),
      /runtime event append failed/,
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'native-run',
        invocationId: 'native-invocation',
        turnId: 'turn-3',
        status: 'completed',
        createdAt: 10,
        updatedAt: 12,
        completedAt: 12,
      }),
      [
        runtimeEvent({
          id: 'native-user',
          invocationId: 'native-invocation',
          sessionId: session.id,
          runId: 'native-run',
          turnId: 'turn-3',
          ts: 10,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'Native question' },
        }),
        runtimeEvent({
          id: 'native-assistant',
          invocationId: 'native-invocation',
          sessionId: session.id,
          runId: 'native-run',
          turnId: 'turn-3',
          ts: 11,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'Native answer' },
        }),
        runtimeEvent({
          id: 'native-complete',
          invocationId: 'native-invocation',
          sessionId: session.id,
          runId: 'native-run',
          turnId: 'turn-3',
          ts: 12,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );

    await drain(manager.sendMessage(session.id, { turnId: 'turn-4', text: 'Continue' }));

    assert.deepStrictEqual(
      backend?.sendInputs[0]?.runtimeContext?.flatMap((event) =>
        event.content?.kind === 'text' ? [event.content.text] : [],
      ),
      [
        'First question',
        'First answer',
        'Second question',
        'Second answer',
        'Native question',
        'Native answer',
      ],
    );
    assert.strictEqual((await store.readHeader(session.id)).transcriptLedgerVersion, 1);
    const repairedRuns = await runStore.listSessionRuns(session.id);
    assert.strictEqual(repairedRuns.filter((run) => run.turnId === 'turn-1').length, 1);
    assert.strictEqual(repairedRuns.filter((run) => run.turnId === 'turn-2').length, 1);
  });

  test('sendMessage rejects an imported Session while its history is staging', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(7_040),
    });
    const session = await manager.createSession(makeInput());
    await store.updateHeader(session.id, { transcriptLedgerVersion: 0 });

    await expectRejects(
      drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'Too early' })),
      /history is still being prepared/,
    );

    assert.strictEqual((await runStore.listSessionRuns(session.id)).length, 0);
  });

  test('sendMessage rejects prior runtime context without a valid terminal fact', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(7_050),
    });
    const session = await manager.createSession(makeInput());
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'completed',
        createdAt: 100,
        updatedAt: 103,
        completedAt: 103,
      }),
      [
        runtimeEvent({
          id: 'rt-user',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'prior question' },
        }),
        runtimeEvent({
          id: 'rt-assistant',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 102,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'prior answer' },
        }),
        runtimeEvent({
          id: 'rt-completed-a',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 103,
          status: 'completed',
          actions: { endInvocation: true },
        }),
        runtimeEvent({
          id: 'rt-completed-b',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 104,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );

    await expectRejects(
      drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'follow up' })),
      /valid terminal fact/,
    );
    assert.strictEqual(backend?.sendInputs.length ?? 0, 0);
    const currentRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-2',
    );
    if (!currentRun) throw new Error('current AgentRunStore run was not created');
    assert.strictEqual(currentRun.status, 'failed');
    assert.strictEqual(currentRun.failureClass, 'missing_terminal_event');
    const currentTerminalEvents = (
      await runStore.readRuntimeEvents(session.id, currentRun.runId)
    ).filter(isTerminalRuntimeEvent);
    assert.strictEqual(currentTerminalEvents.length, 1);
    assert.strictEqual(currentTerminalEvents[0]?.status, 'failed');
    assert.strictEqual(
      currentTerminalEvents[0]?.actions?.stateDelta?.failureClass,
      'missing_terminal_event',
    );
  });

  test('sendMessage replays a prior run left non-terminal by an unanswered interaction', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(7_075),
    });
    const session = await manager.createSession(makeInput());
    // A run parked on AskUserQuestion and then stopped: the header never left
    // `waiting_for_user` and the ledger never received a terminal fact. Its
    // turn is still conversation the model must see.
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'waiting_for_user',
        createdAt: 100,
        updatedAt: 102,
      }),
      [
        runtimeEvent({
          id: 'rt-user',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'prior question' },
        }),
        runtimeEvent({
          id: 'rt-assistant',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 102,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'prior answer' },
        }),
      ],
    );

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'follow up' }));

    assert.deepStrictEqual(
      backend?.sendInputs[0]?.runtimeContext?.map((event) => event.id),
      ['rt-user', 'rt-assistant'],
    );
  });

  test('RuntimeReadModel projects messages turns replay and terminal facts without SessionStore messages', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const session = await store.create(makeInput());
    const seeded = await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'turn-1',
      runId: 'run-1',
      userText: 'runtime question',
      assistantText: 'runtime answer',
      legacyIdPrefix: 'cache',
    });
    store.failReadMessagesFor.add(session.id);

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
    }).getSessionView(session.id);

    assert.deepStrictEqual(view.messages, seeded.projectedMessages);
    assert.deepStrictEqual(view.turns, [
      {
        turnId: 'turn-1',
        status: 'completed',
        statusSource: 'recorded',
        partialOutputRetained: true,
      },
    ]);
    assert.deepStrictEqual(
      view.terminalFacts.map((fact) => fact.runStatus),
      ['completed'],
    );
    assert.deepStrictEqual(
      view.replayPlan.textMessages.map((message) => message.content),
      ['runtime question', 'runtime answer'],
    );
  });

  test('SessionManager projects hosted permission details from the canonical outcome', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const header = makeRunHeader({ status: 'completed' });
    await store.create(makeInput());
    await seedCanonicalPermissionRun(runStore, header);
    const canonicalPermissionOutcomes: CanonicalPermissionOutcomeReader = {
      readPermissionOutcome: async (requestId) =>
        canonicalPermissionRecord(header, {
          requestId,
          outcome: {
            kind: 'permission_answer' as const,
            decision: 'allow' as const,
            rememberForTurn: true,
            reviewer: 'auto_review' as const,
            rationale: 'The requested write is limited to the reviewed path.',
            riskLevel: 'medium' as const,
            committedAt: 125,
          },
        }),
    };
    const backends = new BackendRegistry();
    const interactionAuthority: RuntimeInteractionAuthority = {
      bindRun: () => {
        throw new Error('read-only test authority cannot bind a Run');
      },
    };
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(125),
      interactionAuthority,
      canonicalPermissionOutcomes,
    });

    const messages = await manager.getMessages(header.sessionId);

    assert.deepStrictEqual(
      messages.find((message) => message.type === 'permission_decision'),
      {
        type: 'permission_decision',
        id: 'request-canonical',
        turnId: header.turnId,
        ts: 125,
        toolUseId: 'tool-canonical',
        toolName: 'Write',
        decision: 'allow',
        rememberForTurn: true,
        reviewer: 'auto_review',
        rationale: 'The requested write is limited to the reviewed path.',
        riskLevel: 'medium',
        hint: 'write approval',
      },
    );

    const cachedView = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
      projectionCache: {
        readMessages: async () =>
          messages.filter((message) => message.type !== 'permission_decision'),
      },
      canonicalPermissionOutcomes,
    }).getSessionView(header.sessionId);

    assert.deepStrictEqual(cachedView.diagnostics, []);
  });

  test('SessionManager joins a canonical hosted permission without a ledger request', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const header = makeRunHeader({ status: 'completed' });
    await store.create(makeInput());
    await seedCanonicalPermissionRun(runStore, header, false);
    const canonicalPermissionOutcomes: CanonicalPermissionOutcomeReader = {
      readPermissionOutcome: async (requestId) =>
        canonicalPermissionRecord(header, {
          requestId,
          outcome: {
            kind: 'permission_answer',
            decision: 'allow',
            rememberForTurn: true,
            reviewer: 'auto_review',
            committedAt: 125,
          },
        }),
    };
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(125),
      interactionAuthority: {
        bindRun: () => {
          throw new Error('read-only test authority cannot bind a Run');
        },
      },
      canonicalPermissionOutcomes,
    });

    const messages = await manager.getMessages(header.sessionId);

    assert.deepStrictEqual(
      messages.find((message) => message.type === 'permission_decision'),
      {
        type: 'permission_decision',
        id: 'request-canonical',
        turnId: header.turnId,
        ts: 125,
        toolUseId: 'tool-canonical',
        toolName: 'Write',
        decision: 'allow',
        rememberForTurn: true,
        reviewer: 'auto_review',
      },
    );
  });

  test('RuntimeReadModel fails closed for a missing or mismatched hosted permission outcome', async () => {
    const header = makeRunHeader({ status: 'completed' });
    const canonical = canonicalPermissionRecord(header);
    const outcomes: Array<CanonicalPermissionOutcomeRecord | undefined> = [
      undefined,
      {
        ...canonical,
        sessionId: 'wrong-session',
        outcome: {
          kind: 'permission_answer' as const,
          decision: 'deny' as const,
          rememberForTurn: false as const,
          reviewer: 'user' as const,
          committedAt: 125,
        },
      },
    ];
    for (const outcome of outcomes) {
      const runStore = new MemoryAgentRunStore();
      await seedCanonicalPermissionRun(runStore, header);
      await assert.rejects(
        new RuntimeReadModel({
          runStore,
          runtimeEventStore: runStore,
          canonicalPermissionOutcomes: {
            readPermissionOutcome: async () => outcome,
          },
        }).getSessionView(header.sessionId),
        (error: unknown) =>
          error instanceof RuntimeReadModelError &&
          error.diagnostics.some((diagnostic) => diagnostic.code === 'incomplete_event'),
      );
    }
  });

  test('RuntimeReadModel bounds concurrent hosted permission outcome reads', {
    timeout: 2_000,
  }, async (t) => {
    const runStore = new MemoryAgentRunStore();
    const header = makeRunHeader({ status: 'completed' });
    const requestIds = Array.from({ length: 20 }, (_, index) => `request-${index}`);
    await seedRuntimeRun(runStore, header, [
      runtimeEvent({
        id: 'permission-concurrency-user',
        sessionId: header.sessionId,
        runId: header.runId,
        turnId: header.turnId,
        ts: 99,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'approve the operations' },
      }),
      ...requestIds.map((requestId, index) =>
        runtimeEvent({
          id: `permission-concurrency-${index}`,
          sessionId: header.sessionId,
          runId: header.runId,
          turnId: header.turnId,
          ts: 100 + index,
          author: 'user',
          actions: { permissionAnswerAccepted: { requestId } },
          refs: { toolCallId: `tool-${requestId}` },
        }),
      ),
      runtimeEvent({
        id: 'permission-concurrency-terminal',
        sessionId: header.sessionId,
        runId: header.runId,
        turnId: header.turnId,
        ts: 200,
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ]);

    let activeReads = 0;
    let maxActiveReads = 0;
    let startedReads = 0;
    let releaseReads!: () => void;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    t.after(() => releaseReads());
    let initialWorkersStarted!: () => void;
    const initialWorkers = new Promise<void>((resolve) => {
      initialWorkersStarted = resolve;
    });
    const viewPromise = new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
      canonicalPermissionOutcomes: {
        readPermissionOutcome: async (requestId) => {
          activeReads += 1;
          startedReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          if (startedReads === 8) initialWorkersStarted();
          await readsReleased;
          activeReads -= 1;
          const canonical = canonicalPermissionRecord(header);
          return {
            ...canonical,
            requestId,
            request: {
              ...canonical.request,
              toolUseId: `tool-${requestId}`,
            },
          };
        },
      },
    }).getSessionView(header.sessionId);

    await initialWorkers;
    assert.strictEqual(startedReads, 8);
    assert.strictEqual(maxActiveReads, 8);
    releaseReads();
    const view = await viewPromise;

    assert.strictEqual(startedReads, requestIds.length);
    assert.strictEqual(maxActiveReads, 8);
    assert.strictEqual(
      view.messages.filter((message) => message.type === 'permission_decision').length,
      requestIds.length,
    );
  });

  test('RuntimeReadModel excludes child runs from the default session transcript', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const session = await store.create(makeInput());
    await seedRuntimeReadTurnWithHeader({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'parent-turn',
      runId: 'parent-run',
      userText: 'parent question',
      assistantText: 'parent answer',
      legacyIdPrefix: 'parent',
      header: {},
      tsBase: 100,
    });
    await seedRuntimeReadTurnWithHeader({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'child-turn',
      runId: 'child-run',
      userText: 'child prompt',
      assistantText: 'child private answer',
      legacyIdPrefix: 'child',
      header: { parentRunId: 'parent-run', agentName: 'Researcher' },
      tsBase: 200,
    });

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
    }).getSessionView(session.id);

    assert.deepStrictEqual(
      view.runs.map((run) => run.runId),
      ['parent-run'],
    );
    assert.deepStrictEqual(
      view.messages.map((message) => message.turnId),
      ['parent-turn', 'parent-turn', 'parent-turn'],
    );
    assert.deepStrictEqual(
      view.replayPlan.textMessages.map((message) => message.content),
      ['parent question', 'parent answer'],
    );
  });

  test('projection/cache mismatch does not override RuntimeEvent read output', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const legacyMessages: StoredMessage[] = [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      {
        type: 'assistant',
        id: 'legacy-assistant',
        turnId: 'turn-1',
        ts: 102,
        text: 'legacy answer',
        modelId: 'fake-model',
      },
      {
        type: 'turn_state',
        id: 'legacy-state',
        turnId: 'turn-1',
        ts: 103,
        status: 'completed',
        partialOutputRetained: true,
      },
    ];
    await store.appendMessages(session.id, legacyMessages);
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'completed',
        createdAt: 100,
        updatedAt: 103,
        completedAt: 103,
      }),
      [
        runtimeEvent({
          id: 'rt-user',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'question' },
        }),
        runtimeEvent({
          id: 'rt-complete',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 103,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );

    assert.deepStrictEqual(await manager.getMessages(session.id), [
      { type: 'user', id: 'rt-user', turnId: 'turn-1', ts: 101, text: 'question' },
      {
        type: 'turn_state',
        id: 'rt-complete',
        turnId: 'turn-1',
        ts: 103,
        status: 'completed',
        partialOutputRetained: false,
      },
    ]);
  });

  test('getMessages repairs a non-empty RuntimeEvent ledger that is missing only the terminal fact', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      {
        type: 'assistant',
        id: 'legacy-assistant',
        turnId: 'turn-1',
        ts: 102,
        text: 'answer',
        modelId: 'fake-model',
      },
      {
        type: 'turn_state',
        id: 'legacy-state',
        turnId: 'turn-1',
        ts: 103,
        status: 'completed',
        partialOutputRetained: true,
      },
    ]);
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'completed',
        createdAt: 100,
        updatedAt: 103,
        completedAt: 103,
      }),
      [
        runtimeEvent({
          id: 'rt-user',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'question' },
        }),
        runtimeEvent({
          id: 'rt-assistant',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 102,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'answer' },
        }),
      ],
    );

    const messages = await manager.getMessages(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    assert.deepStrictEqual(
      messages.map((message) => message.type),
      ['user', 'assistant', 'turn_state'],
    );
    assert.deepStrictEqual(messages.at(-1), {
      type: 'turn_state',
      id: 'legacy-state',
      turnId: 'turn-1',
      ts: 103,
      status: 'completed',
      partialOutputRetained: true,
    });
    assert.deepStrictEqual(
      runtimeEvents.slice(0, 2).map((event) => event.id),
      ['rt-user', 'rt-assistant'],
    );
    assert.strictEqual(runtimeEvents.at(-1)?.status, 'completed');
    assert.strictEqual(runtimeEvents.at(-1)?.refs?.storedMessageId, 'legacy-state');
  });

  test('getMessages repair writes terminal turn_state for a continuation run', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const sourceRunId = 'repair-source-run';
    const sourceTurnId = 'repair-source-turn';
    const sourceInvocationId = 'repair-source-invocation';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: sourceRunId,
        turnId: sourceTurnId,
        status: 'completed',
        createdAt: 100,
        updatedAt: 101,
        completedAt: 101,
      }),
      [
        runtimeEvent({
          id: 'repair-source-complete',
          invocationId: sourceInvocationId,
          sessionId: session.id,
          runId: sourceRunId,
          turnId: sourceTurnId,
          ts: 101,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'repair-continuation-run',
        turnId: 'repair-continuation-turn',
        status: 'completed',
        parentRunId: sourceRunId,
        parentTurnId: sourceTurnId,
        continuationSource: {
          sourceInvocationId,
          sourceRunId,
          sourceTurnId,
          sourceRuntimeEventHighWater: 1,
        },
        createdAt: 102,
        updatedAt: 104,
        completedAt: 104,
      }),
      [
        runtimeEvent({
          id: 'repair-continuation-text',
          invocationId: 'repair-continuation-invocation',
          sessionId: session.id,
          runId: 'repair-continuation-run',
          turnId: 'repair-continuation-turn',
          ts: 103,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'retained continuation output' },
        }),
      ],
    );

    await manager.getMessages(session.id);

    const cachedMessages = await store.readMessages(session.id);
    assert.partialDeepStrictEqual(
      cachedMessages.find(
        (message) => message.type === 'turn_state' && message.turnId === 'repair-continuation-turn',
      ),
      {
        type: 'turn_state',
        status: 'failed',
        errorClass: 'missing_terminal_event',
        parentTurnId: sourceTurnId,
        partialOutputRetained: false,
      },
    );
  });

  test('getMessages can retry repair when the failed header update is interrupted', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failUpdateRunOnce: true });
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      {
        type: 'assistant',
        id: 'legacy-assistant',
        turnId: 'turn-1',
        ts: 102,
        text: 'answer',
        modelId: 'fake-model',
      },
    ]);
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'completed',
        createdAt: 100,
        updatedAt: 103,
        completedAt: 103,
      }),
      [
        runtimeEvent({
          id: 'rt-user',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'question' },
        }),
        runtimeEvent({
          id: 'rt-assistant',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 102,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'answer' },
        }),
      ],
    );

    await expectRejects(manager.getMessages(session.id), /update run failed/);

    const messages = await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    assert.strictEqual(repairedRun.status, 'failed');
    assert.strictEqual(repairedRun.failureClass, 'missing_terminal_event');
    assert.strictEqual(messages.at(-1)?.type, 'turn_state');
    assert.strictEqual(runtimeEvents.filter((event) => event.status === 'failed').length, 1);
  });

  test('getMessages repairs missing failed header class from an existing terminal RuntimeEvent', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      {
        type: 'assistant',
        id: 'legacy-assistant',
        turnId: 'turn-1',
        ts: 102,
        text: 'answer',
        modelId: 'fake-model',
      },
    ]);
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'failed',
        failureClass: undefined,
        createdAt: 100,
        updatedAt: 103,
        completedAt: 103,
      }),
      [
        runtimeEvent({
          id: 'rt-user',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'question' },
        }),
        runtimeEvent({
          id: 'rt-assistant',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 102,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'answer' },
        }),
        runtimeEvent({
          id: 'rt-failed',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 103,
          role: 'system',
          author: 'system',
          status: 'failed',
          content: {
            kind: 'error',
            code: 'tool_failed',
            reason: 'tool_failed',
            message: 'tool failed',
          },
          actions: { endInvocation: true, stateDelta: { failureClass: 'tool_failed' } },
        }),
      ],
    );

    const messages = await manager.getMessages(session.id);
    await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    assert.strictEqual(repairedRun.failureClass, 'tool_failed');
    assert.deepStrictEqual(messages.at(-1), {
      type: 'turn_state',
      id: 'rt-failed',
      turnId: 'turn-1',
      ts: 103,
      status: 'failed',
      errorClass: 'tool_failed',
      partialOutputRetained: true,
    });
    assert.strictEqual(runtimeEvents.filter((event) => event.status === 'failed').length, 1);
  });

  test('getMessages uses fallback failed header class when an existing terminal RuntimeEvent has no class', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      {
        type: 'assistant',
        id: 'legacy-assistant',
        turnId: 'turn-1',
        ts: 102,
        text: 'answer',
        modelId: 'fake-model',
      },
    ]);
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'failed',
        failureClass: undefined,
        createdAt: 100,
        updatedAt: 103,
        completedAt: 103,
      }),
      [
        runtimeEvent({
          id: 'rt-user',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'question' },
        }),
        runtimeEvent({
          id: 'rt-assistant',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 102,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'answer' },
        }),
        runtimeEvent({
          id: 'rt-failed',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 103,
          role: 'system',
          author: 'system',
          status: 'failed',
          actions: { endInvocation: true },
        }),
      ],
    );

    await manager.getMessages(session.id);
    await manager.getMessages(session.id);
    const repairedRun = await runStore.readRun(session.id, 'run-1');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');

    assert.strictEqual(repairedRun.failureClass, 'missing_terminal_event');
    assert.strictEqual(runtimeEvents.filter((event) => event.status === 'failed').length, 1);
  });

  test('getMessages serializes concurrent terminal repairs for the same run', async () => {
    const store = new MemorySessionStore();
    let repairReads = 0;
    const runStore = new MemoryAgentRunStore({
      beforeRuntimeEventRead: async (_sessionId, runId) => {
        if (runId !== 'run-1' || repairReads >= 2) return;
        repairReads += 1;
        await Promise.resolve();
      },
    });
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await store.appendMessages(session.id, [
      { type: 'user', id: 'legacy-user', turnId: 'turn-1', ts: 101, text: 'question' },
      {
        type: 'assistant',
        id: 'legacy-assistant',
        turnId: 'turn-1',
        ts: 102,
        text: 'answer',
        modelId: 'fake-model',
      },
    ]);
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'completed',
        createdAt: 100,
        updatedAt: 103,
        completedAt: 103,
      }),
      [
        runtimeEvent({
          id: 'rt-user',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'question' },
        }),
        runtimeEvent({
          id: 'rt-assistant',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 102,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'answer' },
        }),
      ],
    );

    await Promise.all([manager.getMessages(session.id), manager.getMessages(session.id)]);

    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');
    assert.strictEqual(runtimeEvents.filter((event) => event.status === 'failed').length, 1);
  });

  test('getMessages includes continuation output without inlining child agent output', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const sourceRunId = 'source-run';
    const sourceTurnId = 'source-turn';
    const sourceInvocationId = 'source-invocation';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: sourceRunId,
        turnId: sourceTurnId,
        status: 'failed',
        createdAt: 100,
        updatedAt: 102,
        completedAt: 102,
        failureClass: 'app_restarted',
      }),
      [
        runtimeEvent({
          id: 'source-user',
          invocationId: sourceInvocationId,
          sessionId: session.id,
          runId: sourceRunId,
          turnId: sourceTurnId,
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'write an article' },
        }),
        runtimeEvent({
          id: 'source-failed',
          invocationId: sourceInvocationId,
          sessionId: session.id,
          runId: sourceRunId,
          turnId: sourceTurnId,
          ts: 102,
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
        }),
      ],
    );

    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'continuation-run',
        turnId: 'continuation-turn',
        status: 'completed',
        parentRunId: sourceRunId,
        parentTurnId: sourceTurnId,
        continuationSource: {
          sourceInvocationId,
          sourceRunId,
          sourceTurnId,
          sourceRuntimeEventHighWater: 2,
        },
        createdAt: 103,
        updatedAt: 105,
        completedAt: 105,
      }),
      [
        runtimeEvent({
          id: 'continuation-start',
          invocationId: 'continuation-invocation',
          sessionId: session.id,
          runId: 'continuation-run',
          turnId: 'continuation-turn',
          ts: 103,
          role: 'system',
          author: 'system',
          actions: {
            stateDelta: { continuationStart: true },
            runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' },
          },
          refs: {
            sourceInvocationId,
            sourceRunId,
            sourceTurnId,
            sourceRuntimeEventHighWater: 2,
          },
        }),
        runtimeEvent({
          id: 'continuation-article',
          invocationId: 'continuation-invocation',
          sessionId: session.id,
          runId: 'continuation-run',
          turnId: 'continuation-turn',
          ts: 104,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'the resumed article' },
        }),
        runtimeEvent({
          id: 'continuation-complete',
          invocationId: 'continuation-invocation',
          sessionId: session.id,
          runId: 'continuation-run',
          turnId: 'continuation-turn',
          ts: 105,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );

    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'child-run',
        turnId: 'child-turn',
        status: 'completed',
        parentRunId: sourceRunId,
        parentTurnId: sourceTurnId,
        createdAt: 106,
        updatedAt: 108,
        completedAt: 108,
      }),
      [
        runtimeEvent({
          id: 'child-answer',
          invocationId: 'child-invocation',
          sessionId: session.id,
          runId: 'child-run',
          turnId: 'child-turn',
          ts: 107,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'private child output' },
        }),
        runtimeEvent({
          id: 'child-complete',
          invocationId: 'child-invocation',
          sessionId: session.id,
          runId: 'child-run',
          turnId: 'child-turn',
          ts: 108,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );

    const messages = await manager.getMessages(session.id);
    const assistantTexts = messages.flatMap((message) =>
      message.type === 'assistant' ? [message.text] : [],
    );

    assert.ok(assistantTexts.includes('the resumed article'));
    assert.ok(!assistantTexts.some((text) => text.includes('private child output')));
    assert.strictEqual(
      messages.some((message) => message.id === 'continuation-start'),
      false,
    );
  });

  test('getMessages includes in-flight projection cache rows for an active RuntimeEvent run', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const completed = await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'turn-1',
      runId: 'run-1',
      userText: 'completed question',
      assistantText: 'completed answer',
      legacyIdPrefix: 'legacy',
    });
    const activeMessages: StoredMessage[] = [
      { type: 'user', id: 'active-user', turnId: 'turn-2', ts: 201, text: 'active question' },
      {
        type: 'assistant',
        id: 'active-assistant',
        turnId: 'turn-2',
        ts: 202,
        text: 'partial active answer',
        modelId: 'fake-model',
      },
      {
        type: 'turn_state',
        id: 'active-state',
        turnId: 'turn-2',
        ts: 203,
        status: 'running',
        partialOutputRetained: true,
      },
    ];
    await store.appendMessages(session.id, activeMessages);
    await runStore.createRun(
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-2',
        turnId: 'turn-2',
        status: 'running',
        createdAt: 200,
        updatedAt: 203,
      }),
    );

    const messages = await manager.getMessages(session.id);
    assert.deepStrictEqual(messages, [...completed.projectedMessages, ...activeMessages]);
    assert.deepStrictEqual(await manager.listTurns(session.id), [
      {
        turnId: 'turn-1',
        status: 'completed',
        statusSource: 'recorded',
        partialOutputRetained: true,
      },
      {
        turnId: 'turn-2',
        status: 'running',
        statusSource: 'recorded',
        partialOutputRetained: true,
      },
    ]);

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
      projectionCache: store,
    }).getSessionView(session.id);
    assert.strictEqual(
      view.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'incomplete_event' &&
          diagnostic.message.includes('in-flight projection cache'),
      ),
      true,
    );
  });

  test('getMessages overlays a canonical permission acceptance from a running ledger', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const session = await store.create(makeInput());
    const header = makeRunHeader({
      sessionId: session.id,
      runId: 'active-run',
      turnId: 'active-turn',
      status: 'running',
      createdAt: 100,
      updatedAt: 125,
    });
    await runStore.createRun(header);
    await store.appendMessages(session.id, [
      {
        type: 'user',
        id: 'active-user',
        turnId: header.turnId,
        ts: 100,
        text: 'write the file',
      },
      {
        type: 'turn_state',
        id: 'active-state',
        turnId: header.turnId,
        ts: 101,
        status: 'running',
        partialOutputRetained: false,
      },
    ]);
    await runStore.appendRuntimeEvent(
      session.id,
      header.runId,
      runtimeEvent({
        id: 'active-permission-request',
        sessionId: session.id,
        runId: header.runId,
        turnId: header.turnId,
        ts: 110,
        actions: {
          permissionRequest: {
            kind: 'tool_permission',
            requestId: 'request-canonical',
            toolUseId: 'tool-canonical',
            toolName: 'Write',
            category: 'file_write',
            reason: 'file_write',
            args: { path: '/tmp/file' },
            rememberForTurnAllowed: true,
            hint: 'write approval',
          },
        },
        refs: { toolCallId: 'tool-canonical' },
      }),
    );
    await runStore.appendRuntimeEvent(
      session.id,
      header.runId,
      runtimeEvent({
        id: 'active-permission-acceptance',
        sessionId: session.id,
        runId: header.runId,
        turnId: header.turnId,
        ts: 126,
        actions: { permissionAnswerAccepted: { requestId: 'request-canonical' } },
        refs: { toolCallId: 'tool-canonical' },
      }),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(125),
      interactionAuthority: {
        bindRun: () => {
          throw new Error('read-only test authority cannot bind a Run');
        },
      },
      canonicalPermissionOutcomes: {
        readPermissionOutcome: async () =>
          canonicalPermissionRecord(header, {
            outcome: {
              kind: 'permission_answer',
              decision: 'allow',
              rememberForTurn: true,
              reviewer: 'auto_review',
              committedAt: 125,
            },
          }),
      },
    });

    assert.partialDeepStrictEqual(
      (await manager.getMessages(session.id)).find(
        (message) => message.type === 'permission_decision',
      ),
      {
        type: 'permission_decision',
        id: 'request-canonical',
        turnId: header.turnId,
        toolUseId: 'tool-canonical',
        decision: 'allow',
        reviewer: 'auto_review',
      },
    );
  });

  test('the in-flight overlay keeps a pending sandbox boundary request visible in the view', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const session = await store.create(makeInput());
    const header = makeRunHeader({
      sessionId: session.id,
      runId: 'active-run',
      turnId: 'active-turn',
      status: 'running',
      createdAt: 100,
      updatedAt: 125,
    });
    await runStore.createRun(header);
    await store.appendMessages(session.id, [
      { type: 'user', id: 'active-user', turnId: header.turnId, ts: 100, text: 'build it' },
      {
        type: 'turn_state',
        id: 'active-state',
        turnId: header.turnId,
        ts: 101,
        status: 'running',
        partialOutputRetained: false,
      },
    ]);
    await runStore.appendRuntimeEvent(
      session.id,
      header.runId,
      runtimeEvent({
        id: 'active-boundary-request',
        sessionId: session.id,
        runId: header.runId,
        turnId: header.turnId,
        ts: 110,
        actions: {
          stateDelta: {
            sandboxBoundaryRequest: {
              requestId: 'boundary-pending',
              toolUseId: 'tool-boundary',
              justification: 'Write outside the workspace.',
              expansion: { network: { enabled: true } },
            },
          },
        },
        refs: { toolCallId: 'tool-boundary' },
      }),
    );
    await runStore.appendRuntimeEvent(
      session.id,
      header.runId,
      runtimeEvent({
        id: 'active-boundary-decision',
        sessionId: session.id,
        runId: header.runId,
        turnId: header.turnId,
        ts: 111,
        author: 'user',
        actions: {
          stateDelta: {
            sandboxBoundaryDecision: {
              requestId: 'boundary-pending',
              decision: 'deny',
              status: 'denied',
              revision: 0,
            },
          },
        },
        refs: { toolCallId: 'tool-boundary' },
      }),
    );

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
      projectionCache: store,
    }).getSessionView(session.id);

    const readRequestId = (value: unknown): string[] =>
      value !== null && typeof value === 'object' && 'requestId' in value
        ? [(value as { requestId: string }).requestId]
        : [];
    // Both halves of the interaction survive: without the decision the view
    // would show a request that never resolves.
    assert.deepStrictEqual(
      view.events.flatMap((event) =>
        readRequestId(event.actions?.stateDelta?.sandboxBoundaryRequest),
      ),
      ['boundary-pending'],
    );
    assert.deepStrictEqual(
      view.events.flatMap((event) =>
        readRequestId(event.actions?.stateDelta?.sandboxBoundaryDecision),
      ),
      ['boundary-pending'],
    );
  });

  test('mixed projection-cache-only system notes do not override RuntimeEvent projection', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    const seeded = await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'turn-1',
      runId: 'run-1',
      userText: 'question',
      assistantText: 'answer',
      legacyIdPrefix: 'legacy',
    });
    const legacyNote: StoredMessage = {
      type: 'system_note',
      id: 'legacy-note',
      ts: 104,
      kind: 'mode_change',
      data: { from: 'ask', to: 'bypass' },
    };
    await store.appendMessage(session.id, legacyNote);

    const messages = await manager.getMessages(session.id);

    assert.deepStrictEqual(messages, seeded.projectedMessages);
  });

  test('getMessages orders RuntimeEvent-primary reads by durable session chronology', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'slow-run',
        turnId: 'slow',
        status: 'completed',
        createdAt: 100,
        updatedAt: 107,
        completedAt: 107,
      }),
      [
        runtimeEvent({
          id: 'slow-user',
          sessionId: session.id,
          runId: 'slow-run',
          turnId: 'slow',
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'slow question' },
          refs: { storedMessageId: 'slow-user-message' },
        }),
        runtimeEvent({
          id: 'slow-assistant',
          sessionId: session.id,
          runId: 'slow-run',
          turnId: 'slow',
          ts: 106,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'slow answer' },
          refs: { storedMessageId: 'slow-assistant-message' },
        }),
        runtimeEvent({
          id: 'slow-complete',
          sessionId: session.id,
          runId: 'slow-run',
          turnId: 'slow',
          ts: 107,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'fast-run',
        turnId: 'fast',
        status: 'completed',
        createdAt: 102,
        updatedAt: 105,
        completedAt: 105,
      }),
      [
        runtimeEvent({
          id: 'fast-user',
          sessionId: session.id,
          runId: 'fast-run',
          turnId: 'fast',
          ts: 103,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'fast question' },
          refs: { storedMessageId: 'fast-user-message' },
        }),
        runtimeEvent({
          id: 'fast-assistant',
          sessionId: session.id,
          runId: 'fast-run',
          turnId: 'fast',
          ts: 104,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'fast answer' },
          refs: { storedMessageId: 'fast-assistant-message' },
        }),
        runtimeEvent({
          id: 'fast-complete',
          sessionId: session.id,
          runId: 'fast-run',
          turnId: 'fast',
          ts: 105,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    store.failNextReadMessagesFor.set(session.id, 1);

    const messages = await manager.getMessages(session.id);

    assert.deepStrictEqual(
      messages.map(
        (message) =>
          `${message.type}:${'turnId' in message ? message.turnId : 'none'}:${message.ts}`,
      ),
      [
        'user:slow:101',
        'assistant:slow:106',
        'turn_state:slow:107',
        'user:fast:103',
        'assistant:fast:104',
        'turn_state:fast:105',
      ],
    );
  });

  test('regenerate finds completed source turns through the RuntimeEvent-primary view', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) => new EventBackend(ctx, [{ type: 'complete', stopReason: 'end_turn' }]),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_770),
    });
    const session = await manager.createSession(makeInput());
    await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'source',
      runId: 'source-run',
      userText: 'runtime regenerate text',
      assistantText: 'runtime answer',
      legacyIdPrefix: 'legacy',
    });
    store.failNextReadMessagesFor.set(session.id, 1);

    await drain(manager.regenerateTurn(session.id, { sourceTurnId: 'source', turnId: 'regen-1' }));

    const messages = await store.readMessages(session.id);
    const regenUser = messages.find(
      (message) => message.type === 'user' && message.turnId === 'regen-1',
    );
    assert.strictEqual(
      regenUser?.type === 'user' ? regenUser.text : undefined,
      'runtime regenerate text',
    );
    const regenState = deriveTurnRecords(messages).find((turn) => turn.turnId === 'regen-1');
    assert.strictEqual(regenState?.regeneratedFromTurnId, 'source');
  });

  test('regenerate is stop-visible during its first source-ledger preflight', async () => {
    const preflightStarted = makeGate();
    const releasePreflight = makeGate();
    let gatePreflight = false;
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({
      beforeListSessionRuns: async () => {
        if (!gatePreflight) return;
        gatePreflight = false;
        preflightStarted.release();
        await releasePreflight.promise;
      },
    });
    const backends = new BackendRegistry();
    let backend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_775),
    });
    const session = await manager.createSession(makeInput());
    await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'source',
      runId: 'source-run',
      userText: 'do not regenerate after stop',
      assistantText: 'source answer',
      legacyIdPrefix: 'legacy-stop',
    });

    gatePreflight = true;
    const regenerating = manager
      .regenerateTurn(session.id, {
        sourceTurnId: 'source',
        turnId: 'regen-stopped-preflight',
      })
      [Symbol.asyncIterator]();
    const firstEvent = regenerating.next();
    await preflightStarted.promise;
    let stopSettled = false;
    const stopping = manager.stopSession(session.id, { source: 'stop_button' }).finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    assert.strictEqual(stopSettled, false);

    releasePreflight.release();
    await stopping;
    assert.strictEqual((await firstEvent).done, true);
    assert.deepStrictEqual(backend?.sendInputs, []);
    const regenerated = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'regen-stopped-preflight',
    );
    assert.strictEqual(regenerated?.status, 'cancelled');
    assert.strictEqual((await store.readHeader(session.id)).status === 'blocked', false);
  });

  test('regenerate accepts an aborted source turn (retry semantics merged into regenerate)', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) => new EventBackend(ctx, [{ type: 'complete', stopReason: 'end_turn' }]),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_780),
    });
    const session = await manager.createSession(makeInput());
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'source-run',
        turnId: 'source',
        status: 'cancelled',
        createdAt: 100,
        updatedAt: 102,
        completedAt: 102,
      }),
      [
        runtimeEvent({
          id: 'source-user',
          sessionId: session.id,
          runId: 'source-run',
          turnId: 'source',
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'aborted turn text' },
        }),
        runtimeEvent({
          id: 'source-abort',
          sessionId: session.id,
          runId: 'source-run',
          turnId: 'source',
          ts: 102,
          role: 'system',
          author: 'system',
          status: 'aborted',
          actions: { endInvocation: true, stateDelta: { abortSource: 'renderer.stop_button' } },
        }),
      ],
    );
    store.failNextReadMessagesFor.set(session.id, 1);

    await drain(
      manager.regenerateTurn(session.id, { sourceTurnId: 'source', turnId: 'regen-aborted' }),
    );

    const regenUser = (await store.readMessages(session.id)).find(
      (message) => message.type === 'user' && message.turnId === 'regen-aborted',
    );
    assert.strictEqual(
      regenUser?.type === 'user' ? regenUser.text : undefined,
      'aborted turn text',
    );
  });

  test('multi-run RuntimeEvent projection preserves retry regenerate and branch lineage on turns', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput());
    await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'root',
      runId: 'root-run',
      userText: 'root question',
      assistantText: 'root answer',
      legacyIdPrefix: 'root-legacy',
    });
    await seedRuntimeReadTurnWithHeader({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'retry',
      runId: 'retry-run',
      userText: 'retry question',
      assistantText: 'retry answer',
      legacyIdPrefix: 'retry-legacy',
      header: { parentTurnId: 'root', retriedFromTurnId: 'root' },
      tsBase: 200,
    });
    await seedRuntimeReadTurnWithHeader({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'regen',
      runId: 'regen-run',
      userText: 'regen question',
      assistantText: 'regen answer',
      legacyIdPrefix: 'regen-legacy',
      header: { parentTurnId: 'root', regeneratedFromTurnId: 'root' },
      tsBase: 300,
    });
    await seedRuntimeReadTurnWithHeader({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'branch',
      runId: 'branch-run',
      userText: 'branch question',
      assistantText: 'branch answer',
      legacyIdPrefix: 'branch-legacy',
      header: { parentSessionId: 'parent-session', branchOfTurnId: 'root' },
      tsBase: 400,
    });
    store.failNextReadMessagesFor.set(session.id, 1);

    const turns = await manager.listTurns(session.id);

    assert.partialDeepStrictEqual(
      turns.find((turn) => turn.turnId === 'retry'),
      {
        status: 'completed',
        parentTurnId: 'root',
        retriedFromTurnId: 'root',
      },
    );
    assert.partialDeepStrictEqual(
      turns.find((turn) => turn.turnId === 'regen'),
      {
        status: 'completed',
        parentTurnId: 'root',
        regeneratedFromTurnId: 'root',
      },
    );
    assert.partialDeepStrictEqual(
      turns.find((turn) => turn.turnId === 'branch'),
      {
        status: 'completed',
        parentSessionId: 'parent-session',
        branchOfTurnId: 'root',
      },
    );
  });

  test('next turn projects failed prior RuntimeEvents with the terminal fact failure class', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const backendInstances: TestBackend[] = [];
    backends.register('ai-sdk', (ctx) => {
      const backend = new TestBackend(ctx);
      backendInstances.push(backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_810),
    });
    const session = await manager.createSession(makeInput());
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'running',
        createdAt: 101,
        updatedAt: 103,
      }),
      [
        runtimeEvent({
          id: 'rt-user',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'first' },
        }),
        runtimeEvent({
          id: 'rt-assistant',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 102,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'before failure' },
        }),
        runtimeEvent({
          id: 'rt-failed',
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          ts: 103,
          role: 'system',
          author: 'system',
          status: 'failed',
          actions: { endInvocation: true, stateDelta: { failureClass: 'tool_failed' } },
        }),
      ],
    );

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));

    const secondInput = backendInstances[0]?.sendInputs[0];
    if (!secondInput) throw new Error('backend input was not recorded');
    assert.deepStrictEqual(
      secondInput.runtimeContext?.map((event) => event.turnId),
      ['turn-1', 'turn-1', 'turn-1'],
    );
    const turnState = secondInput.context.find(
      (message) => message.type === 'turn_state' && message.turnId === 'turn-1',
    );
    if (turnState?.type !== 'turn_state')
      throw new Error('prior failed turn_state was not projected');
    assert.strictEqual(turnState.status, 'failed');
    assert.strictEqual(turnState.errorClass, 'tool_failed');
  });

  test('next turn uses failed terminal RuntimeEvents when failed header commit was interrupted', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failUpdateRunStatusOnce: 'failed' });
    const backends = new BackendRegistry();
    let backend: TurnScriptBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new TurnScriptBackend(ctx, [
        [{ type: 'complete', stopReason: 'error' }],
        [
          { type: 'text_delta', messageId: 'm2', text: 'second ok' },
          { type: 'complete', stopReason: 'end_turn' },
        ],
      ]);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_812),
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'first' }));
    const [firstRun] = await runStore.listSessionRuns(session.id);
    if (!firstRun) throw new Error('first run was not recorded');
    assert.strictEqual(firstRun.status, 'running');
    const firstRuntimeEvents = await runStore.readRuntimeEvents(session.id, firstRun.runId);
    const firstTerminalEvents = firstRuntimeEvents.filter(isTerminalRuntimeEvent);
    assert.strictEqual(firstTerminalEvents.length, 1);
    assert.strictEqual(firstTerminalEvents[0]?.status, 'failed');
    assert.strictEqual(firstTerminalEvents[0]?.actions?.stateDelta?.failureClass, 'runtime_error');

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));

    const secondInput = backend?.sendInputs[1];
    if (!secondInput) throw new Error('second backend input was not recorded');
    assert.deepStrictEqual(
      secondInput.runtimeContext?.map((event) => event.turnId),
      ['turn-1', 'turn-1'],
    );
    const turnState = secondInput.context.find(
      (message) => message.type === 'turn_state' && message.turnId === 'turn-1',
    );
    if (turnState?.type !== 'turn_state')
      throw new Error('prior failed turn_state was not projected');
    assert.strictEqual(turnState.status, 'failed');
    assert.strictEqual(turnState.errorClass, 'runtime_error');
    const terminalEventsAfterSecondTurn = (
      await runStore.readRuntimeEvents(session.id, firstRun.runId)
    ).filter(isTerminalRuntimeEvent);
    assert.strictEqual(terminalEventsAfterSecondTurn.length, 1);
  });

  test('next parent turn excludes child run RuntimeEvents from model context', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const backendInstances: TestBackend[] = [];
    backends.register('ai-sdk', (ctx) => {
      const backend = new TestBackend(ctx);
      backendInstances.push(backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_825),
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'first' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'child-run',
        turnId: 'child-turn',
        status: 'completed',
        createdAt: parentRun.updatedAt + 1,
        updatedAt: parentRun.updatedAt + 4,
        completedAt: parentRun.updatedAt + 4,
        parentRunId: parentRun.runId,
        agentName: 'Researcher',
      }),
      [
        runtimeEvent({
          id: 'child-user',
          sessionId: session.id,
          runId: 'child-run',
          turnId: 'child-turn',
          ts: parentRun.updatedAt + 2,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'child prompt' },
        }),
        runtimeEvent({
          id: 'child-assistant',
          sessionId: session.id,
          runId: 'child-run',
          turnId: 'child-turn',
          ts: parentRun.updatedAt + 3,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'child private answer' },
        }),
        runtimeEvent({
          id: 'child-complete',
          sessionId: session.id,
          runId: 'child-run',
          turnId: 'child-turn',
          ts: parentRun.updatedAt + 4,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));

    const secondInput = backendInstances[0]?.sendInputs[1];
    if (!secondInput) throw new Error('second backend input was not recorded');
    assert.deepStrictEqual(
      secondInput.runtimeContext?.map((event) => event.turnId),
      ['turn-1', 'turn-1', 'turn-1'],
    );
    assert.strictEqual(
      secondInput.runtimeContext?.some((event) => event.turnId === 'child-turn'),
      false,
    );
    assert.strictEqual(
      secondInput.context.some(
        (message) => message.type === 'user' && message.turnId === 'child-turn',
      ),
      false,
    );
  });

  test('stopSession owns an active Run and a parent turn admitted before reservation', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const activeGate = makeGate();
    let backend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new TestBackend(ctx, activeGate);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_845),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const active = manager
      .sendMessage(session.id, { turnId: 'active-parent-turn', text: 'hold active' })
      [Symbol.asyncIterator]();
    assert.strictEqual((await active.next()).value?.type, 'text_delta');

    const readStarted = makeGate();
    const releaseRead = makeGate();
    store.nextReadHeaderGate = { started: readStarted, release: releaseRead };
    const pending = manager
      .sendMessage(session.id, {
        turnId: 'pending-parent-turn',
        text: 'must become stopped, not failed',
      })
      [Symbol.asyncIterator]();
    const pendingEvent = pending.next();
    await readStarted.promise;

    let stopSettled = false;
    const stopping = manager.stopSession(session.id, { source: 'stop_button' }).finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    assert.strictEqual(stopSettled, false);

    releaseRead.release();
    activeGate.release();
    await stopping;
    assert.strictEqual((await pendingEvent).done, true);
    while (!(await active.next()).done) {}
    assert.deepStrictEqual(
      backend?.sendInputs.map((input) => input.turnId),
      ['active-parent-turn'],
    );
    const runs = await runStore.listSessionRuns(session.id);
    assert.strictEqual(
      runs.find((run) => run.turnId === 'active-parent-turn')?.status,
      'cancelled',
    );
    assert.strictEqual(
      runs.find((run) => run.turnId === 'pending-parent-turn')?.status,
      'cancelled',
    );
    assert.strictEqual((await store.readHeader(session.id)).status, 'aborted');
  });

  test('a factory AbortError is not normalized as execution cancellation', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const buildStarted = makeGate();
    const releaseBuild = makeGate();
    backends.register('ai-sdk', async () => {
      buildStarted.release();
      await releaseBuild.promise;
      const error = new Error('backend activation timed out');
      error.name = 'AbortError';
      throw error;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_845),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const turn = manager
      .sendMessage(session.id, {
        turnId: 'stop-owned-build-reject',
        text: 'must remain a cancelled Run',
      })
      [Symbol.asyncIterator]();
    const firstEvent = turn.next();
    await buildStarted.promise;

    let stopSettled = false;
    const stopping = manager.stopSession(session.id, { source: 'stop_button' }).finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    assert.strictEqual(stopSettled, false);

    releaseBuild.release();
    await expectRejects(firstEvent, /backend activation timed out/);
    await stopping;
    const run = await runStore.readRun(
      session.id,
      (await runStore.listSessionRuns(session.id))[0]!.runId,
    );
    assert.strictEqual(run.status, 'cancelled');
    assert.strictEqual(run.failureClass, undefined);
    assert.strictEqual((await store.readHeader(session.id)).status, 'aborted');
  });

  test('stop signal cooperatively releases a blocked backend factory', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const buildStarted = makeGate();
    let factorySignal: AbortSignal | undefined;
    let dispatches = 0;
    backends.register('ai-sdk', async (ctx) => {
      factorySignal = ctx.abortSignal;
      if (!factorySignal) throw new Error('backend factory did not receive an abort signal');
      buildStarted.release();
      await new Promise<void>((resolve) => {
        factorySignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw factorySignal.reason;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_845),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const turn = manager
      .sendMessage(session.id, {
        turnId: 'cooperative-factory-stop',
        text: 'stop must release backend activation',
      })
      [Symbol.asyncIterator]();
    const firstEvent = turn.next().then((result) => {
      dispatches += result.done ? 0 : 1;
      return result;
    });
    await buildStarted.promise;

    await manager.stopSession(session.id, { source: 'stop_button' });

    assert.strictEqual(factorySignal?.aborted, true);
    assert.strictEqual((await firstEvent).done, true);
    assert.strictEqual(dispatches, 0);
    const [run] = await runStore.listSessionRuns(session.id);
    assert.strictEqual(run?.status, 'cancelled');
  });

  test('node timers AbortError is cancellation only when its cause is this execution stop', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const buildStarted = makeGate();
    backends.register('ai-sdk', async (ctx) => {
      if (!ctx.abortSignal) throw new Error('backend factory did not receive an abort signal');
      buildStarted.release();
      await timerDelay(60_000, undefined, { signal: ctx.abortSignal });
      return new TestBackend(ctx);
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_845),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const turn = manager
      .sendMessage(session.id, {
        turnId: 'native-abort-wrapper-stop',
        text: 'native AbortError should retain exact cancellation cause',
      })
      [Symbol.asyncIterator]();
    const firstEvent = turn.next();
    await buildStarted.promise;

    await manager.stopSession(session.id, { source: 'stop_button' });

    assert.strictEqual((await firstEvent).done, true);
    const [run] = await runStore.listSessionRuns(session.id);
    assert.strictEqual(run?.status, 'cancelled');
    assert.strictEqual(run?.failureClass, undefined);
  });

  test('late ignored-signal backend is disposed once and never cached or dispatched', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const buildStarted = makeGate();
    const releaseBuild = makeGate();
    let builds = 0;
    let firstDisposeCalls = 0;
    let firstDispatches = 0;
    backends.register('ai-sdk', async (ctx) => {
      builds += 1;
      if (builds === 1) {
        buildStarted.release();
        await releaseBuild.promise;
        return {
          kind: 'fake' as const,
          sessionId: ctx.sessionId,
          async *send(): AsyncIterable<SessionEvent> {
            firstDispatches += 1;
          },
          async stop(): Promise<void> {},
          async respondToSandboxBoundary(): Promise<void> {},
          async dispose(): Promise<void> {
            firstDisposeCalls += 1;
          },
        };
      }
      return new TestBackend(ctx);
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_845),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const turn = manager
      .sendMessage(session.id, {
        turnId: 'ignored-factory-stop',
        text: 'late backend must be rejected',
      })
      [Symbol.asyncIterator]();
    const firstEvent = turn.next();
    await buildStarted.promise;

    const stopping = manager.stopSession(session.id, { source: 'stop_button' });
    releaseBuild.release();
    await stopping;

    assert.strictEqual((await firstEvent).done, true);
    assert.strictEqual(firstDisposeCalls, 1);
    assert.strictEqual(firstDispatches, 0);
    const [stoppedRun] = await runStore.listSessionRuns(session.id);
    assert.strictEqual(stoppedRun?.status, 'cancelled');

    await drain(
      manager.sendMessage(session.id, {
        turnId: 'post-ignored-factory-stop',
        text: 'must build a fresh backend',
      }),
    );
    assert.strictEqual(builds, 2);
    assert.strictEqual(firstDisposeCalls, 1);
  });

  test('late cancelled backend disposal failure propagates as an AggregateError', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const buildStarted = makeGate();
    const releaseBuild = makeGate();
    let builds = 0;
    let disposeCalls = 0;
    backends.register('ai-sdk', async (ctx) => {
      builds += 1;
      buildStarted.release();
      await releaseBuild.promise;
      return {
        kind: 'fake' as const,
        sessionId: ctx.sessionId,
        async *send(): AsyncIterable<SessionEvent> {
          throw new Error('cancelled backend must not dispatch');
        },
        async stop(): Promise<void> {},
        async respondToSandboxBoundary(): Promise<void> {},
        async dispose(): Promise<void> {
          disposeCalls += 1;
          throw new Error('late backend disposal failed');
        },
      };
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_845),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const turn = manager
      .sendMessage(session.id, {
        turnId: 'late-disposal-failure',
        text: 'cleanup failure must remain observable',
      })
      [Symbol.asyncIterator]();
    const firstEvent = turn.next();
    await buildStarted.promise;

    const streamRejection = assert.rejects(firstEvent, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /Cancelled backend activation disposal failed/);
      assert.ok(
        error.errors.some(
          (entry) => entry instanceof Error && entry.message === 'late backend disposal failed',
        ),
      );
      return true;
    });
    const stopping = manager.stopSession(session.id, { source: 'stop_button' });
    releaseBuild.release();

    await Promise.all([streamRejection, stopping]);
    assert.strictEqual(disposeCalls, 1);
    const [run] = await runStore.listSessionRuns(session.id);
    assert.strictEqual(run?.status, 'cancelled');

    await expectRejects(
      drain(
        manager.sendMessage(session.id, {
          turnId: 'late-disposal-next-turn',
          text: 'must not create a second backend after quarantine failure',
        }),
      ),
      /permanently quarantined/,
    );
    assert.strictEqual(builds, 1);
    assert.strictEqual(disposeCalls, 1);
  });

  test('concurrent stopSession calls share one stop attempt', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const stopStarted = makeGate();
    const releaseStop = makeGate();
    let backend: ConcurrentStopBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new ConcurrentStopBackend(ctx, stopStarted, releaseStop);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_847),
    });
    const session = await manager.createSession(makeInput());
    const turn = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })
      [Symbol.asyncIterator]();
    await turn.next();

    const firstStop = manager.stopSession(session.id, { source: 'stop_button' });
    await stopStarted.promise;
    let secondStopSettled = false;
    const secondStop = manager.stopSession(session.id, { source: 'stop_button' }).finally(() => {
      secondStopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(secondStopSettled, false);
    releaseStop.release();
    await Promise.all([firstStop, secondStop]);
    while (!(await turn.next()).done) {}

    assert.strictEqual(backend?.stopCalls, 1);
    const messages = await store.readMessages(session.id);
    assert.strictEqual(
      messages.filter((message) => message.type === 'system_note' && message.kind === 'abort')
        .length,
      1,
    );
    assert.strictEqual(
      messages.filter(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'turn-1' &&
          message.status === 'aborted',
      ).length,
      1,
    );
  });

  test('stopSession waits for a registering turn and fences it before backend send', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_847),
    });
    const session = await manager.createSession(makeInput());
    await drain(manager.sendMessage(session.id, { turnId: 'turn-warm-cache', text: 'warm cache' }));
    const readStarted = makeGate();
    const releaseRead = makeGate();
    store.nextReadHeaderGate = { started: readStarted, release: releaseRead };
    const turn = manager
      .sendMessage(session.id, { turnId: 'turn-registering', text: 'hello' })
      [Symbol.asyncIterator]();
    const firstEvent = turn.next();
    await readStarted.promise;

    let stopSettled = false;
    const stop = manager
      .stopSession(session.id, {
        source: 'graph_supervisor',
        mode: 'after_step',
      })
      .finally(() => {
        stopSettled = true;
      });
    await Promise.resolve();
    assert.strictEqual(stopSettled, false);
    releaseRead.release();
    await stop;
    assert.strictEqual((await firstEvent).done, true);

    assert.strictEqual(backend?.stopCalls, 1);
    assert.deepStrictEqual(backend?.stopModes, ['after_step']);
    assert.deepStrictEqual(
      backend?.sendInputs.map((input) => input.turnId),
      ['turn-warm-cache'],
    );
    const registeringRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-registering',
    );
    assert.strictEqual(registeringRun?.status, 'cancelled');
    assert.strictEqual(
      (await runStore.readRuntimeEvents(session.id, registeringRun!.runId)).filter(
        isTerminalRuntimeEvent,
      ).length,
      1,
    );
  });

  test('stopSession fences dispatch after the public onRunStarted hook', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new TestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_847),
    });
    const session = await manager.createSession(makeInput());
    const hookStarted = makeGate();
    const releaseHook = makeGate();
    const turn = manager
      .sendMessage(
        session.id,
        { turnId: 'turn-post-start-hook-stop', text: 'must not dispatch' },
        {
          onRunStarted: async () => {
            hookStarted.release();
            await releaseHook.promise;
          },
        },
      )
      [Symbol.asyncIterator]();
    const firstEvent = turn.next();
    await hookStarted.promise;

    await manager.stopSession(session.id, { source: 'stop_button' });
    releaseHook.release();
    assert.strictEqual((await firstEvent).done, true);
    assert.deepStrictEqual(backend?.sendInputs, []);
    const stoppedRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-post-start-hook-stop',
    );
    assert.strictEqual(stoppedRun?.status, 'cancelled');
  });

  test('concurrent cold turns share one backend generation without accepting an ownerless response', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const buildStarted = makeGate();
    const releaseBuild = makeGate();
    const releaseSend = makeGate();
    let builds = 0;
    let backend: PermissionBroadcastBackend | undefined;
    backends.register('ai-sdk', async (ctx) => {
      builds += 1;
      buildStarted.release();
      await releaseBuild.promise;
      backend = new PermissionBroadcastBackend(ctx, releaseSend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_847),
    });
    const session = await manager.createSession(makeInput());
    const first = manager
      .sendMessage(session.id, { turnId: 'cold-turn-1', text: 'first' })
      [Symbol.asyncIterator]();
    const second = manager
      .sendMessage(session.id, { turnId: 'cold-turn-2', text: 'second' })
      [Symbol.asyncIterator]();
    const firstEvent = first.next();
    await buildStarted.promise;
    const secondEvent = second.next();
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(builds, 1);

    releaseBuild.release();
    assert.strictEqual((await firstEvent).value?.type, 'text_delta');
    assert.strictEqual((await secondEvent).value?.type, 'text_delta');
    await expectRejects(
      manager.respondToSandboxBoundary(session.id, {
        requestId: 'control-broadcast',
        decision: 'deny',
      }),
      /No pending sandbox boundary request/,
    );
    assert.strictEqual(backend?.permissionResponses, 0);
    assert.strictEqual(builds, 1);

    releaseSend.release();
    while (!(await first.next()).done) {}
    while (!(await second.next()).done) {}
    assert.strictEqual(backend?.sendInputs?.length, 2);
  });

  test('stopSession retries only unfinished projections', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const sendGate = makeGate();
    let backend: CountingStopBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new CountingStopBackend(ctx, sendGate);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_849),
    });
    const session = await manager.createSession(makeInput());
    const turn = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })
      [Symbol.asyncIterator]();
    await turn.next();
    store.failAfterNextAppendMessage = (message) =>
      message.type === 'system_note' && message.kind === 'abort';

    await expectRejects(
      manager.stopSession(session.id, { source: 'stop_button' }),
      /append message failed/,
    );
    await manager.stopSession(session.id, { source: 'stop_button' });

    assert.strictEqual(backend?.stopCalls, 1);
    const messages = await store.readMessages(session.id);
    assert.strictEqual(
      messages.filter(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'turn-1' &&
          message.status === 'aborted',
      ).length,
      1,
    );
    assert.strictEqual(
      messages.filter((message) => message.type === 'system_note' && message.kind === 'abort')
        .length,
      1,
    );
    sendGate.release();
    while (!(await turn.next()).done) {}
  });

  test('stopSession retains a failed projection after its Run exits without reentering backend stop', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const sendGate = makeGate();
    let backend: CountingStopBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new CountingStopBackend(ctx, sendGate);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_850),
    });
    const session = await manager.createSession(makeInput());
    const turn = manager
      .sendMessage(session.id, { turnId: 'turn-retained-stop', text: 'hello' })
      [Symbol.asyncIterator]();
    await turn.next();
    store.failUpdateHeaderFor.add(session.id);

    await expectRejects(
      manager.stopSession(session.id, { source: 'stop_button' }),
      /Cannot update header/,
    );
    sendGate.release();
    while (!(await turn.next()).done) {}
    store.failUpdateHeaderFor.delete(session.id);

    await manager.stopSession(session.id, { source: 'stop_button' });

    assert.strictEqual(backend?.stopCalls, 1);
    const messages = await store.readMessages(session.id);
    assert.strictEqual(
      messages.filter(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'turn-retained-stop' &&
          message.status === 'aborted',
      ).length,
      1,
    );
    assert.strictEqual(
      messages.filter((message) => message.type === 'system_note' && message.kind === 'abort')
        .length,
      1,
    );
  });

  test('agent projections list catalog definitions separately from child runs and read output artifacts by child turn', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      listArtifactsForTurn: async (_sessionId, turnId) =>
        turnId === 'child-turn'
          ? [
              {
                id: 'artifact-1',
                sessionId: 'session-1',
                turnId,
                createdAt: 200,
                name: 'notes.md',
                kind: 'file',
                relativePath: 'artifacts/notes.md',
                sizeBytes: 12,
                status: 'live',
              },
            ]
          : [],
      newId: nextId(),
      now: nextNow(6_848),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'parent-run',
        turnId: 'parent-turn',
        status: 'completed',
        createdAt: 100,
        updatedAt: 110,
        completedAt: 110,
      }),
      [
        runtimeEvent({
          id: 'parent-user',
          sessionId: session.id,
          runId: 'parent-run',
          turnId: 'parent-turn',
          ts: 101,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'parent' },
        }),
        runtimeEvent({
          id: 'parent-complete',
          sessionId: session.id,
          runId: 'parent-run',
          turnId: 'parent-turn',
          ts: 110,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'child-run',
        turnId: 'child-turn',
        status: 'completed',
        createdAt: 120,
        updatedAt: 130,
        completedAt: 130,
        parentRunId: 'parent-run',
        agentId: LOCAL_READ_AGENT_ID,
        agentName: 'Researcher',
        permissionMode: 'explore',
      }),
      [
        runtimeEvent({
          id: 'child-user',
          sessionId: session.id,
          runId: 'child-run',
          turnId: 'child-turn',
          ts: 121,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'inspect' },
        }),
        runtimeEvent({
          id: 'child-answer',
          sessionId: session.id,
          runId: 'child-run',
          turnId: 'child-turn',
          ts: 125,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'child answer' },
        }),
        runtimeEvent({
          id: 'child-complete',
          sessionId: session.id,
          runId: 'child-run',
          turnId: 'child-turn',
          ts: 130,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'continuation-run',
        turnId: 'continuation-turn',
        status: 'completed',
        createdAt: 140,
        updatedAt: 150,
        completedAt: 150,
        parentRunId: 'parent-run',
        parentTurnId: 'parent-turn',
        continuationSource: {
          sourceInvocationId: 'parent-invocation',
          sourceRunId: 'parent-run',
          sourceTurnId: 'parent-turn',
          sourceRuntimeEventHighWater: 2,
        },
      }),
      [
        runtimeEvent({
          id: 'continuation-answer',
          sessionId: session.id,
          runId: 'continuation-run',
          turnId: 'continuation-turn',
          ts: 145,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'continued answer' },
        }),
        runtimeEvent({
          id: 'continuation-complete',
          sessionId: session.id,
          runId: 'continuation-run',
          turnId: 'continuation-turn',
          ts: 150,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );

    const list = await manager.listChildAgents(session.id);
    assert.deepStrictEqual(
      list.definitions.map((agent) => agent.id),
      [LOCAL_READ_AGENT_ID, WEB_RESEARCH_AGENT_ID, IMPLEMENTATION_AGENT_ID],
    );
    assert.deepStrictEqual(list.definitions[0]?.availability, { status: 'available' });
    assert.strictEqual(list.definitions[0]?.contract.defaultWriteBack, 'summary');
    assert.strictEqual(list.definitions[0]?.contract.workspace, 'same_workspace');
    assert.deepStrictEqual(list.definitions[1]?.availability, {
      status: 'unavailable',
      reason: 'missing_tools',
      missingTools: ['WebSearch'],
    });
    assert.deepStrictEqual(list.definitions[2]?.availability, {
      status: 'unavailable',
      reason: 'workspace_isolation_unavailable',
      workspace: AGENT_WORKSPACE_WORKTREE,
      requiredRuntime: 'worktree_child_executor',
    });
    assert.deepStrictEqual(
      list.runs.map((agent) => agent.runId),
      ['child-run'],
    );
    assert.deepStrictEqual(
      list.executions.map((agent) => agent.execution),
      [
        {
          kind: 'legacy_child_run',
          sessionId: session.id,
          runId: 'child-run',
        },
      ],
    );
    assert.strictEqual(list.runs[0]?.agentId, LOCAL_READ_AGENT_ID);
    assert.strictEqual(list.runs[0]?.agentName, 'Researcher');
    assert.strictEqual(list.runs[0]?.durationMs, 10);

    const output = await manager.readChildAgentOutput(session.id, { runId: 'child-run' });
    assert.strictEqual(output.header.runId, 'child-run');
    assert.deepStrictEqual(
      output.runtimeEvents.map((event) => event.id),
      ['child-user', 'child-answer', 'child-complete'],
    );
    assert.deepStrictEqual(
      output.artifacts.map((artifact) => artifact.id),
      ['artifact-1'],
    );
  });

  test('child agent projections use the terminal RuntimeEvent fact when the child header is stale', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_900),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'parent-run',
        turnId: 'parent-turn',
        status: 'running',
        createdAt: 100,
        updatedAt: 120,
      }),
      [
        runtimeEvent({
          id: 'parent-complete',
          sessionId: session.id,
          runId: 'parent-run',
          turnId: 'parent-turn',
          ts: 120,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'child-run',
        turnId: 'child-turn',
        status: 'running',
        createdAt: 130,
        updatedAt: 140,
        parentRunId: 'parent-run',
        agentId: LOCAL_READ_AGENT_ID,
        agentName: 'Researcher',
        permissionMode: 'explore',
      }),
      [
        runtimeEvent({
          id: 'child-answer',
          sessionId: session.id,
          runId: 'child-run',
          turnId: 'child-turn',
          ts: 135,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'child answer' },
        }),
        runtimeEvent({
          id: 'child-complete',
          sessionId: session.id,
          runId: 'child-run',
          turnId: 'child-turn',
          ts: 140,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );

    const list = await manager.listChildAgents(session.id);
    assert.strictEqual(list.runs[0]?.runId, 'child-run');
    assert.strictEqual(list.runs[0]?.status, 'completed');
    assert.strictEqual(list.runs[0]?.completedAt, 140);
    assert.strictEqual(list.runs[0]?.durationMs, 10);

    const output = await manager.readChildAgentOutput(session.id, { runId: 'child-run' });
    assert.strictEqual(output.header.status, 'completed');
    assert.strictEqual(output.header.completedAt, 140);
  });

  test('agent output returns a bounded child inspection instead of full replay internals', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_849),
    });
    const session = await manager.createSession(makeInput());
    const header = makeRunHeader({
      sessionId: session.id,
      runId: 'child-run',
      turnId: 'child-turn',
      status: 'completed',
      createdAt: 120,
      updatedAt: 200,
      completedAt: 200,
      parentRunId: 'parent-run',
      agentId: LOCAL_READ_AGENT_ID,
      agentName: 'Researcher',
      permissionMode: 'explore',
    });
    await runStore.createRun(header);
    for (let index = 0; index < 25; index += 1) {
      await runStore.appendEvent(
        session.id,
        'child-run',
        makeRunEvent({
          id: `op-${index}`,
          sessionId: session.id,
          runId: 'child-run',
          turnId: 'child-turn',
          type: 'model_stream_started',
          ts: 120 + index,
        }),
      );
      await runStore.appendRuntimeEvent(
        session.id,
        'child-run',
        runtimeEvent({
          id: `rt-${index}`,
          sessionId: session.id,
          runId: 'child-run',
          turnId: 'child-turn',
          ts: 120 + index,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: `line ${index}` },
        }),
      );
    }

    const output = await manager.readChildAgentOutput(session.id, {
      runId: 'child-run',
      maxEvents: 5,
      view: 'all',
    });

    assert.strictEqual(output.header.runId, 'child-run');
    assert.deepStrictEqual(
      output.events.map((event) => event.id),
      ['op-20', 'op-21', 'op-22', 'op-23', 'op-24'],
    );
    assert.deepStrictEqual(
      output.runtimeEvents.map((event) => event.id),
      ['rt-20', 'rt-21', 'rt-22', 'rt-23', 'rt-24'],
    );
    assert.strictEqual(output.truncated.events, true);
    assert.strictEqual(output.truncated.runtimeEvents, true);
    assert.strictEqual(output.budget.view, 'all');
    assert.strictEqual(output.budget.projectedBytes <= output.budget.maxBytes, true);
    assert.strictEqual('modelReplay' in output, false);
    assert.strictEqual('projection' in output, false);
  });

  test('agent output bounds oversized runtime events by serialized bytes', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_849),
    });
    const session = await manager.createSession(makeInput());
    await runStore.createRun(
      makeRunHeader({
        sessionId: session.id,
        runId: 'child-run',
        turnId: 'child-turn',
        status: 'completed',
        createdAt: 120,
        updatedAt: 200,
        completedAt: 200,
        parentRunId: 'parent-run',
        agentId: LOCAL_READ_AGENT_ID,
        agentName: 'Researcher',
        permissionMode: 'explore',
      }),
    );
    await runStore.appendRuntimeEvent(
      session.id,
      'child-run',
      runtimeEvent({
        id: 'oversized',
        sessionId: session.id,
        runId: 'child-run',
        turnId: 'child-turn',
        ts: 130,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'x'.repeat(64 * 1024) },
      }),
    );
    await runStore.appendRuntimeEvent(
      session.id,
      'child-run',
      runtimeEvent({
        id: 'final',
        sessionId: session.id,
        runId: 'child-run',
        turnId: 'child-turn',
        ts: 140,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'bounded final result' },
      }),
    );

    const output = await manager.readChildAgentOutput(session.id, {
      runId: 'child-run',
      maxEvents: 20,
      maxBytes: 1024,
    });

    assert.deepStrictEqual(output.events, []);
    assert.deepStrictEqual(
      output.runtimeEvents.map((event) => event.id),
      ['final'],
    );
    assert.strictEqual(output.truncated.events, true);
    assert.strictEqual(output.truncated.runtimeEvents, true);
    assert.strictEqual(output.truncated.bytes, true);
    assert.partialDeepStrictEqual(output.budget, {
      view: 'runtime_events',
      maxBytes: 1024,
    });
    assert.strictEqual(output.budget.projectedBytes <= output.budget.maxBytes, true);
  });

  test('backend build failure after user append writes a failed terminal run fact', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', () => {
      throw new Error('backend init failed');
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(7_500),
    });
    const session = await manager.createSession(makeInput());

    await expectRejects(
      drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })),
      /backend init failed/,
    );

    const header = await store.readHeader(session.id);
    assert.strictEqual(header.status, 'blocked');
    assert.strictEqual(header.blockedReason, 'unknown');
    const messages = await store.readMessages(session.id);
    assert.strictEqual(
      messages.some((message) => message.type === 'user' && message.turnId === 'turn-1'),
      true,
    );
    const turn = (await store.listTurns(session.id)).find(
      (candidate) => candidate.turnId === 'turn-1',
    );
    assert.strictEqual(turn?.status, 'failed');
    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('AgentRunStore run was not created');
    assert.strictEqual(run.status, 'failed');
    assert.strictEqual(run.failureClass, 'missing_terminal_event');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    assert.strictEqual(terminalEvents.length, 1);
    assert.strictEqual(terminalEvents[0]?.status, 'failed');
    assert.strictEqual(
      terminalEvents[0]?.actions?.stateDelta?.failureClass,
      'missing_terminal_event',
    );
    assert.strictEqual(
      (await manager.getMessages(session.id)).some((message) => message.type === 'user'),
      true,
    );
  });

  test('marks a sandbox boundary request waiting and blocks boundary mode changes', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: SandboxBoundaryWaitBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new SandboxBoundaryWaitBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(9_000),
    });
    const session = await manager.createSession(makeInput());

    const iterator = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })
      [Symbol.asyncIterator]();
    assert.strictEqual((await iterator.next()).value?.type, 'sandbox_boundary_request');
    const [activeBoundaryRequest] = await manager.listActiveInteractions(session.id);
    assert.partialDeepStrictEqual(activeBoundaryRequest, {
      type: 'sandbox_boundary_request',
      requestId: 'boundary-1',
      toolUseId: 'tool-1',
      turnId: 'turn-1',
    });

    assert.strictEqual((await store.readHeader(session.id)).status, 'waiting_for_user');
    const [run] = await runStore.listSessionRuns(session.id);
    assert.strictEqual(run?.status, 'waiting_for_user');
    await expectRejects(manager.setPermissionMode(session.id, 'bypass'), /当前任务正在运行/);
    assert.strictEqual((await store.readHeader(session.id)).permissionMode, 'ask');

    await manager.respondToSandboxBoundary(session.id, {
      requestId: 'boundary-1',
      decision: 'deny',
    });
    assert.deepStrictEqual(backend?.responses, [{ requestId: 'boundary-1', decision: 'deny' }]);
    assert.strictEqual((await iterator.next()).value?.type, 'sandbox_boundary_decision_ack');
    assert.deepStrictEqual(await manager.listActiveInteractions(session.id), []);
    while (!(await iterator.next()).done) {}
    assert.strictEqual((await store.readHeader(session.id)).status, 'active');
  });

  test('lists an unanswered user question until its answer ack lands', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new FakeBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(9_000),
    });
    const session = await manager.createSession(makeInput());

    const iterator = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: FAKE_ASK_USER_QUESTION_PROMPT })
      [Symbol.asyncIterator]();
    let request: SessionEvent | undefined;
    while (request?.type !== 'user_question_request') {
      const next = await iterator.next();
      if (next.done) break;
      request = next.value;
    }
    assert.strictEqual(request?.type, 'user_question_request');

    // The surface that raised this request may never have been mounted, so the
    // request has to be readable back from the kernel (#2072).
    const active = await manager.listActiveInteractions(session.id);
    assert.deepStrictEqual(active, [request]);

    const requestId = (request as Extract<SessionEvent, { type: 'user_question_request' }>)
      .requestId;
    // One registry now holds both request kinds, so answering a question as if
    // it were a boundary must settle nothing and leave the entry intact.
    await expectRejects(
      manager.respondToSandboxBoundary(session.id, { requestId, decision: 'deny' }),
      /No pending sandbox boundary request/,
    );
    assert.deepStrictEqual(await manager.listActiveInteractions(session.id), [request]);

    await manager.respondToUserQuestion(session.id, {
      requestId,
      answers: ['邀请制', '本周', '是'],
    });
    let ack: SessionEvent | undefined;
    while (ack?.type !== 'user_question_answer_ack') {
      const next = await iterator.next();
      if (next.done) break;
      ack = next.value;
    }
    assert.strictEqual(ack?.type, 'user_question_answer_ack');
    assert.deepStrictEqual(await manager.listActiveInteractions(session.id), []);
    while (!(await iterator.next()).done) {}
  });

  test('releases a question abandoned by a stopped turn', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new FakeBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(9_000),
    });
    const session = await manager.createSession(makeInput());

    const iterator = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: FAKE_ASK_USER_QUESTION_PROMPT })
      [Symbol.asyncIterator]();
    let request: SessionEvent | undefined;
    while (request?.type !== 'user_question_request') {
      const next = await iterator.next();
      if (next.done) break;
      request = next.value;
    }
    assert.strictEqual(request?.type, 'user_question_request');

    // A stop settles no answer, so this question never gets its ack. Only the
    // turn-end release keeps it from being read back as a prompt for a dead
    // run — one nothing could answer, since the backend generation is gone.
    await manager.stopSession(session.id, { source: 'stop_button' });
    while (!(await iterator.next()).done) {}
    assert.deepStrictEqual(await manager.listActiveInteractions(session.id), []);
  });

  test('reads a completed session back after a sandbox boundary allow', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new SandboxBoundaryWaitBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(9_500),
    });
    const session = await manager.createSession(makeInput());

    const iterator = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })
      [Symbol.asyncIterator]();
    assert.strictEqual((await iterator.next()).value?.type, 'sandbox_boundary_request');
    await manager.respondToSandboxBoundary(session.id, {
      requestId: 'boundary-1',
      decision: 'allow',
    });
    while (!(await iterator.next()).done) {}

    const messages = await manager.getMessages(session.id);
    assert.strictEqual(
      messages.some((message) => message.type === 'user'),
      true,
    );
    const turns = await manager.listTurns(session.id);
    assert.strictEqual(turns.find((turn) => turn.turnId === 'turn-1')?.status, 'completed');
  });

  // The next unclaimed control fact must not repeat #1607. A complete ledger
  // with one event the projection was never taught still reads back — messages,
  // turns and every turn-scoped action — and the unclaimed event is reported as
  // a diagnostic rather than costing the session that contains it.
  test('reads a completed session back with an unclaimed control fact in its ledger', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new UnmappedSessionEventBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(9_600),
    });
    const session = await manager.createSession(makeInput());

    for await (const _event of manager.sendMessage(session.id, {
      turnId: 'turn-1',
      text: 'hello',
    })) {
      // drain
    }

    const messages = await manager.getMessages(session.id);
    assert.strictEqual(messages.filter((message) => message.type === 'user').length, 1);
    assert.strictEqual(
      messages.some((message) => message.type === 'assistant' && message.text === 'hi back'),
      true,
    );
    const turns = await manager.listTurns(session.id);
    assert.strictEqual(turns.find((turn) => turn.turnId === 'turn-1')?.status, 'completed');

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
    }).getSessionView(session.id);
    assert.strictEqual(
      view.diagnostics.filter((diagnostic) => diagnostic.code === 'unclaimed_control_fact').length,
      1,
    );
  });

  // The counterpart of the soft case, at the caller that enforces the policy:
  // an unclaimed event that carries content may have cost a reader a row, so
  // getSessionView must still refuse the view rather than serve a lossy one.
  test('refuses a session view when an unclaimed event carries content', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new UnmappedSessionEventBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(9_700),
    });
    const session = await manager.createSession(makeInput());

    for await (const _event of manager.sendMessage(session.id, {
      turnId: 'turn-1',
      text: 'hello',
    })) {
      // drain
    }

    const [run] = await runStore.listSessionRuns(session.id);
    await runStore.appendRuntimeEvent(
      session.id,
      run!.runId,
      runtimeEvent({
        id: 'unclaimed-content',
        sessionId: session.id,
        runId: run!.runId,
        turnId: 'turn-1',
        ts: 4,
        role: 'model',
        author: 'agent',
        content: { kind: 'not_yet_projected', text: 'a reader would have seen this' } as never,
      }),
    );

    await assert.rejects(
      new RuntimeReadModel({ runStore, runtimeEventStore: runStore }).getSessionView(session.id),
      (error: unknown) =>
        error instanceof RuntimeReadModelError &&
        error.diagnostics.some((diagnostic) => diagnostic.code === 'unsupported_event'),
    );
  });

  test('complete(stopReason=error) without a prior error event classifies as runtime_error not unknown', async () => {
    // Reproduces the DeepSeek-reasoner smoke failure: the backend ended with
    // stopReason='error' but never emitted a preceding error event, so the
    // run ledger's failureClass was 'unknown'. It should be 'runtime_error'
    // so benchmark scoring can distinguish runtime failures from max_tokens.
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) => new EventBackend(ctx, [{ type: 'complete', stopReason: 'error' }]),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(10_000),
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const [turn] = await store.listTurns(session.id);
    assert.strictEqual(turn?.status, 'failed');
    assert.strictEqual(turn?.errorClass, 'runtime_error');
    const [run] = await runStore.listSessionRuns(session.id);
    assert.strictEqual(run?.failureClass, 'runtime_error');
  });

  test('marks an explicit step limit incomplete without blocking the session', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) => new EventBackend(ctx, [{ type: 'complete', stopReason: 'step_limit' }]),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(10_000),
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    assert.strictEqual((await store.readHeader(session.id)).status, 'active');
    const [turn] = await store.listTurns(session.id);
    assert.strictEqual(turn?.status, 'failed');
    assert.strictEqual(turn?.errorClass, 'tool_step_cap_reached');
    const [run] = await runStore.listSessionRuns(session.id);
    assert.strictEqual(run?.status, 'failed');
    assert.strictEqual(run?.failureClass, 'tool_step_cap_reached');
    const terminal = (await runStore.readRuntimeEvents(session.id, run!.runId)).find(
      (event) => event.actions?.endInvocation,
    );
    assert.strictEqual(terminal?.status, 'failed');
    assert.partialDeepStrictEqual(terminal?.actions?.stateDelta, {
      stopReason: 'step_limit',
      failureClass: 'tool_step_cap_reached',
    });
  });

  test('does not let a late complete event overwrite a prior turn error', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new EventBackend(ctx, [
          { type: 'error', recoverable: false, reason: 'tool_failed', message: 'Tool failed' },
          { type: 'complete', stopReason: 'end_turn' },
        ]),
    );
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(10_500) });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const states = (await store.readMessages(session.id)).filter(
      (message) => message.type === 'turn_state' && message.turnId === 'turn-1',
    );
    assert.deepStrictEqual(
      states.map((state) => (state.type === 'turn_state' ? state.status : '')),
      ['running', 'failed'],
    );
    const [turn] = await store.listTurns(session.id);
    assert.strictEqual(turn?.status, 'failed');
    assert.strictEqual(turn?.errorClass, 'tool_failed');
  });

  test('stopSession records renderer abort source for diagnostics', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    const gate = makeGate();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx, gate));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(12_500) });
    const session = await manager.createSession(makeInput());

    const iterator = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })
      [Symbol.asyncIterator]();
    await iterator.next();
    await manager.stopSession(session.id, { source: 'stop_button' });

    const [turn] = await store.listTurns(session.id);
    assert.strictEqual(turn?.status, 'aborted');
    assert.strictEqual(turn?.abortSource, 'renderer.stop_button');
    const abortNote = (await store.readMessages(session.id)).find(
      (message) => message.type === 'system_note' && message.kind === 'abort',
    );
    assert.strictEqual(abortNote?.type, 'system_note');
    if (abortNote?.type !== 'system_note') throw new Error('abort note missing');
    assert.deepStrictEqual(abortNote.data, { source: 'renderer.stop_button' });
  });

  test('stopSession persists abortSource on a terminal RuntimeEvent emitted during backend stop', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: StopControlledAbortBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new StopControlledAbortBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_710),
    });
    const session = await manager.createSession(makeInput());

    const iterator = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })
      [Symbol.asyncIterator]();
    await iterator.next();
    const pendingAbort = iterator.next();
    const stopPromise = manager.stopSession(session.id, { source: 'stop_button' });
    const abort = await pendingAbort;
    assert.strictEqual(abort.value?.type, 'abort');
    backend?.allowStopReturn();
    await stopPromise;
    while (!(await iterator.next()).done) {}

    const [run] = await runStore.listSessionRuns(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run!.runId);
    const terminalEvents = runtimeEvents.filter((event) => event.status === 'aborted');
    assert.strictEqual(terminalEvents.length, 1);
    assert.strictEqual(terminalEvents[0]?.actions?.stateDelta?.abortSource, 'renderer.stop_button');
    const messages = await manager.getMessages(session.id);
    assert.strictEqual(
      messages.some((message) => message.type === 'user' && message.turnId === 'turn-1'),
      true,
    );
    assert.deepStrictEqual(
      messages.find((message) => message.type === 'turn_state'),
      {
        type: 'turn_state',
        id: terminalEvents[0]?.id,
        turnId: 'turn-1',
        ts: 2,
        status: 'aborted',
        abortedAt: 2,
        abortSource: 'renderer.stop_button',
        partialOutputRetained: false,
      },
    );
  });

  test('sendMessage does not emit or persist backend events after the first terminal event', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new EventBackend(ctx, [
          { type: 'text_delta', messageId: 'm1', text: 'before' },
          { type: 'abort', reason: 'user_stop' },
          { type: 'text_delta', messageId: 'm1', text: 'after-terminal' },
          { type: 'complete', stopReason: 'user_stop' },
        ]),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_715),
    });
    const session = await manager.createSession(makeInput());

    const emitted = await collectSessionEvents(
      manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }),
    );
    const [run] = await runStore.listSessionRuns(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run!.runId);
    const turnStates = (await store.readMessages(session.id)).filter(
      (message) =>
        message.type === 'turn_state' &&
        message.turnId === 'turn-1' &&
        message.status !== 'running',
    );

    assert.deepStrictEqual(
      emitted.map((event) => event.type),
      ['text_delta', 'abort'],
    );
    assert.deepStrictEqual(
      runtimeEvents
        .filter((event) => event.role === 'model' && event.content?.kind === 'text')
        .map((event) => (event.content?.kind === 'text' ? event.content.text : '')),
      ['before'],
    );
    const abortedEvents = runtimeEvents.filter((event) => event.status === 'aborted');
    assert.strictEqual(abortedEvents.length, 1);
    assert.strictEqual(abortedEvents[0]?.actions?.stateDelta?.abortSource, 'user_stop');
    assert.strictEqual(run?.status, 'cancelled');
    assert.strictEqual(run?.abortSource, 'user_stop');
    assert.strictEqual(turnStates.length, 1);
    assert.strictEqual(
      turnStates[0]?.type === 'turn_state' ? turnStates[0].status : undefined,
      'aborted',
    );
    assert.strictEqual(
      turnStates[0]?.type === 'turn_state' ? turnStates[0].abortSource : undefined,
      'user_stop',
    );
  });

  test('sendMessage ignores backend errors thrown after a completed terminal event is recorded', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new ThrowAfterTerminalBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_716),
    });
    const session = await manager.createSession(makeInput());

    const emitted = await collectSessionEvents(
      manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }),
    );
    const [run] = await runStore.listSessionRuns(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run!.runId);
    const turnStates = (await store.readMessages(session.id)).filter(
      (message) =>
        message.type === 'turn_state' &&
        message.turnId === 'turn-1' &&
        message.status !== 'running',
    );

    assert.deepStrictEqual(
      emitted.map((event) => event.type),
      ['text_delta', 'complete'],
    );
    assert.strictEqual(run?.status, 'completed');
    assert.deepStrictEqual(
      runtimeEvents
        .filter((event) => event.role === 'model' && event.content?.kind === 'text')
        .map((event) => (event.content?.kind === 'text' ? event.content.text : '')),
      ['before'],
    );
    assert.strictEqual(runtimeEvents.filter((event) => event.status === 'completed').length, 1);
    assert.strictEqual(runtimeEvents.filter((event) => event.status === 'failed').length, 0);
    assert.strictEqual(turnStates.length, 1);
    assert.strictEqual(
      turnStates[0]?.type === 'turn_state' ? turnStates[0].status : undefined,
      'completed',
    );
  });

  test('stopSession keeps aborted state even if the backend emits a late error', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const gate = makeGate();
    backends.register('ai-sdk', (ctx) => new LateErrorBackend(ctx, gate));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_720),
    });
    const session = await manager.createSession(makeInput());

    const iterator = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })
      [Symbol.asyncIterator]();
    await iterator.next();
    await manager.stopSession(session.id, { source: 'stop_button' });

    gate.release();
    await iterator.next();
    await iterator.next();
    await iterator.next();

    assert.strictEqual((await store.readHeader(session.id)).status, 'aborted');
    const [turn] = await store.listTurns(session.id);
    assert.strictEqual(turn?.status, 'aborted');
    assert.strictEqual(turn?.abortSource, 'renderer.stop_button');
    const [run] = await runStore.listSessionRuns(session.id);
    assert.strictEqual(run?.status, 'cancelled');
    assert.strictEqual(run?.failureClass, undefined);
    const events = (await runStore.readEvents(session.id, run!.runId)).map((event) => event.type);
    assert.ok(events.includes('run_cancelled'));
    assert.strictEqual(events.includes('run_failed'), false);
  });

  test('durable run ledger records lifecycle trace events and redacts obvious secrets', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TraceBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_750),
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const [run] = await runStore.listSessionRuns(session.id);
    assert.strictEqual(run?.backendKind, 'ai-sdk');
    assert.strictEqual(run?.llmConnectionSlug, 'fake');
    assert.strictEqual(run?.modelId, 'fake-model');
    assert.strictEqual(run?.permissionMode, 'ask');
    assert.strictEqual(run?.status, 'completed');
    const events = await runStore.readEvents(session.id, run!.runId);
    assert.ok(events.map((event) => event.type).includes('model_stream_started'));
    assert.ok(events.map((event) => event.type).includes('model_stream_completed'));
    assert.ok(events.map((event) => event.type).includes('run_completed'));
    assert.strictEqual(JSON.stringify(events).includes('sk-live-secret-token-value'), false);
  });

  test('history compact cleanup includes continuation events without including child agent events', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const cleanupCalled = makeGate();
    let observedEventIds: string[] = [];
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new HistoryCompactCheckpointBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      cleanupHistoryCompactArtifacts: async (input) => {
        observedEventIds = input.runtimeEvents.map((event) => event.id);
        cleanupCalled.release();
      },
      newId: nextId(),
      now: nextNow(12_794),
    });
    const session = await manager.createSession(makeInput());
    const sourceRunId = 'cleanup-source-run';
    const sourceTurnId = 'cleanup-source-turn';
    const sourceInvocationId = 'cleanup-source-invocation';
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: sourceRunId,
        turnId: sourceTurnId,
        status: 'completed',
        createdAt: 100,
        updatedAt: 101,
        completedAt: 101,
      }),
      [
        runtimeEvent({
          id: 'cleanup-source-complete',
          invocationId: sourceInvocationId,
          sessionId: session.id,
          runId: sourceRunId,
          turnId: sourceTurnId,
          ts: 101,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'cleanup-continuation-run',
        turnId: 'cleanup-continuation-turn',
        status: 'completed',
        parentRunId: sourceRunId,
        parentTurnId: sourceTurnId,
        continuationSource: {
          sourceInvocationId,
          sourceRunId,
          sourceTurnId,
          sourceRuntimeEventHighWater: 1,
        },
        createdAt: 102,
        updatedAt: 104,
        completedAt: 104,
      }),
      [
        runtimeEvent({
          id: 'cleanup-continuation-text',
          invocationId: 'cleanup-continuation-invocation',
          sessionId: session.id,
          runId: 'cleanup-continuation-run',
          turnId: 'cleanup-continuation-turn',
          ts: 103,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'continued output' },
        }),
        runtimeEvent({
          id: 'cleanup-continuation-complete',
          invocationId: 'cleanup-continuation-invocation',
          sessionId: session.id,
          runId: 'cleanup-continuation-run',
          turnId: 'cleanup-continuation-turn',
          ts: 104,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'cleanup-child-run',
        turnId: 'cleanup-child-turn',
        status: 'completed',
        parentRunId: sourceRunId,
        parentTurnId: sourceTurnId,
        createdAt: 105,
        updatedAt: 107,
        completedAt: 107,
      }),
      [
        runtimeEvent({
          id: 'cleanup-child-text',
          invocationId: 'cleanup-child-invocation',
          sessionId: session.id,
          runId: 'cleanup-child-run',
          turnId: 'cleanup-child-turn',
          ts: 106,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'private child output' },
        }),
        runtimeEvent({
          id: 'cleanup-child-complete',
          invocationId: 'cleanup-child-invocation',
          sessionId: session.id,
          runId: 'cleanup-child-run',
          turnId: 'cleanup-child-turn',
          ts: 107,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );

    await drain(
      manager.sendMessage(session.id, { turnId: 'cleanup-current-turn', text: 'continue' }),
    );
    await cleanupCalled.promise;

    assert.ok(observedEventIds.includes('cleanup-continuation-text'));
    assert.ok(!observedEventIds.includes('cleanup-child-text'));
  });

  test('persists an explicit same-coverage successor checkpoint', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const writeOutcomes: string[] = [];
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) => new SameCoverageCheckpointReplacementProbeBackend(ctx, writeOutcomes),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_796),
    });
    const session = await manager.createSession(makeInput());

    await drain(
      manager.sendMessage(session.id, { turnId: 'same-coverage-initial', text: 'hello' }),
    );
    await drain(
      manager.sendMessage(session.id, { turnId: 'same-coverage-replacement', text: 'hello again' }),
    );

    assert.deepStrictEqual(writeOutcomes, [
      'same-coverage-initial:fulfilled',
      'same-coverage-replacement:fulfilled',
    ]);
    const checkpoints: HistoryCompactCheckpoint[] = [];
    for (const run of await runStore.listSessionRuns(session.id)) {
      for (const event of await runStore.readEvents(session.id, run.runId)) {
        if (event.type === 'history_compact_checkpoint_recorded') {
          checkpoints.push(event.data?.checkpoint as HistoryCompactCheckpoint);
        }
      }
    }
    assert.strictEqual(checkpoints.length, 2);
    assert.strictEqual(checkpoints[1]?.previousCheckpointId, checkpoints[0]?.checkpointId);
    assert.deepStrictEqual(checkpoints[1]?.coverage, checkpoints[0]?.coverage);
  });

  test('rejects checkpoint recording after the current AgentRun store becomes unavailable', async () => {
    const store = new MemorySessionStore();
    const runStoreUnavailable = makeGate();
    const writeOutcomes: string[] = [];
    const runStore = new MemoryAgentRunStore({
      beforeAgentRunEventAppend: async (_sessionId, _runId, event) => {
        if (event.type === 'run_started') throw new Error('run ledger append failed');
        if (event.type === 'trace_write_failed') runStoreUnavailable.release();
      },
    });
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new CheckpointRecorderContractProbeBackend(
          ctx,
          async () => runStoreUnavailable.promise,
          writeOutcomes,
        ),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_800),
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'store-unavailable', text: 'hello' }));

    assert.deepStrictEqual(writeOutcomes, ['store-unavailable:rejected']);
  });

  test('recovers a missing projection before rejecting a shorter cold-start checkpoint', async () => {
    const store = new MemorySessionStore();
    const runStore = new MissingCheckpointProjectionAgentRunStore();
    const writeOutcomes: string[] = [];
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) => new CheckpointRecorderContractProbeBackend(ctx, async () => {}, writeOutcomes),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_803),
    });
    const session = await manager.createSession(makeInput());
    const durableCheckpoint = buildHistoryCompactCheckpoint({
      sessionId: session.id,
      coveredRuntimeEvents: Array.from(
        { length: 10 },
        (_, index): RuntimeEvent => ({
          id: `cold-durable-event-${index}`,
          sessionId: session.id,
          runId: `cold-durable-run-${index}`,
          turnId: `cold-durable-turn-${index}`,
          invocationId: `cold-durable-invocation-${index}`,
          ts: index + 1,
          partial: false,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: `source ${index}` },
        }),
      ),
      summary: 'durable checkpoint before projection loss',
      summaryFormat: 'legacy_freeform',
    });
    const durableEvent = makeRunEvent({
      sessionId: session.id,
      runId: 'cold-seed-run',
      turnId: 'cold-seed-turn',
      type: 'history_compact_checkpoint_recorded',
      ts: 1,
      data: { checkpoint: durableCheckpoint },
    });
    await seedRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'cold-seed-run',
        turnId: 'cold-seed-turn',
        status: 'completed',
      }),
      [durableEvent],
    );

    await drain(
      manager.sendMessage(session.id, {
        turnId: 'cold-stale-after-projection-loss',
        text: 'hello',
      }),
    );

    assert.deepStrictEqual(writeOutcomes, ['cold-stale-after-projection-loss:rejected']);
    assert.strictEqual(runStore.repairedProjection?.id, durableEvent.id);
    const checkpointCoverage: number[] = [];
    for (const run of await runStore.listSessionRuns(session.id)) {
      for (const event of await runStore.readEvents(session.id, run.runId)) {
        if (event.type === 'history_compact_checkpoint_recorded') {
          checkpointCoverage.push(
            (event.data!.checkpoint as HistoryCompactCheckpoint).coverage.eventCount,
          );
        }
      }
    }
    assert.deepStrictEqual(checkpointCoverage, [10]);
  });

  test('startup recovery marks persisted running turns as failed instead of leaving them stuck', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({ store, backends, newId: nextId(), now: nextNow(12_800) });
    const running = await manager.createSession(makeInput({ status: 'running' }));
    const waiting = await manager.createSession(makeInput({ status: 'waiting_for_user' }));
    const activeStuck = await manager.createSession(makeInput({ status: 'active' }));
    const failedThenCompleted = await manager.createSession(makeInput({ status: 'active' }));
    const activeDone = await manager.createSession(makeInput({ status: 'active' }));

    await store.appendMessages(running.id, [
      { type: 'user', id: 'running-user', turnId: 'running-turn', ts: 10, text: 'still running' },
      {
        type: 'turn_state',
        id: 'running-state',
        turnId: 'running-turn',
        ts: 11,
        status: 'running',
        partialOutputRetained: false,
      },
    ]);
    await store.appendMessages(waiting.id, [
      { type: 'user', id: 'waiting-user', turnId: 'waiting-turn', ts: 20, text: 'waiting' },
      {
        type: 'turn_state',
        id: 'waiting-state',
        turnId: 'waiting-turn',
        ts: 21,
        status: 'running',
        partialOutputRetained: false,
      },
    ]);
    await store.appendMessages(activeStuck.id, [
      {
        type: 'user',
        id: 'active-stuck-user',
        turnId: 'active-stuck-turn',
        ts: 30,
        text: 'already active but stuck',
      },
      {
        type: 'turn_state',
        id: 'active-stuck-state',
        turnId: 'active-stuck-turn',
        ts: 31,
        status: 'running',
        partialOutputRetained: false,
      },
    ]);
    await store.appendMessages(failedThenCompleted.id, [
      {
        type: 'user',
        id: 'failed-completed-user',
        turnId: 'failed-completed-turn',
        ts: 32,
        text: 'failed then completed',
      },
      {
        type: 'turn_state',
        id: 'failed-completed-running',
        turnId: 'failed-completed-turn',
        ts: 33,
        status: 'running',
        partialOutputRetained: false,
      },
      {
        type: 'turn_state',
        id: 'failed-completed-failed',
        turnId: 'failed-completed-turn',
        ts: 34,
        status: 'failed',
        errorClass: 'tool_failed',
        partialOutputRetained: false,
      },
      {
        type: 'turn_state',
        id: 'failed-completed-completed',
        turnId: 'failed-completed-turn',
        ts: 35,
        status: 'completed',
        partialOutputRetained: false,
      },
    ]);
    await store.appendMessages(activeDone.id, [
      { type: 'user', id: 'active-user', turnId: 'active-turn', ts: 30, text: 'done' },
      {
        type: 'turn_state',
        id: 'active-state',
        turnId: 'active-turn',
        ts: 31,
        status: 'completed',
        partialOutputRetained: false,
      },
    ]);

    const recovered = await manager.recoverInterruptedSessions();

    assert.deepStrictEqual(recovered, [
      running.id,
      waiting.id,
      activeStuck.id,
      failedThenCompleted.id,
    ]);
    assert.strictEqual((await store.readHeader(running.id)).status, 'active');
    assert.strictEqual((await store.readHeader(waiting.id)).status, 'active');
    assert.strictEqual((await store.readHeader(activeStuck.id)).status, 'active');
    assert.strictEqual((await store.readHeader(failedThenCompleted.id)).status, 'active');
    assert.strictEqual((await store.readHeader(activeDone.id)).status, 'active');
    const runningTurn = (await store.listTurns(running.id)).find(
      (turn) => turn.turnId === 'running-turn',
    );
    const waitingTurn = (await store.listTurns(waiting.id)).find(
      (turn) => turn.turnId === 'waiting-turn',
    );
    const activeStuckTurn = (await store.listTurns(activeStuck.id)).find(
      (turn) => turn.turnId === 'active-stuck-turn',
    );
    const failedThenCompletedTurn = (await store.listTurns(failedThenCompleted.id)).find(
      (turn) => turn.turnId === 'failed-completed-turn',
    );
    const activeTurn = (await store.listTurns(activeDone.id)).find(
      (turn) => turn.turnId === 'active-turn',
    );
    assert.strictEqual(runningTurn?.status, 'failed');
    assert.strictEqual(runningTurn?.errorClass, 'app_restarted');
    assert.strictEqual(waitingTurn?.status, 'failed');
    assert.strictEqual(waitingTurn?.errorClass, 'app_restarted');
    assert.strictEqual(activeStuckTurn?.status, 'failed');
    assert.strictEqual(activeStuckTurn?.errorClass, 'app_restarted');
    assert.strictEqual(failedThenCompletedTurn?.status, 'failed');
    assert.strictEqual(failedThenCompletedTurn?.errorClass, 'tool_failed');
    assert.strictEqual(activeTurn?.status, 'completed');
  });

  test('startup recovery derives the interrupted outcome sink from the runtime store', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    let sessionId = '';
    let outcomeCommitFailuresRemaining = 3;
    let outcomeCommitAttempts = 0;
    const runtimeCommitSink: RuntimeCommitSink = {
      commitToolPrepared: async () => {
        throw new Error('not used during recovery');
      },
      commitToolOutcome: async (input) => {
        outcomeCommitAttempts += 1;
        if (outcomeCommitFailuresRemaining > 0) {
          outcomeCommitFailuresRemaining -= 1;
          throw new Error('transient outcome commit failure');
        }
        await runStore.appendRuntimeEvent(sessionId, 'run-1', input.runtimeEvent);
        return { created: true, runtimeEventSeq: 4 };
      },
    };
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: Object.assign(runStore, runtimeCommitSink),
      backends,
      newId: nextId(),
      now: nextNow(12_825),
    });
    const session = await manager.createSession(makeInput({ status: 'running' }));
    sessionId = session.id;
    await seedRunningTurn(store, session.id, 'turn-1');
    await seedRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'running',
        toolMode: 'code_mode',
      }),
      [
        makeRunEvent({
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          type: 'tool_started',
          ts: 12,
        }),
      ],
    );
    const code = { code: 'return await tools.Read({ path: "a.ts" })' };
    await runStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent({
        id: 'initial',
        sessionId: session.id,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'inspect' },
        actions: { runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' } },
      }),
    );
    await runStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent({
        id: 'outer-call',
        sessionId: session.id,
        role: 'model',
        author: 'agent',
        origin: 'provider',
        modelVisibility: 'visible',
        content: { kind: 'function_call', id: 'exec-1', name: 'exec', args: code },
        refs: { operationId: 'outer-op', toolCallId: 'exec-1' },
      }),
    );
    await runStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent({
        id: 'outer-dispatch',
        sessionId: session.id,
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId: 'outer-op',
            providerToolCallId: 'exec-1',
            toolName: 'exec',
            canonicalArgsHash: canonicalToolArgsHash('exec', code),
            recoveryMode: 'never_auto_retry',
          },
        },
        refs: { operationId: 'outer-op', toolCallId: 'exec-1' },
      }),
    );

    await manager.recoverInterruptedSessions();

    assert.equal((await runStore.readRun(session.id, 'run-1')).status, 'running');
    assert.equal(outcomeCommitAttempts, 2);
    assert.equal(
      (await runStore.readRuntimeEvents(session.id, 'run-1')).some(
        (event) => event.content?.kind === 'function_response',
      ),
      false,
    );

    await manager.recoverInterruptedSessions();

    assert.equal(outcomeCommitAttempts, 4);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');
    const response = runtimeEvents.find(
      (event) => event.content?.kind === 'function_response' && event.content.id === 'exec-1',
    );
    assert.equal(response?.content?.kind, 'function_response');
    assert.equal(response?.content?.kind === 'function_response' && response.content.isError, true);
    assert.deepEqual(
      response?.content?.kind === 'function_response' ? response.content.result : undefined,
      {
        kind: 'json',
        value: {
          kind: 'code_mode',
          status: 'interrupted',
          message: 'Code Mode execution was interrupted by runtime recovery.',
        },
      },
    );
    assert.equal((await runStore.readRun(session.id, 'run-1')).status, 'failed');
  });

  test('startup recovery does not leave stale permission waits stuck', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_830),
    });
    const session = await manager.createSession(makeInput({ status: 'waiting_for_user' }));
    await store.createSandboxBoundaryRequest({
      sessionId: session.id,
      requestId: 'boundary-before-restart',
      turnId: 'turn-1',
      expansion: { network: { enabled: true } },
      justification: 'Fetch a dependency.',
    });
    await seedRunningTurn(store, session.id, 'turn-1');
    await seedRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'waiting_for_user',
      }),
      [
        makeRunEvent({
          sessionId: session.id,
          runId: 'run-1',
          turnId: 'turn-1',
          type: 'permission_requested',
          ts: 12,
        }),
      ],
    );

    await manager.recoverInterruptedSessions();

    assert.strictEqual((await store.readHeader(session.id)).status, 'active');
    const [turn] = await store.listTurns(session.id);
    assert.strictEqual(turn?.status, 'failed');
    // This turn owned the pending request, so its failure names the closure
    // rather than the bare restart.
    assert.strictEqual(turn?.errorClass, 'sandbox_boundary_closed_by_restart');
    const [run] = await runStore.listSessionRuns(session.id);
    assert.strictEqual(run?.status, 'failed');
    assert.strictEqual(run?.failureClass, 'sandbox_boundary_closed_by_restart');
    assert.deepStrictEqual(await store.listPendingSandboxBoundaryRequests(session.id), []);
  });

  test('startup recovery keeps the generic restart class for an answered boundary request', async () => {
    const { store, runStore, manager, session } = await seedBoundaryRestartSession({
      now: 12_890,
      requestId: 'boundary-answered',
    });
    await store.settleSandboxBoundaryRequest({
      sessionId: session.id,
      requestId: 'boundary-answered',
      decision: 'allow',
    });
    // A fully recorded request/decision pair in the ledger must not be mistaken
    // for a closure: the user answered it before the host went away.
    await runStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent({
        id: 'rt-boundary-request',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 12,
        actions: {
          stateDelta: {
            sandboxBoundaryRequest: {
              requestId: 'boundary-answered',
              toolUseId: 'tool-1',
              justification: 'Fetch a dependency.',
              expansion: { network: { enabled: true } },
            },
          },
        },
        refs: { toolCallId: 'tool-1' },
      }),
    );
    await runStore.appendRuntimeEvent(
      session.id,
      'run-1',
      runtimeEvent({
        id: 'rt-boundary-decision',
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 13,
        author: 'user',
        actions: {
          stateDelta: {
            sandboxBoundaryDecision: {
              requestId: 'boundary-answered',
              decision: 'allow',
              status: 'approved',
              revision: 1,
            },
          },
        },
        refs: { toolCallId: 'tool-1' },
      }),
    );

    await manager.recoverInterruptedSessions();

    const [turn] = await store.listTurns(session.id);
    assert.strictEqual(turn?.errorClass, 'app_restarted');
  });
});

async function drainAll(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** Mock model: first request calls the Probe tool, second finishes with text. */
function steeringToolThenDoneModel(): MockLanguageModelV4 {
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
  };
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      const chunks: LanguageModelV4StreamPart[] =
        call === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tool-1',
                toolName: 'Probe',
                input: JSON.stringify({ q: 'x' }),
              },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'done' },
              { type: 'text-end', id: 'text-1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
            ];
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      };
    },
  });
  return model;
}

/**
 * A SessionManager wired to a REAL AiSdkBackend over a mock model, so the
 * full steering delivery chain (kernel lease -> backend durability wait ->
 * AgentRun fail-closed persist) is exercised. `duringTool` runs inside the
 * first step's tool execution — the moment a real user steers.
 */
async function steeringDeliverySession(
  runStore: MemoryAgentRunStore,
  model: MockLanguageModelV4,
  duringTool: (manager: SessionManager, sessionId: string) => Promise<void> | void,
) {
  const store = new MemorySessionStore();
  const backends = new BackendRegistry();
  let manager!: SessionManager;
  let sessionId = '';
  backends.register('ai-sdk', (ctx) =>
    createTestAiSdkBackend({
      sessionId: ctx.sessionId,
      header: ctx.header,
      appendMessage: async () => {},
      connection: {
        slug: 'mock-main',
        providerType: 'anthropic',
        defaultModel: 'mock-model-id',
      },
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        {
          name: 'Probe',
          description: 'Probe description',
          parameters: z.object({ q: z.string() }),
          impl: async () => {
            await duringTool(manager, sessionId);
            return { ok: true };
          },
        },
      ],
      loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents,
      allowMidTurnHistoryCompaction: ctx.allowMidTurnHistoryCompaction,
      newId: nextId(),
      now: nextNow(1),
    }),
  );
  const managerDeps = {
    store,
    runStore,
    runtimeEventStore: runStore,
    backends,
    newId: nextId(),
    now: nextNow(1_000),
  };
  manager = new SessionManager(managerDeps);
  const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));
  sessionId = session.id;
  return { manager, session, store };
}

/**
 * Parks each send behind a per-turn gate, pulls steering exactly once after
 * release, then parks again behind a post-pull gate before finishing — a
 * deterministic harness for the owner-identity rule and for enqueues that
 * land after the final step boundary (stranded steering).
 */
class GatedSteeringBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;
  readonly gates = new Map<string, Gate>();
  readonly pullDone = new Map<string, Gate>();
  readonly pulls = new Map<string, string[][]>();

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const gate = makeGate();
    const afterPull = makeGate();
    this.gates.set(input.turnId, gate);
    this.pullDone.set(input.turnId, afterPull);
    await gate.promise;
    const leases = input.pullSteering?.() ?? [];
    const record = this.pulls.get(input.turnId) ?? [];
    record.push(leases.map((lease) => lease.content.text));
    this.pulls.set(input.turnId, record);
    let seq = 0;
    for (const lease of leases) {
      seq += 1;
      yield {
        type: 'steering_message',
        id: `${input.turnId}-steer-${seq}`,
        turnId: input.turnId,
        ts: seq,
        messageId: lease.messageId,
        content: lease.content,
      };
    }
    // Delivery for this fake is the echo itself; ack the leases.
    input.ackSteering?.(leases.map((lease) => lease.id));
    await afterPull.promise;
    yield {
      type: 'text_complete',
      id: `${input.turnId}-final`,
      turnId: input.turnId,
      ts: 10,
      messageId: `${input.turnId}-m`,
      text: 'ok',
    };
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 11,
      stopReason: 'end_turn',
    };
  }

  /** Release both of a turn's gates (start + post-pull). */
  release(turnId: string): void {
    this.gates.get(turnId)?.release();
    this.pullDone.get(turnId)?.release();
  }

  async stop(): Promise<void> {
    for (const turnId of this.gates.keys()) this.release(turnId);
  }

  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}

  async dispose(): Promise<void> {}
}

class DelegatingRuntimeKernel implements RuntimeKernelLike {
  readonly starts: Array<{
    sessionId: string;
    input: Parameters<RuntimeKernelLike['startTurn']>[1];
  }> = [];
  readonly stopped: string[] = [];
  readonly permissionResponses: string[] = [];
  activeRuns = false;
  failNextDispose = false;
  disposed: string[] = [];
  cachedHeaders: SessionHeader[] = [];

  constructor(private readonly events: readonly SessionEvent[] = []) {}

  claimExecution(sessionId: string): ReturnType<RuntimeKernelLike['claimExecution']> {
    const stopController = new AbortController();
    return {
      sessionId,
      stopSignal: stopController.signal,
      isStopRequested: () => false,
      release: () => {},
    };
  }

  async runSessionAdmissionMutation<T>(
    _sessionIds: readonly string[],
    operation: () => Promise<T> | T,
  ): Promise<T> {
    return operation();
  }

  async runSessionQuiescentMutation<T>(
    _sessionIds: readonly string[],
    operation: () => Promise<T> | T,
  ): Promise<T> {
    return operation();
  }

  async *startTurn(
    sessionId: string,
    input: Parameters<RuntimeKernelLike['startTurn']>[1],
  ): AsyncIterable<SessionEvent> {
    this.starts.push({ sessionId, input });
    for (const event of this.events) {
      yield event;
    }
  }

  async *compactSession(
    sessionId: string,
    input: Parameters<RuntimeKernelLike['compactSession']>[1] = {},
  ): AsyncIterable<SessionEvent> {
    this.starts.push({ sessionId, input: { turnId: input.turnId ?? 'compact-turn', text: '' } });
    for (const event of this.events) {
      yield event;
    }
  }

  async preflightContextCompaction(): Promise<void> {}

  async stopSession(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
  }

  async respondToSandboxBoundary(
    sessionId: string,
    _response: Parameters<RuntimeKernelLike['respondToSandboxBoundary']>[1],
  ): Promise<void> {
    this.permissionResponses.push(sessionId);
  }

  hasActiveRuns(): boolean {
    return this.activeRuns;
  }

  updateCachedHeader(_sessionId: string, header: SessionHeader): void {
    this.cachedHeaders.push(header);
  }

  async invalidateBackend(sessionId: string): Promise<void> {
    if (!this.activeRuns) this.disposed.push(sessionId);
  }

  async invalidateCachedBackends(): Promise<void> {
    // This test double does not retain backend instances between calls.
  }

  async disposeBackend(sessionId: string): Promise<void> {
    if (this.failNextDispose) {
      this.failNextDispose = false;
      throw new Error('backend disposal failed');
    }
    this.disposed.push(sessionId);
  }
}

class UnadmittedQuestionBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'user_question_request',
      id: 'unadmitted-event',
      turnId: input.turnId,
      ts: 1,
      requestId: 'unadmitted-request',
      toolUseId: 'unadmitted-tool',
      questions: [
        {
          question: 'Continue?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
      ],
    };
  }

  async stop(): Promise<void> {}

  async respondToSandboxBoundary(): Promise<void> {}

  async dispose(): Promise<void> {}
}

class TestBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;
  readonly sendInputs: BackendSendInput[] = [];
  stopCalls = 0;
  readonly stopModes: BackendStopMode[] = [];

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly gate?: Gate,
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendInputs.push(input);
    yield {
      type: 'text_delta',
      id: `${input.turnId}-delta`,
      turnId: input.turnId,
      ts: 1,
      messageId: `${input.turnId}-m`,
      text: 'ok',
    };
    await this.gate?.promise;
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 2,
      stopReason: 'end_turn',
    };
  }

  async stop(
    _reason: 'user_stop' | 'redirect',
    mode: BackendStopMode = 'immediate',
  ): Promise<void> {
    this.stopCalls += 1;
    this.stopModes.push(mode);
  }
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}

  async dispose(): Promise<void> {
    if (this.ctx.store instanceof MemorySessionStore) {
      this.ctx.store.disposeCount += 1;
    }
  }
}

class PermissionBroadcastBackend extends TestBackend {
  permissionResponses = 0;

  override async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {
    this.permissionResponses += 1;
  }
}

class ConcurrentStopBackend extends TestBackend {
  constructor(
    ctx: BackendFactoryContext,
    private readonly stopStarted: Gate,
    private readonly releaseStop: Gate,
  ) {
    super(ctx, releaseStop);
  }

  override async stop(): Promise<void> {
    this.stopCalls += 1;
    this.stopStarted.release();
    await this.releaseStop.promise;
  }
}

class CountingStopBackend extends TestBackend {
  override async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

class FinalTextTestBackend extends TestBackend {
  override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendInputs.push(input);
    yield {
      type: 'text_complete',
      id: `${input.turnId}-final`,
      turnId: input.turnId,
      ts: 1,
      messageId: `${input.turnId}-m`,
      text: 'ok',
    };
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 2,
      stopReason: 'end_turn',
    };
  }
}

class CountingFinalTextBackend extends FinalTextTestBackend {
  constructor(
    ctx: BackendFactoryContext,
    private readonly onSend: () => void,
  ) {
    super(ctx);
  }

  override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.onSend();
    yield* super.send(input);
  }
}

class CompactingTestBackend extends TestBackend {
  constructor(
    ctx: BackendFactoryContext,
    private readonly compactCalls: Array<{
      turnId: string;
      runtimeContextCount: number;
      sourceRoutes?: Array<{ runId: string; connectionId?: string; modelId: string }>;
    }>,
  ) {
    super(ctx);
  }

  async compactHistory(input: BackendCompactHistoryInput) {
    this.compactCalls.push({
      turnId: input.turnId,
      runtimeContextCount: input.runtimeContext.length,
      sourceRoutes: (input.runtimeContextRunHeaders ?? []).map((run) => ({
        runId: run.runId,
        ...(run.llmConnectionId ? { connectionId: run.llmConnectionId } : {}),
        modelId: run.modelId,
      })),
    });
    return compactHistoryResult();
  }
}

class LifecycleChildBackend extends CompactingTestBackend {
  override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendInputs.push(input);
    yield {
      type: 'tool_start',
      id: `${input.turnId}-tool-start`,
      turnId: input.turnId,
      ts: 1,
      toolUseId: `${input.turnId}-read`,
      toolName: 'Read',
      args: { path: 'README.md' },
    };
    yield {
      type: 'tool_result',
      id: `${input.turnId}-tool-result`,
      turnId: input.turnId,
      ts: 2,
      toolUseId: `${input.turnId}-read`,
      isError: false,
      content: { kind: 'text', text: 'README body' },
    };
    yield {
      type: 'token_usage',
      id: `${input.turnId}-usage`,
      turnId: input.turnId,
      ts: 3,
      input: 10,
      output: 5,
      total: 15,
    };
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 4,
      stopReason: 'end_turn',
    };
  }
}

class BlockingCompactBackend extends TestBackend {
  stopCalls = 0;

  constructor(
    ctx: BackendFactoryContext,
    private readonly options: {
      compactGate: Gate;
      onCompactStart: (backend: BlockingCompactBackend) => void;
    },
  ) {
    super(ctx);
  }

  async compactHistory(_input: { turnId: string; runtimeContext: readonly RuntimeEvent[] }) {
    this.options.onCompactStart(this);
    await this.options.compactGate.promise;
    return compactHistoryResult();
  }

  override async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

class FailOpenCompactingBackend extends TestBackend {
  async compactHistory(_input: { turnId: string; runtimeContext: readonly RuntimeEvent[] }) {
    return compactHistoryFailOpenResult();
  }
}

class ActiveTurnBackend extends TestBackend {
  constructor(
    ctx: BackendFactoryContext,
    private readonly options: {
      turnStarted: Gate;
      sendGate: Gate;
      compactCalls: Array<{ turnId: string; runtimeContextCount: number }>;
    },
  ) {
    super(ctx, options.sendGate);
  }

  override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.options.turnStarted.release();
    yield* super.send(input);
  }

  async compactHistory(input: { turnId: string; runtimeContext: readonly RuntimeEvent[] }) {
    this.options.compactCalls.push({
      turnId: input.turnId,
      runtimeContextCount: input.runtimeContext.length,
    });
    return compactHistoryResult();
  }
}

function compactHistoryResult() {
  return {
    outcome: { kind: 'compacted' as const, checkpointId: 'checkpoint-1' },
    contextBudget: {
      enabled: true,
      policyName: 'unit-budget',
      estimatedTokensBefore: 1000,
      estimatedTokensAfter: 400,
      keptTurns: 1,
      droppedTurns: 1,
      keptEvents: 1,
      droppedEvents: 1,
      compactionDecisions: [
        {
          stage: 'priorReplay' as const,
          sourceKind: 'runtimeEvents' as const,
          decision: 'replaced' as const,
          boundaryKind: 'historyCompact',
          estimatedTokensSaved: 600,
        },
      ],
    },
  };
}

function compactHistoryFailOpenResult() {
  return {
    outcome: { kind: 'failed' as const, reason: 'write_failed' },
    contextBudget: {
      enabled: true,
      policyName: 'unit-budget',
      estimatedTokensBefore: 1000,
      estimatedTokensAfter: 400,
      keptTurns: 1,
      droppedTurns: 1,
      keptEvents: 1,
      droppedEvents: 1,
      compactionDecisions: [
        {
          stage: 'priorReplay' as const,
          sourceKind: 'runtimeEvents' as const,
          decision: 'failedOpen' as const,
          boundaryKind: 'historyCompact',
          failOpenReason: 'write_failed',
        },
      ],
    },
  };
}

class LateErrorBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly gate: Gate,
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'text_delta',
      id: `${input.turnId}-delta`,
      turnId: input.turnId,
      ts: 1,
      messageId: `${input.turnId}-m`,
      text: 'ok',
    };
    await this.gate.promise;
    yield {
      type: 'error',
      id: `${input.turnId}-error`,
      turnId: input.turnId,
      ts: 2,
      recoverable: false,
      reason: 'late_error',
      message: 'late backend error',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {
    if (this.ctx.store instanceof MemorySessionStore) {
      this.ctx.store.disposeCount += 1;
    }
  }
}

class StopControlledAbortBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;
  private releaseAbort: () => void = () => {};
  private releaseStop: () => void = () => {};
  private readonly abortGate = new Promise<void>((resolve) => {
    this.releaseAbort = resolve;
  });
  private readonly stopGate = new Promise<void>((resolve) => {
    this.releaseStop = resolve;
  });

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'text_delta',
      id: `${input.turnId}-delta`,
      turnId: input.turnId,
      ts: 1,
      messageId: `${input.turnId}-m`,
      text: 'ok',
    };
    await this.abortGate;
    yield {
      type: 'abort',
      id: `${input.turnId}-abort`,
      turnId: input.turnId,
      ts: 2,
      reason: 'user_stop',
    };
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 3,
      stopReason: 'user_stop',
    };
  }

  async stop(): Promise<void> {
    this.releaseAbort();
    await this.stopGate;
  }

  allowStopReturn(): void {
    this.releaseStop();
  }

  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

type PartialEvent =
  | Omit<Extract<SessionEvent, { type: 'text_delta' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'permission_request' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'complete' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'error' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'abort' }>, 'id' | 'turnId' | 'ts'>;

class TurnScriptBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;
  readonly sendInputs: BackendSendInput[] = [];

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly turns: PartialEvent[][],
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendInputs.push(input);
    const events = this.turns[this.sendInputs.length - 1] ?? [
      { type: 'text_delta', messageId: `${input.turnId}-m`, text: 'ok' },
      { type: 'complete', stopReason: 'end_turn' },
    ];
    let index = 0;
    for (const event of events) {
      index += 1;
      yield {
        ...event,
        id: `${input.turnId}-${index}`,
        turnId: input.turnId,
        ts: index,
      } as SessionEvent;
    }
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class EventBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly events: PartialEvent[],
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    let index = 0;
    for (const event of this.events) {
      index += 1;
      yield {
        ...event,
        id: `${input.turnId}-${index}`,
        turnId: input.turnId,
        ts: index,
      } as SessionEvent;
    }
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class SandboxBoundaryWaitBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;
  readonly responses: SandboxBoundaryResponse[] = [];
  private readonly responseGate = makeGate();

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'sandbox_boundary_request',
      id: `${input.turnId}-request`,
      turnId: input.turnId,
      ts: 1,
      requestId: 'boundary-1',
      toolUseId: 'tool-1',
      justification: 'Write the requested export.',
      expansion: {
        filesystem: {
          entries: [{ path: '/tmp/export.txt', access: 'write', scope: 'exact' }],
        },
      },
    };
    await this.responseGate.promise;
    const response = this.responses[0]!;
    yield {
      type: 'sandbox_boundary_decision_ack',
      id: `${input.turnId}-decision`,
      turnId: input.turnId,
      ts: 2,
      requestId: response.requestId,
      toolUseId: 'tool-1',
      decision: response.decision,
      status: response.decision === 'allow' ? 'approved' : 'denied',
      revision: response.decision === 'allow' ? 1 : 0,
    };
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 3,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {
    this.responseGate.release();
  }

  async respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void> {
    this.responses.push(response);
    this.responseGate.release();
  }

  async dispose(): Promise<void> {}
}

/**
 * Emits a SessionEvent variant the mapping has never been taught, wrapped in a
 * turn that produces a real assistant message. That is what a future variant
 * looks like from the read model's side: the mapper's exhaustiveness guard turns
 * it into a control-only RuntimeEvent, and the ledger keeps it.
 */
class UnmappedSessionEventBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'text_complete',
      id: `${input.turnId}-text`,
      turnId: input.turnId,
      ts: 1,
      messageId: `${input.turnId}-message`,
      text: 'hi back',
    };
    yield {
      type: 'not_yet_mapped',
      id: `${input.turnId}-unmapped`,
      turnId: input.turnId,
      ts: 2,
    } as unknown as SessionEvent;
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 3,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}

  async respondToSandboxBoundary(): Promise<void> {}

  async dispose(): Promise<void> {}
}

class ThrowAfterTerminalBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'text_delta',
      id: `${input.turnId}-delta`,
      turnId: input.turnId,
      ts: 1,
      messageId: `${input.turnId}-m`,
      text: 'before',
    };
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 2,
      stopReason: 'end_turn',
    };
    throw new Error('cleanup after terminal failed');
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class ThrowBeforeTerminalBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'text_delta',
      id: `${input.turnId}-delta`,
      turnId: input.turnId,
      ts: 1,
      messageId: `${input.turnId}-m`,
      text: 'before',
    };
    throw new Error('backend failed before terminal');
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class TraceBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(private readonly ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.ctx.recordRunTrace?.({
      id: `${input.turnId}-trace-start`,
      sessionId: this.sessionId,
      turnId: input.turnId,
      ts: 1,
      phase: 'model',
      type: 'model_stream_started',
      message: 'Model stream started with Bearer sk-live-secret-token-value',
      data: {
        activeTools: ['Read'],
        credential: 'sk-live-secret-token-value',
      },
    });
    yield {
      type: 'text_delta',
      id: `${input.turnId}-delta`,
      turnId: input.turnId,
      ts: 2,
      messageId: `${input.turnId}-m`,
      text: 'ok',
    };
    this.ctx.recordRunTrace?.({
      id: `${input.turnId}-trace-usage`,
      sessionId: this.sessionId,
      turnId: input.turnId,
      ts: 3,
      phase: 'model',
      type: 'model_stream_completed',
      message: 'Model stream completed',
      data: { finishReason: 'stop' },
    });
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 4,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class HistoryCompactCheckpointBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(private readonly ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: this.sessionId,
      coveredRuntimeEvents: [
        {
          id: 'source-event',
          sessionId: this.sessionId,
          runId: 'source-run',
          turnId: 'source-turn',
          invocationId: 'source-invocation',
          ts: 1,
          partial: false,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'source' },
        },
      ],
      summary: 'persist the bounded checkpoint',
      summaryFormat: 'legacy_freeform',
    });
    this.ctx.recordHistoryCompactCheckpoint?.(
      { ...checkpoint, checkpointId: 'hcheckpoint-test' },
      input.turnId,
    );
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 4,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class SameCoverageCheckpointReplacementProbeBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly writeOutcomes: string[],
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const current = await this.ctx.loadHistoryCompactCheckpoint?.();
    const coveredRuntimeEvents: RuntimeEvent[] = [
      {
        id: 'same-coverage-source-event',
        sessionId: this.sessionId,
        runId: 'same-coverage-source-run',
        turnId: 'same-coverage-source-turn',
        invocationId: 'same-coverage-source-invocation',
        ts: 1,
        partial: false,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'same source' },
      },
    ];
    try {
      await this.ctx.recordHistoryCompactCheckpoint?.(
        buildHistoryCompactCheckpoint({
          sessionId: this.sessionId,
          coveredRuntimeEvents,
          summary: `${input.turnId} summary`,
          summaryFormat: 'legacy_freeform',
          ...(current ? { previousCheckpointId: current.checkpointId } : {}),
        }),
        input.turnId,
      );
      this.writeOutcomes.push(`${input.turnId}:fulfilled`);
    } catch {
      this.writeOutcomes.push(`${input.turnId}:rejected`);
    }
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 4,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class CheckpointRecorderContractProbeBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly beforeRecord: (turnId: string) => Promise<void>,
    private readonly writeOutcomes: string[],
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    await this.beforeRecord(input.turnId);
    const coverage = input.turnId === 'parent-furthest-in-flight' ? 2 : 1;
    const coveredRuntimeEvents = Array.from(
      { length: coverage },
      (_, index): RuntimeEvent => ({
        id: `contract-source-event-${index}`,
        sessionId: this.sessionId,
        runId: `contract-source-run-${index}`,
        turnId: `contract-source-turn-${index}`,
        invocationId: `contract-source-invocation-${index}`,
        ts: index + 1,
        partial: false,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: `source ${index}` },
      }),
    );
    try {
      await this.ctx.recordHistoryCompactCheckpoint?.(
        buildHistoryCompactCheckpoint({
          sessionId: this.sessionId,
          coveredRuntimeEvents,
          summary: `${input.turnId} checkpoint`,
          summaryFormat: 'legacy_freeform',
        }),
        input.turnId,
      );
      this.writeOutcomes.push(`${input.turnId}:fulfilled`);
    } catch {
      this.writeOutcomes.push(`${input.turnId}:rejected`);
    }
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 4,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class MemorySessionStore implements SessionStore {
  private headers = new Map<string, SessionHeader>();
  private messages = new Map<string, StoredMessage[]>();
  private executionBoundaries = new Map<string, ExecutionBoundary>();
  private sandboxBoundaryRequests = new Map<string, SandboxBoundaryRequest>();
  readonly failReadMessagesFor = new Set<string>();
  readonly failNextReadMessagesFor = new Map<string, number>();
  readonly failListTurnsFor = new Set<string>();
  readonly failUpdateHeaderFor = new Set<string>();
  failNextAppendMessage: ((message: StoredMessage) => boolean) | undefined;
  failAfterNextAppendMessage: ((message: StoredMessage) => boolean) | undefined;
  disposeCount = 0;
  nextReadHeaderGate: { started: Gate; release: Gate } | undefined;
  nextGraphOperatorProvisionGate: { started: Gate; release: Gate } | undefined;

  async createSubagent(
    input: CreateSessionInput,
    initialBoundary?: ExecutionBoundary,
  ): Promise<{ header: SessionHeader; created: boolean }> {
    const parent = input.subagentParent;
    const spawn = input.subagentSpawn;
    if (!parent || !input.subagentRuntime || !spawn) {
      throw new Error('Missing child-session metadata');
    }
    const existing = Array.from(this.headers.values()).find((header) => {
      const candidate = header.subagentParent;
      return (
        candidate?.parentSessionId === parent.parentSessionId &&
        candidate.spawnedBy.parentRunId === parent.spawnedBy.parentRunId &&
        candidate.spawnedBy.toolCallId === parent.spawnedBy.toolCallId &&
        candidate.swarm?.swarmId === parent.swarm?.swarmId &&
        candidate.swarm?.itemId === parent.swarm?.itemId
      );
    });
    if (existing) {
      if (
        existing.subagentSpawn?.requestFingerprint !== spawn.requestFingerprint ||
        existing.subagentParent?.spawnedBy.parentTurnId !== parent.spawnedBy.parentTurnId
      ) {
        throw new Error('Child-session spawn identity was reused for different work');
      }
      return { header: existing, created: false };
    }
    return { header: await this.create(input, initialBoundary), created: true };
  }

  async createAgentGraphOperator(
    input: CreateSessionInput,
    request: AgentGraphOperatorProvisionRequest,
    _expectedRevision: number,
    initialBoundary?: ExecutionBoundary,
  ): Promise<{ header: SessionHeader } & AgentGraphOperatorProvisionResult> {
    const gate = this.nextGraphOperatorProvisionGate;
    if (gate) {
      this.nextGraphOperatorProvisionGate = undefined;
      gate.started.release();
      await gate.release.promise;
    }
    const header = await this.create(input, initialBoundary);
    return {
      header,
      created: true,
      provision: {
        ...request,
        edges: request.edges.map((edge) => ({ ...edge })),
        targetSessionId: header.id,
        provisionedAt: 1,
      },
    };
  }

  async create(
    input: CreateSessionInput,
    initialBoundary?: ExecutionBoundary,
  ): Promise<SessionHeader> {
    const header: SessionHeader = {
      id: `session-${this.headers.size + 1}`,
      workspaceRoot: '/tmp/workspace',
      cwd: input.cwd,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      createdAt: 1,
      name: input.name ?? 'New Chat',
      titleIsManual: false,
      isFlagged: false,
      labels: input.labels ?? [],
      isArchived: false,
      status: input.status ?? 'active',
      ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
      statusUpdatedAt: 1,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.branchOfTurnId ? { branchOfTurnId: input.branchOfTurnId } : {}),
      ...(input.subagentParent ? { subagentParent: input.subagentParent } : {}),
      ...(input.subagentRuntime ? { subagentRuntime: input.subagentRuntime } : {}),
      ...(input.subagentSpawn ? { subagentSpawn: input.subagentSpawn } : {}),
      ...(input.subagentWorkspace ? { subagentWorkspace: input.subagentWorkspace } : {}),
      ...(input.revisionRootSessionId
        ? { revisionRootSessionId: input.revisionRootSessionId }
        : {}),
      ...(input.revisionParentSessionId
        ? { revisionParentSessionId: input.revisionParentSessionId }
        : {}),
      ...(input.revisionOfTurnId ? { revisionOfTurnId: input.revisionOfTurnId } : {}),
      ...(input.revisionIndex !== undefined ? { revisionIndex: input.revisionIndex } : {}),
      ...(input.revisionState ? { revisionState: input.revisionState } : {}),
      hasUnread: false,
      backend: 'ai-sdk',
      ...(input.llmConnectionId === undefined ? {} : { llmConnectionId: input.llmConnectionId }),
      llmConnectionSlug: input.llmConnectionSlug,
      connectionLocked: input.subagentParent !== undefined,
      model: input.model ?? 'fake-model',
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      permissionMode: input.permissionMode,
      collaborationMode: input.collaborationMode ?? 'agent',
      orchestrationMode: input.orchestrationMode ?? 'default',
      schemaVersion: 1,
    };
    this.headers.set(header.id, header);
    this.messages.set(header.id, []);
    this.executionBoundaries.set(
      header.id,
      initialBoundary
        ? { ...initialBoundary, revision: 0 }
        : createGenesisExecutionBoundary(header.permissionMode),
    );
    return header;
  }

  async setExecutionBoundaryKind(
    sessionId: string,
    kind: 'managed' | 'bypass',
    projection?: {
      permissionMode: SessionHeader['permissionMode'];
      labels?: readonly string[];
    },
  ) {
    const current = await this.readHeader(sessionId);
    const permissionMode =
      projection?.permissionMode ??
      (kind === 'bypass'
        ? 'bypass'
        : current.permissionMode === 'bypass'
          ? 'ask'
          : current.permissionMode);
    await this.updateHeader(sessionId, {
      permissionMode,
      ...(projection?.labels ? { labels: [...projection.labels] } : {}),
    });
    const boundary = createGenesisExecutionBoundary(permissionMode);
    this.executionBoundaries.set(sessionId, boundary);
    return boundary;
  }

  async readExecutionBoundary(sessionId: string): Promise<ExecutionBoundary> {
    const boundary = this.executionBoundaries.get(sessionId);
    if (!boundary) throw new Error(`Unknown session ${sessionId}`);
    return boundary;
  }

  async createSandboxBoundaryRequest(
    input: CreateSandboxBoundaryRequest,
  ): Promise<SandboxBoundaryRequest> {
    const boundary = await this.readExecutionBoundary(input.sessionId);
    const request: SandboxBoundaryRequest = {
      ...input,
      status: 'pending',
      baseRevision: boundary.revision,
      createdAt: 1,
    };
    this.sandboxBoundaryRequests.set(`${input.sessionId}:${input.requestId}`, request);
    return request;
  }

  async listPendingSandboxBoundaryRequests(sessionId: string): Promise<SandboxBoundaryRequest[]> {
    return [...this.sandboxBoundaryRequests.values()].filter(
      (request) => request.sessionId === sessionId && request.status === 'pending',
    );
  }

  async listSandboxBoundaryRestartClosures(sessionId: string): Promise<SandboxBoundaryRequest[]> {
    return [...this.sandboxBoundaryRequests.values()].filter(
      (request) => request.sessionId === sessionId && isSandboxBoundaryRestartClosure(request),
    );
  }

  async settleSandboxBoundaryRequest(
    input: SettleSandboxBoundaryRequest,
  ): Promise<SandboxBoundarySettlement> {
    const key = `${input.sessionId}:${input.requestId}`;
    const request = this.sandboxBoundaryRequests.get(key);
    if (!request) throw new Error(`Unknown sandbox boundary request ${input.requestId}`);
    const settled =
      request.status === 'pending'
        ? {
            ...request,
            status: input.decision === 'allow' ? ('approved' as const) : ('denied' as const),
            settledAt: 2,
            ...(input.closureReason ? { outcomeReason: input.closureReason } : {}),
          }
        : request;
    this.sandboxBoundaryRequests.set(key, settled);
    return {
      request: settled,
      boundary: await this.readExecutionBoundary(input.sessionId),
      changed: false,
    };
  }

  async list(_filter?: SessionListFilter): Promise<SessionSummary[]> {
    return Array.from(this.headers.values()).map(headerToSummary);
  }

  async readHeader(sessionId: string): Promise<SessionHeader> {
    const gate = this.nextReadHeaderGate;
    if (gate) {
      this.nextReadHeaderGate = undefined;
      gate.started.release();
      await gate.release.promise;
    }
    const header = this.headers.get(sessionId);
    if (!header) {
      const error = new Error(`Unknown session ${sessionId}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return header;
  }

  async readMessages(sessionId: string): Promise<StoredMessage[]> {
    const remainingFailures = this.failNextReadMessagesFor.get(sessionId) ?? 0;
    if (remainingFailures > 0) {
      if (remainingFailures === 1) this.failNextReadMessagesFor.delete(sessionId);
      else this.failNextReadMessagesFor.set(sessionId, remainingFailures - 1);
      throw new Error(`Cannot read messages for ${sessionId}`);
    }
    if (this.failReadMessagesFor.has(sessionId))
      throw new Error(`Cannot read messages for ${sessionId}`);
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    if (this.failListTurnsFor.has(sessionId)) throw new Error(`Cannot list turns for ${sessionId}`);
    return deriveTurnRecords(await this.readMessages(sessionId));
  }

  async appendMessage(sessionId: string, message: StoredMessage): Promise<void> {
    await this.appendMessages(sessionId, [message]);
  }

  async appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void> {
    if (this.failNextAppendMessage && messages.some(this.failNextAppendMessage)) {
      this.failNextAppendMessage = undefined;
      throw new Error('append message failed');
    }
    this.messages.set(sessionId, [...(this.messages.get(sessionId) ?? []), ...messages]);
    if (this.failAfterNextAppendMessage && messages.some(this.failAfterNextAppendMessage)) {
      this.failAfterNextAppendMessage = undefined;
      throw new Error('append message failed');
    }
  }

  async updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader> {
    if (this.failUpdateHeaderFor.has(sessionId))
      throw new Error(`Cannot update header for ${sessionId}`);
    const current = await this.readHeader(sessionId);
    const next = { ...current, ...patch };
    this.headers.set(sessionId, next);
    return next;
  }

  async setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
    await this.updateHeader(sessionId, { isFlagged });
  }

  async rename(sessionId: string, name: string): Promise<void> {
    await this.updateHeader(sessionId, { name, titleIsManual: true });
  }

  async remove(sessionId: string): Promise<void> {
    this.headers.delete(sessionId);
    this.messages.delete(sessionId);
    this.executionBoundaries.delete(sessionId);
  }
}

class VersionedConfigurationMemorySessionStore extends MemorySessionStore {
  private readonly revisions = new Map<string, number>();
  nextConfigurationUpdateGate: { started: Gate; release: Gate } | undefined;

  override async create(
    input: CreateSessionInput,
    initialBoundary?: ExecutionBoundary,
  ): Promise<SessionHeader> {
    const header = await super.create(input, initialBoundary);
    this.revisions.set(header.id, 1);
    return header;
  }

  async readHeaderRecordSnapshot(sessionId: string): Promise<VersionedSessionHeader> {
    return {
      header: await this.readHeader(sessionId),
      revision: this.revisions.get(sessionId) ?? 1,
      committedAt: 1,
    };
  }

  async updateSessionConfiguration(
    sessionId: string,
    input: SessionConfigurationStoreUpdate,
  ): Promise<VersionedSessionHeader> {
    const gate = this.nextConfigurationUpdateGate;
    if (gate) {
      this.nextConfigurationUpdateGate = undefined;
      gate.started.release();
      await gate.release.promise;
    }
    const revision = this.revisions.get(sessionId) ?? 1;
    if (revision !== input.expectedVersion) {
      throw new Error('injected configuration revision conflict');
    }
    await super.setExecutionBoundaryKind(
      sessionId,
      input.configuration.permissionMode === 'bypass' ? 'bypass' : 'managed',
      {
        permissionMode: input.configuration.permissionMode,
        labels: input.configuration.labels,
      },
    );
    const header = await super.updateHeader(sessionId, {
      ...input.configuration,
      labels: [...input.configuration.labels],
      ...(input.lifecycle.kind === 'clear_connection_block'
        ? {
            status: 'active',
            blockedReason: undefined,
            statusUpdatedAt: input.lifecycle.statusUpdatedAt,
          }
        : {}),
    });
    this.revisions.set(sessionId, revision + 1);
    return { header, revision: revision + 1, committedAt: revision + 1 };
  }

  async updateHeaderVersioned(
    sessionId: string,
    patch: Partial<SessionHeader>,
    expectedRevision: number,
  ): Promise<VersionedSessionHeader> {
    const revision = this.revisions.get(sessionId) ?? 1;
    if (revision !== expectedRevision) {
      throw new SessionConfigurationRevisionConflictError(expectedRevision, revision);
    }
    const header = await super.updateHeader(sessionId, patch);
    this.revisions.set(sessionId, revision + 1);
    return { header, revision: revision + 1, committedAt: revision + 1 };
  }
}

class AtomicBoundaryMemorySessionStore extends MemorySessionStore {
  failAppends = false;
  readonly boundaryCalls: Array<{
    sessionId: string;
    kind: 'managed' | 'bypass';
    projection:
      | {
          permissionMode: SessionHeader['permissionMode'];
          labels?: readonly string[];
        }
      | undefined;
  }> = [];
  private readonly boundaries = new Map<string, ExecutionBoundary>();
  private projectingBoundary = false;

  forceBoundary(sessionId: string, boundary: ExecutionBoundary): void {
    this.boundaries.set(sessionId, boundary);
  }

  override async readExecutionBoundary(sessionId: string): Promise<ExecutionBoundary> {
    return this.boundaries.get(sessionId) ?? super.readExecutionBoundary(sessionId);
  }

  async setExecutionBoundaryKind(
    sessionId: string,
    kind: 'managed' | 'bypass',
    projection?: {
      permissionMode: SessionHeader['permissionMode'];
      labels?: readonly string[];
    },
  ) {
    this.boundaryCalls.push({ sessionId, kind, projection });
    const current = await this.readHeader(sessionId);
    const permissionMode =
      projection?.permissionMode ??
      (kind === 'bypass'
        ? 'bypass'
        : current.permissionMode === 'bypass'
          ? 'ask'
          : current.permissionMode);
    this.projectingBoundary = true;
    try {
      await super.updateHeader(sessionId, {
        permissionMode,
        ...(projection?.labels ? { labels: [...projection.labels] } : {}),
      });
    } finally {
      this.projectingBoundary = false;
    }
    const boundary = {
      ...createGenesisExecutionBoundary(permissionMode),
      revision: 1,
    };
    this.boundaries.set(sessionId, boundary);
    return boundary;
  }

  override async updateHeader(
    sessionId: string,
    patch: Partial<SessionHeader>,
  ): Promise<SessionHeader> {
    if (!this.projectingBoundary && Object.hasOwn(patch, 'permissionMode')) {
      throw new Error('permissionMode must be projected by the boundary transition');
    }
    return super.updateHeader(sessionId, patch);
  }

  override async appendMessage(sessionId: string, message: StoredMessage): Promise<void> {
    if (this.failAppends) throw new Error('audit append failed');
    return super.appendMessage(sessionId, message);
  }
}

class MemoryAgentRunStore
  implements AgentRunStore, RuntimeEventStore, RuntimeContinuationAuthorityStore
{
  readonly continuationAuthorityCapability = RUNTIME_CONTINUATION_AUTHORITY_V1;
  listSessionRunsCalls = 0;
  readEventsCalls = 0;
  private headers = new Map<string, AgentRunHeader>();
  private events = new Map<string, AgentRunEvent[]>();
  private runtimeEvents = new Map<string, RuntimeEvent[]>();
  private runtimeEventEntries: RuntimeEvent[] = [];
  private continuationClaims = new Map<string, ContinuationClaimV1>();
  private continuationStartKinds = new Map<string, 'runtime_admission' | 'claim_repair'>();
  private runtimeEventAppendCount = 0;
  private rootTurnAdmissions = new Map<
    string,
    { runId: string; userMessageId: string | null; execution: RootExecutionDescriptor }
  >();

  constructor(
    private readonly options: {
      failRuntimeEventAppends?: boolean;
      failRuntimeEventAppendAfter?: number;
      failRuntimeEventReads?: boolean;
      failContinuationClaimReads?: boolean;
      failUpdateRunOnce?: boolean;
      failUpdateRunStatusOnce?: AgentRunHeader['status'];
      failContinuationCreate?: boolean;
      beforeListSessionRuns?: (sessionId: string) => Promise<void> | void;
      beforeRuntimeEventRead?: (sessionId: string, runId: string) => Promise<void> | void;
      beforeRuntimeEventAppend?: (
        sessionId: string,
        runId: string,
        event: RuntimeEvent,
        options?: { durable?: boolean },
      ) => Promise<void> | void;
      beforeRunRead?: (sessionId: string, runId: string) => Promise<void> | void;
      beforeAgentRunEventAppend?: (
        sessionId: string,
        runId: string,
        event: AgentRunEvent,
      ) => Promise<void> | void;
      beforeAgentRunEventRead?: (sessionId: string, runId: string) => Promise<void> | void;
      beforeAgentRunUpdate?: (
        sessionId: string,
        runId: string,
        patch: Partial<AgentRunHeader>,
      ) => Promise<void> | void;
    } = {},
  ) {}

  async createRun(header: AgentRunHeader): Promise<AgentRunHeader> {
    if (this.options.failContinuationCreate && header.continuationSource) {
      throw new Error('continuation claim create failed');
    }
    this.headers.set(key(header.sessionId, header.runId), { ...header });
    return { ...header };
  }

  async updateRun(
    sessionId: string,
    runId: string,
    patch: Partial<AgentRunHeader>,
  ): Promise<AgentRunHeader> {
    await this.options.beforeAgentRunUpdate?.(sessionId, runId, patch);
    if (this.options.failUpdateRunOnce) {
      this.options.failUpdateRunOnce = false;
      throw new Error('update run failed');
    }
    if (patch.status && patch.status === this.options.failUpdateRunStatusOnce) {
      this.options.failUpdateRunStatusOnce = undefined;
      throw new Error('update run failed');
    }
    const current = await this.readRun(sessionId, runId);
    const next = { ...current, ...patch, sessionId, runId };
    this.headers.set(key(sessionId, runId), next);
    return { ...next };
  }

  async readRun(sessionId: string, runId: string): Promise<AgentRunHeader> {
    await this.options.beforeRunRead?.(sessionId, runId);
    const header = this.headers.get(key(sessionId, runId));
    if (!header) {
      const error = new Error(`Unknown run ${runId}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return { ...header };
  }

  async listSessionRuns(sessionId: string): Promise<AgentRunHeader[]> {
    this.listSessionRunsCalls += 1;
    await this.options.beforeListSessionRuns?.(sessionId);
    return Array.from(this.headers.values())
      .filter((header) => header.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId))
      .map((header) => ({ ...header }));
  }

  seedRootTurnAdmission(
    sessionId: string,
    turnId: string,
    admission: { runId: string; userMessageId: string | null; execution: RootExecutionDescriptor },
  ): void {
    this.rootTurnAdmissions.set(key(sessionId, turnId), admission);
  }

  async readRootTurnAdmission(
    sessionId: string,
    turnId: string,
  ): Promise<
    { runId: string; userMessageId: string | null; execution: RootExecutionDescriptor } | undefined
  > {
    return this.rootTurnAdmissions.get(key(sessionId, turnId));
  }

  async appendEvent(sessionId: string, runId: string, event: AgentRunEvent): Promise<void> {
    await this.options.beforeAgentRunEventAppend?.(sessionId, runId, event);
    const eventKey = key(sessionId, runId);
    this.events.set(eventKey, [...(this.events.get(eventKey) ?? []), copyEvent(event)]);
  }

  async readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    this.readEventsCalls += 1;
    await this.options.beforeAgentRunEventRead?.(sessionId, runId);
    return (this.events.get(key(sessionId, runId)) ?? []).map(copyEvent);
  }

  async appendRuntimeEvent(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
    options?: { durable?: boolean },
  ): Promise<void> {
    await this.options.beforeRuntimeEventAppend?.(sessionId, runId, event, options);
    if (this.options.failRuntimeEventAppends) throw new Error('runtime event append failed');
    this.runtimeEventAppendCount += 1;
    if (
      this.options.failRuntimeEventAppendAfter !== undefined &&
      this.runtimeEventAppendCount > this.options.failRuntimeEventAppendAfter
    ) {
      this.options.failRuntimeEventAppendAfter = undefined;
      throw new Error('runtime event append failed');
    }
    const eventKey = key(sessionId, runId);
    this.runtimeEvents.set(eventKey, [
      ...(this.runtimeEvents.get(eventKey) ?? []),
      copyRuntimeEvent(event),
    ]);
    if (event.partial !== true && !this.runtimeEventEntries.some(({ id }) => id === event.id)) {
      this.runtimeEventEntries.push(copyRuntimeEvent(event));
    }
  }

  async ensureTerminalRuntimeEventDurable(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void> {
    const existing = (this.runtimeEvents.get(key(sessionId, runId)) ?? []).find(
      (candidate) => candidate.id === event.id,
    );
    if (!existing) {
      await this.appendRuntimeEvent(sessionId, runId, event);
      return;
    }
    if (JSON.stringify(existing) !== JSON.stringify(event)) {
      throw new Error(`RuntimeEvent ${event.id} does not match the durable ledger record`);
    }
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    if (this.options.failRuntimeEventReads) throw new Error('runtime event read failed');
    await this.options.beforeRuntimeEventRead?.(sessionId, runId);
    return (this.runtimeEvents.get(key(sessionId, runId)) ?? []).map(copyRuntimeEvent);
  }

  async readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    if (this.options.failRuntimeEventReads) throw new Error('runtime event read failed');
    await this.options.beforeRuntimeEventRead?.(sessionId, runId);
    return (this.runtimeEvents.get(key(sessionId, runId)) ?? [])
      .filter((event) => event.partial !== true)
      .map(copyRuntimeEvent);
  }

  async readSessionRuntimeEventEntries(sessionId: string) {
    return this.runtimeEventEntries
      .filter((event) => event.sessionId === sessionId)
      .map((event, index) => ({ ordinal: index + 1, event: copyRuntimeEvent(event) }));
  }

  replaceRuntimeEvent(
    sessionId: string,
    runId: string,
    eventId: string,
    replacement: RuntimeEvent,
  ): void {
    const eventKey = key(sessionId, runId);
    const events = this.runtimeEvents.get(eventKey) ?? [];
    const index = events.findIndex((event) => event.id === eventId);
    if (index < 0) throw new Error(`Unknown RuntimeEvent ${eventId}`);
    const next = [...events];
    next[index] = copyRuntimeEvent(replacement);
    this.runtimeEvents.set(eventKey, next);
  }

  async readImmutableRuntimePrefix(input: {
    sessionId: string;
    runId: string;
    upToEventSeq?: number;
  }) {
    const events = await this.readImmutableRuntimeEvents(input.sessionId, input.runId);
    const selected =
      input.upToEventSeq === undefined ? events : events.slice(0, input.upToEventSeq);
    const first = selected[0];
    if (!first || selected.length !== (input.upToEventSeq ?? selected.length)) {
      throw new Error('immutable RuntimeEvent prefix is unavailable');
    }
    return buildImmutableRuntimePrefix(
      {
        sessionId: first.sessionId,
        invocationId: first.invocationId,
        runId: first.runId,
        turnId: first.turnId,
      },
      selected.map((event, index) => ({ eventSeq: index + 1, event })),
    );
  }

  async claimContinuation(input: { claim: ContinuationClaimV1 }) {
    const claim = decodeContinuationClaim(input.claim);
    const existing = this.continuationClaims.get(claim.boundaryDigest);
    if (existing) return { kind: 'existing' as const, claim: existing };
    const conflict = [...this.continuationClaims.values()].find(
      (candidate) =>
        candidate.target.invocationId === claim.target.invocationId ||
        candidate.target.runId === claim.target.runId ||
        (candidate.target.sessionId === claim.target.sessionId &&
          candidate.target.turnId === claim.target.turnId),
    );
    if (conflict) return { kind: 'conflict' as const, claim: conflict };
    this.continuationClaims.set(claim.boundaryDigest, claim);
    return { kind: 'acquired' as const, claim };
  }

  async readContinuationClaimByBoundary(
    boundaryDigest: RuntimeBoundaryDigest,
  ): Promise<ContinuationClaimV1 | undefined> {
    return this.continuationClaims.get(boundaryDigest);
  }

  async readContinuationClaimStateByBoundary(boundaryDigest: RuntimeBoundaryDigest) {
    if (this.options.failContinuationClaimReads) {
      throw new Error('continuation authority read failed');
    }
    const claim = this.continuationClaims.get(boundaryDigest);
    if (!claim) return undefined;
    const startEventId = this.runtimeEvents
      .get(key(claim.target.sessionId, claim.target.runId))
      ?.find((event) => event.actions?.continuationStart?.claimId === claim.claimId)?.id;
    const startKind = this.continuationStartKinds.get(boundaryDigest);
    return {
      claim,
      ...(startEventId && startKind ? { startEventId, startKind } : {}),
    };
  }

  async listContinuationClaimsForRecovery(sessionId: string) {
    if (this.options.failContinuationClaimReads) {
      throw new Error('continuation authority read failed');
    }
    const states = [];
    for (const claim of this.continuationClaims.values()) {
      if (claim.target.sessionId !== sessionId) continue;
      states.push((await this.readContinuationClaimStateByBoundary(claim.boundaryDigest))!);
    }
    return states;
  }

  async commitContinuationStart(input: { claim: ContinuationClaimV1; event: RuntimeEvent }) {
    return this.commitContinuationStartOfKind(input, 'runtime_admission');
  }

  async commitContinuationRepairStart(input: { claim: ContinuationClaimV1; event: RuntimeEvent }) {
    return this.commitContinuationStartOfKind(input, 'claim_repair');
  }

  private async commitContinuationStartOfKind(
    input: { claim: ContinuationClaimV1; event: RuntimeEvent },
    startKind: 'runtime_admission' | 'claim_repair',
  ) {
    if (input.event.actions?.continuationStart?.provenance !== startKind) {
      throw new Error('continuation start kind mismatch');
    }
    const existing = await this.readContinuationClaimStateByBoundary(input.claim.boundaryDigest);
    if (existing?.startEventId) {
      if (existing.startEventId !== input.event.id || existing.startKind !== startKind) {
        throw new Error('continuation claim already has a different start');
      }
      return { created: false, runtimeEventSeq: 1 };
    }
    await this.appendRuntimeEvent(
      input.claim.target.sessionId,
      input.claim.target.runId,
      input.event,
    );
    this.continuationStartKinds.set(input.claim.boundaryDigest, startKind);
    return { created: true, runtimeEventSeq: 1 };
  }

  async readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
    const ordered: Array<{ event: RuntimeEvent; runId: string; eventIndex: number }> = [];
    for (const [eventKey, events] of this.runtimeEvents.entries()) {
      const [eventSessionId, runId] = eventKey.split(':');
      if (eventSessionId !== sessionId || !runId) continue;
      events.forEach((event, eventIndex) =>
        ordered.push({ event: copyRuntimeEvent(event), runId, eventIndex }),
      );
    }
    ordered.sort(
      (a, b) =>
        a.event.ts - b.event.ts ||
        a.runId.localeCompare(b.runId) ||
        a.eventIndex - b.eventIndex ||
        a.event.id.localeCompare(b.event.id),
    );
    return ordered.map((item) => item.event);
  }
}

class ContinuationClaimBarrierRunStore extends MemoryAgentRunStore {
  private continuationClaimBarrierArmed = false;
  private markContinuationClaimRead: (() => void) | undefined;
  private releaseContinuationClaimReadWaiter: (() => void) | undefined;
  private readonly continuationClaimRead = new Promise<void>((resolve) => {
    this.markContinuationClaimRead = resolve;
  });

  private readonly continuationClaimRelease = new Promise<void>((resolve) => {
    this.releaseContinuationClaimReadWaiter = resolve;
  });

  armContinuationClaimBarrier(): void {
    this.continuationClaimBarrierArmed = true;
  }

  async waitForContinuationClaimRead(): Promise<void> {
    await this.continuationClaimRead;
  }

  releaseContinuationClaimRead(): void {
    this.releaseContinuationClaimReadWaiter?.();
  }

  override async listSessionRuns(sessionId: string): Promise<AgentRunHeader[]> {
    const snapshot = await super.listSessionRuns(sessionId);
    if (!this.continuationClaimBarrierArmed) return snapshot;
    this.continuationClaimBarrierArmed = false;
    this.markContinuationClaimRead?.();
    await this.continuationClaimRelease;
    return snapshot;
  }
}

/** Yields a forged queue_update before completing — round-6 R3's attacker. */
class ForgingQueueBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'queue_update',
      id: 'forged-queue-update',
      turnId: input.turnId,
      ts: 1,
      steering: ['forged pending message'],
      followup: [],
    };
    yield {
      type: 'text_complete',
      id: `${input.turnId}-final`,
      turnId: input.turnId,
      ts: 2,
      messageId: `${input.turnId}-m`,
      text: 'ok',
    };
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 3,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}

  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}

  async dispose(): Promise<void> {}
}

class ProviderRetryProgressBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'provider_retry',
      id: 'retry-scheduled',
      turnId: input.turnId,
      ts: 1,
      phase: 'scheduled',
      attempt: 2,
      maxAttempts: 10,
      delayMs: 1_000,
      reason: 'rate_limit',
    };
    yield {
      type: 'provider_retry',
      id: 'retry-started',
      turnId: input.turnId,
      ts: 2,
      phase: 'started',
      attempt: 2,
      maxAttempts: 10,
      reason: 'rate_limit',
    };
    yield {
      type: 'text_complete',
      id: `${input.turnId}-final`,
      turnId: input.turnId,
      ts: 3,
      messageId: `${input.turnId}-m`,
      text: 'ok',
    };
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 4,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}

  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}

  async dispose(): Promise<void> {}
}

class ReverseOrderedAgentRunStore extends MemoryAgentRunStore {
  override async listSessionRuns(sessionId: string): Promise<AgentRunHeader[]> {
    return (await super.listSessionRuns(sessionId)).reverse();
  }
}

class OrderingAgentRunStore extends MemoryAgentRunStore {
  operations: string[] = [];

  override async updateRun(
    sessionId: string,
    runId: string,
    patch: Partial<AgentRunHeader>,
  ): Promise<AgentRunHeader> {
    const next = await super.updateRun(sessionId, runId, patch);
    if (patch.status === 'completed') this.operations.push('completedRunHeader');
    return next;
  }

  override async appendRuntimeEvent(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void> {
    await super.appendRuntimeEvent(sessionId, runId, event);
    if (isTerminalRuntimeEvent(event)) this.operations.push('terminalRuntimeEvent');
  }
}

class MissingCheckpointProjectionAgentRunStore extends MemoryAgentRunStore {
  repairedProjection: AgentRunEvent | null | undefined;

  async readEventProjection(): Promise<undefined> {
    return undefined;
  }

  async readEventLedgerRevision(): Promise<string> {
    return 'missing-checkpoint-projection-test-revision';
  }

  async repairEventProjection(
    _sessionId: string,
    _type: AgentRunEvent['type'],
    event: AgentRunEvent | null,
    _options: { ifLedgerRevision: string; replaceEventId?: string },
  ): Promise<void> {
    this.repairedProjection = event;
  }
}

class MemoryRuntimeEventStore implements RuntimeEventStore {
  private runtimeEvents = new Map<string, RuntimeEvent[]>();
  private runtimeEventEntries: RuntimeEvent[] = [];

  constructor(
    private readonly options: {
      failRuntimeEventAppends?: boolean;
      failRuntimeEventReads?: boolean;
    } = {},
  ) {}

  async appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void> {
    if (this.options.failRuntimeEventAppends) throw new Error('runtime event append failed');
    const eventKey = key(sessionId, runId);
    this.runtimeEvents.set(eventKey, [
      ...(this.runtimeEvents.get(eventKey) ?? []),
      copyRuntimeEvent(event),
    ]);
    if (event.partial !== true && !this.runtimeEventEntries.some(({ id }) => id === event.id)) {
      this.runtimeEventEntries.push(copyRuntimeEvent(event));
    }
  }

  async ensureTerminalRuntimeEventDurable(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void> {
    const existing = (this.runtimeEvents.get(key(sessionId, runId)) ?? []).find(
      (candidate) => candidate.id === event.id,
    );
    if (!existing) {
      await this.appendRuntimeEvent(sessionId, runId, event);
      return;
    }
    if (JSON.stringify(existing) !== JSON.stringify(event)) {
      throw new Error(`RuntimeEvent ${event.id} does not match the durable ledger record`);
    }
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    if (this.options.failRuntimeEventReads) throw new Error('runtime event read failed');
    return (this.runtimeEvents.get(key(sessionId, runId)) ?? []).map(copyRuntimeEvent);
  }

  async readSessionRuntimeEventEntries(sessionId: string) {
    return this.runtimeEventEntries
      .filter((event) => event.sessionId === sessionId)
      .map((event, index) => ({ ordinal: index + 1, event: copyRuntimeEvent(event) }));
  }

  async readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
    const ordered: Array<{ event: RuntimeEvent; runId: string; eventIndex: number }> = [];
    for (const [eventKey, events] of this.runtimeEvents.entries()) {
      const [eventSessionId, runId] = eventKey.split(':');
      if (eventSessionId !== sessionId || !runId) continue;
      events.forEach((event, eventIndex) =>
        ordered.push({ event: copyRuntimeEvent(event), runId, eventIndex }),
      );
    }
    ordered.sort(
      (a, b) =>
        a.event.ts - b.event.ts ||
        a.runId.localeCompare(b.runId) ||
        a.eventIndex - b.eventIndex ||
        a.event.id.localeCompare(b.event.id),
    );
    return ordered.map((item) => item.event);
  }
}

interface Gate {
  promise: Promise<void>;
  release(): void;
}

function makeGate(): Gate {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function makeTestRuntimePolicyGate(): {
  runBackendActivation<T>(operation: () => Promise<T> | T): Promise<T>;
  runMutation<T>(operation: () => Promise<T>): Promise<T>;
} {
  const activeActivations = new Set<Promise<void>>();
  return {
    async runBackendActivation<T>(operation: () => Promise<T> | T): Promise<T> {
      const completion = makeGate();
      activeActivations.add(completion.promise);
      try {
        return await operation();
      } finally {
        completion.release();
        activeActivations.delete(completion.promise);
      }
    },
    async runMutation<T>(operation: () => Promise<T>): Promise<T> {
      await Promise.all([...activeActivations]);
      return operation();
    },
  };
}

function hostedRootAuthority(): RuntimeHostedRootAuthority {
  return {
    bindRun: (identity) => ({
      ...identity,
      pull: () => [],
      ack: () => {},
      nack: () => {},
      release: () => {},
    }),
    executeRoot: async (input) => {
      for await (const event of input.start({
        runId: input.runId,
        userMessageId: input.userMessageId,
        onRunStarted: () => input.onReady?.(),
      })) {
        input.onEvent?.(event);
      }
    },
    stopRoot: async () => {},
    stopSession: async () => {},
  };
}

function makeInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Session',
    labels: [],
    ...overrides,
  };
}

function createGraphOperatorSession(
  store: MemorySessionStore,
  parentSessionId: string,
): Promise<SessionHeader> {
  return store.create(
    makeInput({
      name: 'Graph operator',
      permissionMode: 'explore',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      subagentParent: {
        kind: 'subagent',
        parentSessionId,
        spawnedBy: {
          parentRunId: 'supervisor-run',
          parentTurnId: 'supervisor-turn',
          toolCallId: 'graph-operator-create',
        },
        lifecycle: 'foreground',
      },
      subagentRuntime: {
        schemaVersion: 1,
        definitionVersion: LOCAL_READ_AGENT_DEFINITION.definitionVersion,
        agentId: LOCAL_READ_AGENT_ID,
        agentName: LOCAL_READ_AGENT_DEFINITION.name,
        profile: LOCAL_READ_AGENT_PROFILE,
        systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
        toolNames: [...LOCAL_READ_AGENT_DEFINITION.tools],
        categoryPolicy: {},
      },
    }),
  );
}

function graphIntentClaim(
  overrides: Partial<AgentGraphIntentClaim> = {},
  prompt = 'test graph prompt',
): AgentGraphIntentClaim {
  const claim: AgentGraphIntentClaim = {
    schemaVersion: 1,
    claimId: `graph_claim_${'a'.repeat(32)}`,
    graphId: 'graph-1',
    intentId: `graph_intent_${'b'.repeat(32)}`,
    intentFingerprint: '',
    readinessContextFingerprint: `sha256:${'d'.repeat(64)}`,
    targetOperatorId: 'operator-1',
    targetSessionId: 'session-child',
    targetTurnId: 'graph-turn',
    targetRunId: 'graph-run',
    claimedAt: 10,
    ...overrides,
  };
  const intent = graphRunnableIntentForClaim(claim);
  return Object.freeze({
    ...claim,
    intentFingerprint:
      overrides.intentFingerprint ??
      fingerprintAgentGraphRunnableIntent({
        intent,
        executionInput: { prompt },
      }),
  });
}

function graphExecutionInput(claim: AgentGraphIntentClaim, prompt: string) {
  const intent = graphRunnableIntentForClaim(claim);
  const storedClaim = Object.freeze({ ...claim });
  const claimStore: AgentGraphIntentClaimStore = {
    async claimAgentGraphIntent() {
      throw new Error('test claim store is read-only');
    },
    async readAgentGraphIntentClaim(graphId, intentId) {
      return graphId === storedClaim.graphId && intentId === storedClaim.intentId
        ? storedClaim
        : undefined;
    },
    async listAgentGraphIntentClaims(graphId) {
      return !graphId || graphId === storedClaim.graphId ? [storedClaim] : [];
    },
  };
  return {
    claimStore,
    intent,
    graphId: claim.graphId,
    intentId: claim.intentId,
    prompt,
  };
}

function graphRunnableIntentForClaim(claim: AgentGraphIntentClaim): AgentGraphRunnableIntent {
  return {
    schemaVersion: 1,
    intentId: claim.intentId,
    graphId: claim.graphId,
    readinessContextFingerprint: claim.readinessContextFingerprint,
    policyFingerprint: `sha256:${'e'.repeat(64)}`,
    readinessId: 'readiness-1',
    operatorId: claim.targetOperatorId,
    targetSessionId: claim.targetSessionId,
    policyKind: 'map',
    triggerRouteIds: ['route-1'],
    triggerRecordIds: ['record-1'],
  };
}

async function createQueuedGraphScenario(firstAbortSignal?: AbortSignal) {
  const store = new MemorySessionStore();
  const runStore = new MemoryAgentRunStore();
  const backends = new BackendRegistry();
  const activeGate = makeGate();
  const firstReady = makeGate();
  const stopStarted = makeGate();
  let backend!: TestBackend;
  backends.register('ai-sdk', (ctx) => {
    backend = new (class extends TestBackend {
      override async stop(
        reason: 'user_stop' | 'redirect',
        mode: BackendStopMode = 'immediate',
      ): Promise<void> {
        await super.stop(reason, mode);
        stopStarted.release();
        activeGate.release();
      }
    })(ctx, activeGate);
    return backend;
  });
  const manager = new SessionManager({
    store,
    runStore,
    runtimeEventStore: runStore,
    backends,
    childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
    newId: nextId(),
    now: nextNow(70),
  });
  const parent = await manager.createSession(makeInput());
  const child = await createGraphOperatorSession(store, parent.id);
  const firstClaim = graphIntentClaim({ targetSessionId: child.id }, 'first activation');
  const secondClaim = graphIntentClaim(
    {
      claimId: `graph_claim_${'e'.repeat(32)}`,
      intentId: `graph_intent_${'f'.repeat(32)}`,
      targetSessionId: child.id,
      targetTurnId: 'graph-turn-2',
      targetRunId: 'graph-run-2',
    },
    'queued activation',
  );
  const thirdClaim = graphIntentClaim(
    {
      claimId: `graph_claim_${'1'.repeat(32)}`,
      intentId: `graph_intent_${'2'.repeat(32)}`,
      targetSessionId: child.id,
      targetTurnId: 'graph-turn-3',
      targetRunId: 'graph-run-3',
    },
    'third activation',
  );
  const first = manager.runClaimedAgentGraphIntent({
    ...graphExecutionInput(firstClaim, 'first activation'),
    ...(firstAbortSignal ? { abortSignal: firstAbortSignal } : {}),
    onReady: () => firstReady.release(),
  });
  await firstReady.promise;
  return {
    store,
    runStore,
    manager,
    child,
    backend,
    activeGate,
    stopStarted,
    first,
    claims: [firstClaim, secondClaim, thirdClaim] as const,
  };
}

function hostedGraphExecutionCapability(
  claims: AgentGraphIntentClaimStore,
  runs: MemoryAgentRunStore,
) {
  return {
    readAgentGraphIntentClaim: (graphId: string, intentId: string) =>
      claims.readAgentGraphIntentClaim(graphId, intentId),
    async readRootTurnAdmissionIdentity(sessionId: string, turnId: string) {
      const admission = await runs.readRootTurnAdmission(sessionId, turnId);
      return admission
        ? { runId: admission.runId, userMessageId: admission.userMessageId }
        : undefined;
    },
  };
}

function testTool(name: string): MakaTool {
  return {
    name,
    description: `${name} test tool`,
    parameters: {},
    impl: async () => ({ ok: true }),
  };
}

function makeRunHeader(overrides: Partial<AgentRunHeader> = {}): AgentRunHeader {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'running',
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

function makeRunEvent(overrides: Partial<EmittedAgentRunEvent> = {}): EmittedAgentRunEvent {
  return {
    type: 'run_started',
    id: `${overrides.runId ?? 'run-1'}-${overrides.type ?? 'run_started'}-${overrides.ts ?? 10}`,
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 10,
    ...overrides,
  };
}

function makeManagerForReadCutover(
  store: MemorySessionStore,
  runStore: AgentRunStore & RuntimeEventStore,
): SessionManager {
  const backends = new BackendRegistry();
  backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
  return new SessionManager({
    store,
    runStore,
    runtimeEventStore: runStore,
    backends,
    newId: nextId(),
    now: nextNow(6_755),
  });
}

async function seedRuntimeReadTurn(input: {
  store: MemorySessionStore;
  runStore: AgentRunStore & RuntimeEventStore;
  sessionId: string;
  turnId: string;
  runId: string;
  userText: string;
  assistantText: string;
  legacyIdPrefix: string;
}): Promise<{ legacyMessages: StoredMessage[]; projectedMessages: StoredMessage[] }> {
  const header = makeRunHeader({
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    status: 'completed',
    createdAt: 100,
    updatedAt: 103,
    completedAt: 103,
  });
  const events = [
    runtimeEvent({
      id: `${input.runId}-user-event`,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts: 101,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: input.userText },
      refs: { storedMessageId: `${input.runId}-projected-user` },
    }),
    runtimeEvent({
      id: `${input.runId}-assistant-event`,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts: 102,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: input.assistantText },
      refs: { storedMessageId: `${input.runId}-projected-assistant` },
    }),
    runtimeEvent({
      id: `${input.runId}-complete-event`,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts: 103,
      role: 'system',
      author: 'system',
      status: 'completed',
      actions: { endInvocation: true },
    }),
  ];
  const legacyMessages: StoredMessage[] = [
    {
      type: 'user',
      id: `${input.legacyIdPrefix}-user`,
      turnId: input.turnId,
      ts: 101,
      text: input.userText,
    },
    {
      type: 'assistant',
      id: `${input.legacyIdPrefix}-assistant`,
      turnId: input.turnId,
      ts: 102,
      text: input.assistantText,
      modelId: 'fake-model',
    },
    {
      type: 'turn_state',
      id: `${input.legacyIdPrefix}-state`,
      turnId: input.turnId,
      ts: 103,
      status: 'completed',
      partialOutputRetained: true,
    },
  ];
  const projectedMessages: StoredMessage[] = [
    {
      type: 'user',
      id: `${input.runId}-projected-user`,
      turnId: input.turnId,
      ts: 101,
      text: input.userText,
    },
    {
      type: 'assistant',
      id: `${input.runId}-projected-assistant`,
      turnId: input.turnId,
      ts: 102,
      text: input.assistantText,
      modelId: 'fake-model',
    },
    {
      type: 'turn_state',
      id: `${input.runId}-complete-event`,
      turnId: input.turnId,
      ts: 103,
      status: 'completed',
      partialOutputRetained: true,
    },
  ];
  await input.store.appendMessages(input.sessionId, legacyMessages);
  await seedRuntimeRun(input.runStore, header, events);
  return { legacyMessages, projectedMessages };
}

async function seedRuntimeReadTurnWithHeader(input: {
  store: MemorySessionStore;
  runStore: AgentRunStore & RuntimeEventStore;
  sessionId: string;
  turnId: string;
  runId: string;
  userText: string;
  assistantText: string;
  legacyIdPrefix: string;
  header: Partial<AgentRunHeader>;
  tsBase: number;
}): Promise<void> {
  const header = makeRunHeader({
    sessionId: input.sessionId,
    runId: input.runId,
    turnId: input.turnId,
    status: 'completed',
    createdAt: input.tsBase,
    updatedAt: input.tsBase + 3,
    completedAt: input.tsBase + 3,
    ...input.header,
  });
  const events = [
    runtimeEvent({
      id: `${input.runId}-user-event`,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts: input.tsBase + 1,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: input.userText },
      refs: { storedMessageId: `${input.runId}-projected-user` },
    }),
    runtimeEvent({
      id: `${input.runId}-assistant-event`,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts: input.tsBase + 2,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: input.assistantText },
      refs: { storedMessageId: `${input.runId}-projected-assistant` },
    }),
    runtimeEvent({
      id: `${input.runId}-complete-event`,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      ts: input.tsBase + 3,
      role: 'system',
      author: 'system',
      status: 'completed',
      actions: { endInvocation: true },
    }),
  ];
  await input.store.appendMessages(input.sessionId, [
    {
      type: 'user',
      id: `${input.legacyIdPrefix}-user`,
      turnId: input.turnId,
      ts: input.tsBase + 1,
      text: input.userText,
    },
    {
      type: 'assistant',
      id: `${input.legacyIdPrefix}-assistant`,
      turnId: input.turnId,
      ts: input.tsBase + 2,
      text: input.assistantText,
      modelId: 'fake-model',
    },
    {
      type: 'turn_state',
      id: `${input.legacyIdPrefix}-state`,
      turnId: input.turnId,
      ts: input.tsBase + 3,
      status: 'completed',
      ...(input.header.parentTurnId ? { parentTurnId: input.header.parentTurnId } : {}),
      ...(input.header.retriedFromTurnId
        ? { retriedFromTurnId: input.header.retriedFromTurnId }
        : {}),
      ...(input.header.regeneratedFromTurnId
        ? { regeneratedFromTurnId: input.header.regeneratedFromTurnId }
        : {}),
      ...(input.header.branchOfTurnId ? { branchOfTurnId: input.header.branchOfTurnId } : {}),
      ...(input.header.parentSessionId ? { parentSessionId: input.header.parentSessionId } : {}),
      partialOutputRetained: true,
    },
  ]);
  await seedRuntimeRun(input.runStore, header, events);
}

async function seedRun(
  runStore: AgentRunStore,
  header: AgentRunHeader,
  events: EmittedAgentRunEvent[],
): Promise<void> {
  await runStore.createRun(header);
  for (const event of events) {
    await runStore.appendEvent(header.sessionId, header.runId, event);
  }
}

async function seedRuntimeRun(
  runStore: AgentRunStore & RuntimeEventStore,
  header: AgentRunHeader,
  events: RuntimeEvent[],
): Promise<void> {
  await runStore.createRun(header);
  for (const event of events) {
    await runStore.appendRuntimeEvent(header.sessionId, header.runId, event);
  }
}

function runtimeEvent(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'rt-event',
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 100,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

async function seedCanonicalPermissionRun(
  runStore: MemoryAgentRunStore,
  header: AgentRunHeader,
  includeLedgerRequest = true,
): Promise<void> {
  const events = [
    runtimeEvent({
      id: 'permission-user-canonical',
      sessionId: header.sessionId,
      runId: header.runId,
      turnId: header.turnId,
      ts: 99,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'write the file' },
    }),
    ...(includeLedgerRequest
      ? [
          runtimeEvent({
            id: 'permission-request-canonical',
            sessionId: header.sessionId,
            runId: header.runId,
            turnId: header.turnId,
            ts: 100,
            actions: {
              permissionRequest: {
                kind: 'tool_permission',
                requestId: 'request-canonical',
                toolUseId: 'tool-canonical',
                toolName: 'Write',
                category: 'file_write',
                reason: 'file_write',
                args: { path: '/tmp/file' },
                rememberForTurnAllowed: true,
                hint: 'write approval',
              },
            },
            refs: { toolCallId: 'tool-canonical' },
          }),
        ]
      : []),
    runtimeEvent({
      id: 'permission-answer-canonical',
      sessionId: header.sessionId,
      runId: header.runId,
      turnId: header.turnId,
      ts: 126,
      author: 'user',
      actions: {
        permissionAnswerAccepted: { requestId: 'request-canonical' },
      },
      refs: { toolCallId: 'tool-canonical' },
    }),
    runtimeEvent({
      id: 'permission-terminal-canonical',
      sessionId: header.sessionId,
      runId: header.runId,
      turnId: header.turnId,
      ts: 130,
      status: 'completed',
      actions: { endInvocation: true },
    }),
  ];
  await seedRuntimeRun(runStore, header, events);
}

function canonicalPermissionRecord(
  header: AgentRunHeader,
  overrides: Partial<CanonicalPermissionOutcomeRecord> = {},
): CanonicalPermissionOutcomeRecord {
  return {
    sessionId: header.sessionId,
    runId: header.runId,
    turnId: header.turnId,
    requestId: 'request-canonical',
    request: {
      kind: 'permission',
      toolUseId: 'tool-canonical',
      prompt: {
        kind: 'tool_permission',
        toolName: 'Write',
        category: 'file_write',
        reason: 'file_write',
        review: { kind: 'path', operation: 'write', path: '/tmp/file' },
        rememberForTurnAllowed: true,
      },
    },
    outcome: {
      kind: 'permission_answer',
      decision: 'deny',
      rememberForTurn: false,
      reviewer: 'user',
      committedAt: 125,
    },
    ...overrides,
  };
}

const noCanonicalPermissionOutcomes: CanonicalPermissionOutcomeReader = {
  readPermissionOutcome: async () => undefined,
};

function testInteractionAuthority(): RuntimeInteractionAuthority {
  return {
    bindRun: (identity) => ({
      ...identity,
      acceptSandboxBoundaryRequest: async () => {},
      acceptUserQuestionRequest: async () => {},
      close: async () => {},
      release: () => {},
    }),
  };
}

/**
 * A session interrupted while one turn held a sandbox boundary request: the
 * request row exists with its turn/run provenance, the run is still
 * non-terminal, and the ledger holds nothing about the boundary. Tests layer
 * their own settlement or ledger events on top.
 */
async function seedBoundaryRestartSession(input: {
  now: number;
  requestId: string;
  requestTurnId?: string;
  requestRunId?: string;
  interactionAuthority?: RuntimeInteractionAuthority;
}): Promise<{
  store: MemorySessionStore;
  runStore: MemoryAgentRunStore;
  manager: SessionManager;
  session: SessionSummary;
}> {
  const store = new MemorySessionStore();
  const runStore = new MemoryAgentRunStore();
  const backends = new BackendRegistry();
  backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
  const managerDeps = {
    store,
    runStore,
    runtimeEventStore: runStore,
    backends,
    newId: nextId(),
    now: nextNow(input.now),
  };
  const manager = input.interactionAuthority
    ? new SessionManager({
        ...managerDeps,
        interactionAuthority: input.interactionAuthority,
        canonicalPermissionOutcomes: noCanonicalPermissionOutcomes,
      })
    : new SessionManager(managerDeps);
  const session = await manager.createSession(makeInput({ status: 'waiting_for_user' }));
  await store.createSandboxBoundaryRequest({
    sessionId: session.id,
    requestId: input.requestId,
    turnId: input.requestTurnId ?? 'turn-1',
    runId: input.requestRunId ?? 'run-1',
    expansion: { network: { enabled: true } },
    justification: 'Fetch a dependency.',
  });
  await seedRunningTurn(store, session.id, 'turn-1');
  await seedRun(
    runStore,
    makeRunHeader({
      sessionId: session.id,
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'waiting_for_user',
    }),
    [
      makeRunEvent({
        sessionId: session.id,
        runId: 'run-1',
        turnId: 'turn-1',
        type: 'run_started',
        ts: 11,
      }),
    ],
  );
  return { store, runStore, manager, session };
}

async function seedRunningTurn(
  store: MemorySessionStore,
  sessionId: string,
  turnId: string,
): Promise<void> {
  await store.appendMessages(sessionId, [
    { type: 'user', id: `${turnId}-user`, turnId, ts: 9, text: 'interrupted turn' },
    {
      type: 'turn_state',
      id: `${turnId}-state`,
      turnId,
      ts: 10,
      status: 'running',
      partialOutputRetained: false,
    },
  ]);
}
function nextNow(start: number): () => number {
  let ts = start;
  return () => ++ts;
}

async function inspectStableContinuationSafety() {
  return {
    workspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [] as string[],
  };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) {
    // consume
  }
}

async function collectSessionEvents(
  iterable: AsyncIterable<SessionEvent>,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function expectRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    assert.match(String(err instanceof Error ? err.message : String(err)), pattern);
    return;
  }
  throw new Error('Expected promise to reject');
}

function key(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}

function copyEvent(event: AgentRunEvent): AgentRunEvent {
  return {
    ...event,
    ...(event.data ? { data: { ...event.data } } : {}),
  };
}

function copyRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  return JSON.parse(JSON.stringify(event)) as RuntimeEvent;
}
