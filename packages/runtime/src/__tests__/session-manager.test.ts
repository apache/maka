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
import { DEEP_RESEARCH_SESSION_LABEL } from '@maka/core/explore-agent';
import { SIDE_CONVERSATION_SESSION_LABEL } from '@maka/core/side-conversation';
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
import type { QueueEnqueueOutcome, SessionEvent, ShellRunSnapshotResult } from '@maka/core/events';
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
import type { BackendSendInput, BackendStopMode } from '@maka/core/backend-types';
import { PlanConflictError, emptyPlanSessionState, type PlanStore } from '@maka/core/plan';
import { expect } from '../test-helpers.js';
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
import type { InvocationResult } from '../invocation-context.js';
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
  WEB_RESEARCH_AGENT_DEFINITION,
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

    expect(committedApprovals).toBe(1);
    expect((await store.readHeader(sessionId)).collaborationMode).toBe('agent');
    expect(runtimeKernel.disposed).toEqual([sessionId]);
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
    expect(committedRevisions).toBe(0);

    await manager.requestPlanRevision(sessionId, 'proposal-1', 'revision-operation');
    expect(committedRevisions).toBe(1);
    expect(runtimeKernel.disposed).toEqual([sessionId]);
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
    expect(committedCancellations).toBe(0);

    await manager.cancelPlanExecution(sessionId, 'execution-1', 'cancel-operation');
    expect(committedCancellations).toBe(1);
    expect(runtimeKernel.disposed).toEqual([sessionId]);
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
        configuration: {
          backend: child.backend,
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
    expect(provisionSettled).toBe(true);
    const provisioned = await provision;
    expect(provisioned.created).toBe(true);
    expect(provisioned.header.name).toBe('Fast graph reader');
    expect(provisioned.header.llmConnectionSlug).toBe('worker-connection');
    expect(provisioned.header.model).toBe('worker-model');
    expect(provisioned.header.thinkingLevel).toBe('low');
    expect(provisioned.header.subagentRuntime?.presetId).toBe('fast-reader');
    expect(provisioned.provision.agentId).toBe(LOCAL_READ_AGENT_ID);

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
        configuration: {
          backend: parent.backend,
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
    expect(transitionSettled).toBe(false);

    releaseProvision.release();
    const provisioned = await provision;
    const transitionResult = await transition;
    expect(transitionResult.ok).toBe(false);
    if (transitionResult.ok) throw new Error('Configuration transition unexpectedly committed');
    assert.ok(transitionResult.error instanceof SessionConfigurationTransitionError);
    expect(transitionResult.error.code).toBe('operation_conflict');
    expect((await store.readHeader(parent.id)).permissionMode).toBe('bypass');
    expect(provisioned.header.permissionMode).toBe('bypass');
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

    expect(result.created).toBe(true);
    expect(result.header.subagentParent?.graph).toEqual({
      graphId: 'graph-1',
      workId: `graph_work_${'1'.repeat(32)}`,
      operatorId: `graph_operator_${'2'.repeat(32)}`,
    });
    expect(result.header.subagentRuntime?.agentId).toBe(LOCAL_READ_AGENT_ID);
    expect(result.header.permissionMode).toBe('explore');
    expect(result.provision.initialTurnId).toBe(result.header.subagentSpawn?.initialTurnId);
    expect(result.provision.initialRunId).toBe(result.header.subagentSpawn?.initialRunId);
    expect(await runStore.listSessionRuns(result.header.id)).toEqual([]);
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
    expect(Buffer.byteLength(oversizedPayload, 'utf8') * outputs.length >= 2_500 * 1024).toBe(true);
    expect(Buffer.byteLength(serializedOutputs, 'utf8') < 64 * 1024).toBe(true);
    expect(serializedOutputs.includes(oversizedPayload.slice(0, 1024))).toBe(false);
    expect(outputs.every((output) => output.runtimeEvents.length === 0)).toBe(true);
    expect(outputs.every((output) => output.budget.projectedBytes <= 32 * 1024)).toBe(true);
    expect(outputs[2]?.result?.status).toBe('failed');
    expect(outputs[2]?.result?.failureClass).toBe('branch_failed');
    expect(outputs[4]?.result?.text).toBe('Replacement branch completed with a verified answer.');
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

    expect(checkedSources).toEqual([
      { sourceCwd: '/tmp/plain-folder', sourceProjectId: 'plain-project' },
    ]);
    expect(implementation?.availability).toEqual({
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

    expect(provisioned).toHaveLength(1);
    expect(result.header.projectId).toBe('project-1');
    expect(result.header.permissionMode).toBe('execute');
    expect(
      result.header.subagentRuntime
        ? 'permissionCeiling' in result.header.subagentRuntime
        : undefined,
    ).toBe(false);
    expect(result.header.cwd).toBe(result.header.subagentWorkspace?.worktreePath);
    expect(result.header.subagentWorkspace?.kind).toBe('git_worktree');
    expect(result.header.subagentWorkspace?.branch).toMatch(/^maka\/subagent\//);
    expect(result.header.subagentRuntime?.toolNames).toEqual([
      'Read',
      'Glob',
      'Grep',
      'apply_patch',
      'Bash',
      'WriteStdin',
      'StopBackgroundTask',
    ]);
    expect(headerToSummary(result.header).subagentWorkspace).toEqual(
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
        permissionMode: 'execute',
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
        permissionMode: 'execute',
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

    expect(captures).toBe(1);
    expect(artifacts.get(`${child.id}:child-turn`)?.[0]?.source).toBe('subagent_writeback');

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
        permissionMode: 'execute',
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
    expect(captures).toBe(1);
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

    expect(await runStore.listSessionRuns(child.id)).toEqual([]);
    expect(await store.readMessages(child.id)).toEqual([]);
    expect(backendBuilds).toBe(0);
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

    expect(result.status).toBe('completed');
    expect(trustedReads).toBe(1);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      sessionId: child.id,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
      userMessageId: 'id-1',
      execution: {
        kind: 'claimed_agent_graph_intent',
        claim,
        agentId: LOCAL_READ_AGENT_ID,
        agentName: LOCAL_READ_AGENT_DEFINITION.name,
      },
      content: { text: prompt },
    });
    expect(
      (await store.readMessages(child.id)).find(
        (message) => message.type === 'user' && message.turnId === claim.targetTurnId,
      ),
    ).toMatchObject({ id: 'id-1', text: prompt });
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

    expect(hostedExecutions).toBe(0);
    expect(backendBuilds).toBe(0);
    expect(await runStore.listSessionRuns(child.id)).toEqual([]);
    expect(await store.readMessages(child.id)).toEqual([]);
    expect(
      await runStore.readRootTurnAdmission(child.id, proposedClaim.targetTurnId),
    ).toBeUndefined();
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
      expect(input.userMessageId).toBe('durable-graph-user-message');
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

    expect(result.status).toBe('completed');
    expect(newIdCallsAtExecution).toBe(0);
    expect(
      (await store.readMessages(child.id)).find(
        (message) => message.type === 'user' && message.turnId === claim.targetTurnId,
      ),
    ).toMatchObject({
      id: 'durable-graph-user-message',
      text: 'resume admitted graph root',
    });
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

    expect(hostedExecutions).toBe(0);
    expect(backendBuilds).toBe(0);
    expect(await store.readMessages(child.id)).toEqual([]);
    expect((await runStore.readRun(child.id, claim.targetRunId)).status).toBe('completed');
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

    expect(stoppedRoots).toEqual([
      {
        sessionId: child.id,
        turnId: claim.targetTurnId,
        runId: claim.targetRunId,
      },
    ]);
    expect(stoppedSessions).toBe(0);
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
    expect(run).toMatchObject({
      status: 'failed',
      failureClass: 'app_restarted',
      agentId: LOCAL_READ_AGENT_ID,
      agentName: LOCAL_READ_AGENT_DEFINITION.name,
    });
    expect(run.workspaceIdentity).toBe(undefined);
    expect(run.resumedFromRunId).toBe(undefined);
    expect(run.retriedFromRunId).toBe(undefined);
    const terminalEvents = (await runStore.readRuntimeEvents(child.id, claim.targetRunId)).filter(
      (event) => event.status === 'failed',
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.actions?.stateDelta).toMatchObject({
      recovered: true,
      recoveryReason: 'child_internal_admission_without_run',
      executionKind: 'claimed_agent_graph_intent',
      failureClass: 'app_restarted',
    });
    expect(terminalEvents[0]?.actions?.stateDelta?.sourceRunId).toBe(undefined);
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

    expect(result).toMatchObject({
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
    expect(ready).toEqual([
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
    expect(isSessionInlineRun(run)).toBe(true);
    expect(run.parentRunId).toBe(undefined);
    expect(run.turnId).toBe('graph-turn');
    expect(
      (await store.readMessages(child.id)).find(
        (message) => message.type === 'user' && message.turnId === 'graph-turn',
      ),
    ).toMatchObject({ text: 'summarize the routed records' });

    await store.updateHeader(child.id, { isArchived: true });
    const retry = await manager.runClaimedAgentGraphIntent({
      ...graphExecutionInput(claim, 'summarize the routed records'),
    });
    expect(retry).toMatchObject({
      claimId: result.claimId,
      childSessionId: result.childSessionId,
      turnId: result.turnId,
      runId: result.runId,
      status: 'completed',
      summary: 'ok',
    });
    expect((await runStore.listSessionRuns(child.id)).length).toBe(1);
    expect(backendsBySession.get(child.id)?.sendInputs.length).toBe(1);
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
    expect(joinedResult).toEqual(firstResult);
    expect(childBackend?.sendInputs.length).toBe(1);
    expect((await runStore.listSessionRuns(child.id)).length).toBe(1);
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
    expect(secondReadyCount).toBe(0);
    expect(backend?.sendInputs.length).toBe(1);

    queuedAbort.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(backend?.stopCalls).toBe(0);
    expect((await runStore.listSessionRuns(child.id)).length).toBe(1);

    activeGate.release();
    expect((await first).status).toBe('completed');
    await expectRejects(second, /cancelled before runtime admission/);
    expect(secondReadyCount).toBe(0);
    expect(backend?.stopCalls).toBe(0);
    expect(backend?.sendInputs.length).toBe(1);

    const third = await manager.runClaimedAgentGraphIntent(
      graphExecutionInput(thirdClaim, 'third activation'),
    );
    expect(third.status).toBe('completed');
    expect(backend?.sendInputs.length).toBe(2);
    expect((await runStore.listSessionRuns(child.id)).length).toBe(2);
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
    expect(admissionChecks).toBe(0);

    firstGate.release();
    expect((await first).status).toBe('completed');
    await expectRejects(queued, /cancelled before runtime admission/);
    expect(admissionChecks).toBe(1);
    expect(backend?.sendInputs.length).toBe(1);
    expect((await runStore.listSessionRuns(child.id)).length).toBe(1);
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
    expect(backend?.sendInputs).toHaveLength(1);
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
    expect(stopSettled).toBe(false);
    expect(backend?.sendInputs).toHaveLength(1);

    releaseAdmission.release();
    await stop;
    const result = await execution;

    expect(result.status).toBe('cancelled');
    expect(backend?.stopCalls).toBe(1);
    expect(backend?.sendInputs).toHaveLength(1);
    expect((await runStore.readRun(child.id, claim.targetRunId)).status).toBe('cancelled');
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

    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('rejected');
    expect(results[2]?.status).toBe('rejected');
    expect(queuedReady).toBe(0);
    expect(backend?.sendInputs.map((input) => input.turnId)).toEqual([firstClaim.targetTurnId]);
    expect((await runStore.listSessionRuns(child.id)).map((run) => run.turnId)).toEqual([
      firstClaim.targetTurnId,
    ]);
    expect(
      (await store.readMessages(child.id)).filter(
        (message) =>
          'turnId' in message &&
          (message.turnId === secondClaim.targetTurnId ||
            message.turnId === thirdClaim.targetTurnId),
      ),
    ).toEqual([]);
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

    expect(recovered.status).toBe('failed');
    expect(recovered.failureClass).toBe('app_restarted');
    expect(backendBuilds).toBe(0);
    expect((await runStore.listSessionRuns(child.id)).length).toBe(1);
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
    expect(stopSettled).toBe(false);

    releaseRead.release();
    const [result] = await Promise.all([executing, stopping]);
    expect(result.status).toBe('cancelled');
    expect(backend?.sendInputs).toEqual([]);
    expect((await runStore.readRun(child.id, claim.targetRunId)).status).toBe('cancelled');
    expect((await store.readHeader(child.id)).status === 'blocked').toBe(false);
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
    expect(backendBuilds).toBe(0);
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
      runtimeSource: 'test',
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
    expect(await store.readExecutionBoundary(result.childSessionId)).toEqual(
      await store.readExecutionBoundary(parent.id),
    );
    expect(childHeader.cwd).toBe('/tmp/project');
    expect(childHeader.projectId).toBe('project-1');
    expect(childHeader.workspaceRoot).toBe((await store.readHeader(parent.id)).workspaceRoot);
    expect(childHeader.llmConnectionSlug).toBe('connection-1');
    expect(childHeader.model).toBe('model-1');
    expect(childHeader.thinkingLevel).toBe('medium');
    expect(childHeader.permissionMode).toBe('explore');
    expect(childHeader.connectionLocked).toBe(true);
    expect(childHeader.subagentParent).toEqual({
      kind: 'subagent',
      parentSessionId: parent.id,
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'tool-call-1',
      },
      lifecycle: 'foreground',
    });
    expect(childHeader.subagentRuntime).toEqual({
      schemaVersion: 1,
      definitionVersion: 1,
      agentId: LOCAL_READ_AGENT_ID,
      agentName: 'Local Read',
      profile: LOCAL_READ_AGENT_PROFILE,
      systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
      toolNames: ['Read', 'Glob', 'Grep'],
      categoryPolicy: {},
    });
    expect(childHeader.subagentSpawn?.schemaVersion).toBe(1);
    expect(childHeader.subagentSpawn?.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(childHeader.subagentSpawn?.initialTurnId).toBe(result.turnId);
    expect(childHeader.subagentSpawn?.initialRunId).toBe(result.runId);

    const [childRun] = await runStore.listSessionRuns(result.childSessionId);
    if (!childRun) throw new Error('child run was not recorded');
    expect(childRun.runId).toBe(result.runId);
    expect(childRun.parentRunId).toBe(undefined);
    expect(childRun.agentId).toBe(LOCAL_READ_AGENT_ID);
    expect(isSessionInlineRun(childRun)).toBe(true);
    expect(result.status).toBe('completed');
    expect(backendActivationSessions).toEqual([parent.id, result.childSessionId]);
    expect(
      (await runStore.readRuntimeEvents(result.childSessionId, childRun.runId)).every(
        (event) => event.sessionId === result.childSessionId,
      ),
    ).toBe(true);

    const childContext = contexts.find((ctx) => ctx.sessionId === result.childSessionId);
    expect(childContext?.systemPrompt).toBe(LOCAL_READ_AGENT_DEFINITION.systemPrompt);
    expect(childContext?.tools?.map((tool) => tool.name)).toEqual(['Read', 'Glob', 'Grep']);
    expect(backendsBySession.get(result.childSessionId)?.sendInputs[0]?.context).toEqual([]);
    expect(
      backendsBySession
        .get(result.childSessionId)
        ?.sendInputs[0]?.runtimeContext?.some(
          (event) =>
            event.content?.kind === 'text' && event.content.text === 'private parent history',
        ) ?? false,
    ).toBe(false);

    const parentMessages = await store.readMessages(parent.id);
    const childMessages = await store.readMessages(result.childSessionId);
    expect(
      parentMessages.some(
        (message) => message.type === 'user' && message.text === 'inspect the storage boundary',
      ),
    ).toBe(false);
    expect(
      childMessages.some(
        (message) => message.type === 'user' && message.text === 'inspect the storage boundary',
      ),
    ).toBe(true);
    await manager.setPermissionMode(result.childSessionId, 'execute');
    expect((await store.readHeader(result.childSessionId)).permissionMode).toBe('execute');
    const projection = await manager.listChildAgents(parent.id);
    expect(projection.runs).toEqual([]);
    expect(projection.executions).toHaveLength(1);
    expect(projection.executions[0]?.execution).toEqual({
      kind: 'child_session',
      sessionId: result.childSessionId,
      currentRunId: result.runId,
    });
    expect(projection.executions[0]?.status).toBe('completed');
    const output = await manager.readChildAgentOutput(parent.id, {
      execution: {
        kind: 'child_session',
        sessionId: result.childSessionId,
      },
    });
    expect(output.execution).toEqual({
      kind: 'child_session',
      sessionId: result.childSessionId,
      currentRunId: result.runId,
    });
    expect(output.header.sessionId).toBe(result.childSessionId);
    expect(output.header.runId).toBe(result.runId);
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
      runtimeSource: 'test',
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

    expect(child.llmConnectionSlug).toBe('worker-connection');
    expect(child.model).toBe('worker-model');
    expect(child.thinkingLevel).toBe('low');
    expect(child.subagentRuntime?.presetId).toBe('fast-reader');
    expect(child.subagentRuntime?.agentName).toBe('Fast reader');
    expect(child.connectionLocked).toBe(true);
    expect((await manager.listChildAgents(parent.id)).presets[0]?.id).toBe('fast-reader');

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
      runtimeSource: 'test',
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

    expect((await store.readHeader(child.childSessionId)).projectId).toBe(null);
    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('resumes a fresh child by returned runId inside the same linked Session', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    const backendsBySession = new Map<string, TestBackend>();
    backends.register('ai-sdk', (ctx) => {
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
      now: nextNow(130),
      runtimeSource: 'test',
    });
    const parent = await manager.createSession(makeInput({ permissionMode: 'ask' }));
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
        toolCallId: 'fresh-swarm-item',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'inspect the initial boundary',
    });
    const prepared = await manager.prepareChildAgentResume(parent.id, child.runId);
    expect(prepared.execution).toEqual({
      kind: 'child_session',
      sessionId: child.childSessionId,
      currentRunId: child.runId,
    });

    const resumed = await manager.resumeChildAgent(parent.id, {
      parentRunId: parentRun.runId,
      sourceRunId: child.runId,
      prompt: 'continue from the returned swarm run id',
    });
    expect(resumed.childSessionId).toBe(child.childSessionId);
    expect(resumed.resumedFromRunId).toBe(child.runId);
    const resumedRun = await runStore.readRun(child.childSessionId, resumed.runId!);
    expect(isSessionInlineRun(resumedRun)).toBe(true);
    expect(resumedRun.parentRunId).toBe(undefined);
    expect(resumedRun.resumedFromRunId).toBe(child.runId);
    expect(
      backendsBySession
        .get(child.childSessionId)
        ?.sendInputs[1]?.runtimeContext?.some((event) => event.runId === child.runId),
    ).toBe(true);
    expect((await manager.listChildAgents(parent.id)).executions[0]?.execution).toEqual({
      kind: 'child_session',
      sessionId: child.childSessionId,
      currentRunId: resumed.runId,
    });

    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('does not resume a linked child after its parent boundary narrows', async () => {
    const store = new AtomicBoundaryMemorySessionStore();
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
      now: nextNow(140),
      runtimeSource: 'test',
    });
    const parent = await manager.createSession(makeInput({ permissionMode: 'bypass' }));
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
        toolCallId: 'stale-boundary-child',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'inspect before the boundary narrows',
    });
    store.forceBoundary(parent.id, {
      ...createGenesisExecutionBoundary('ask'),
      revision: 1,
    });

    await expectRejects(
      manager.prepareChildAgentResume(parent.id, child.runId),
      /execution boundary no longer matches its parent/,
    );

    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('retries a rate-limited fresh child inside the same linked Session', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    const childInputs: BackendSendInput[] = [];
    let childAttempts = 0;
    let failClaimOnce = true;
    backends.register('ai-sdk', (ctx) => {
      if (!ctx.header.subagentRuntime) return new TestBackend(ctx, parentGate);
      return {
        kind: 'fake' as const,
        sessionId: ctx.sessionId,
        async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
          childAttempts += 1;
          childInputs.push(input);
          if (childAttempts <= 2) {
            yield {
              type: 'error',
              id: `${input.turnId}-error`,
              turnId: input.turnId,
              ts: 1,
              recoverable: true,
              reason: 'RateLimit',
              message: 'provider 429',
            };
            yield {
              type: 'complete',
              id: `${input.turnId}-complete`,
              turnId: input.turnId,
              ts: 2,
              stopReason: 'error',
            };
            return;
          }
          yield {
            type: 'text_delta',
            id: `${input.turnId}-delta`,
            turnId: input.turnId,
            ts: 3,
            messageId: `${input.turnId}-message`,
            text: 'recovered',
          };
          yield {
            type: 'complete',
            id: `${input.turnId}-complete`,
            turnId: input.turnId,
            ts: 4,
            stopReason: 'end_turn',
          };
        },
        async stop(): Promise<void> {},
        async respondToSandboxBoundary(): Promise<void> {},
        async dispose(): Promise<void> {},
      };
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      inspectContinuationSafety: async () => ({
        workspaceIdentity: '/tmp/cwd',
        backgroundOperationsSettled: true,
        availableToolNames: [],
      }),
      continuationFailpoint: async (point) => {
        if (point === 'after_continuation_claim_committed' && failClaimOnce) {
          failClaimOnce = false;
          throw new Error('simulated linked child claim-only crash');
        }
      },
      newId: nextId(),
      now: nextNow(145),
      runtimeSource: 'test',
    });
    const parent = await manager.createSession(makeInput({ permissionMode: 'ask' }));
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
        toolCallId: 'rate-limited-swarm-item',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'inspect with a transient provider failure',
    });
    expect(child.status).toBe('failed');
    expect(child.failureClass).toBe('RateLimit');

    const resumed = await manager.resumeChildAgent(parent.id, {
      parentRunId: parentRun.runId,
      sourceRunId: child.runId,
      prompt: 'retry with additional guidance',
    });
    expect(resumed.status).toBe('failed');
    expect(resumed.failureClass).toBe('RateLimit');
    await expectRejects(
      manager.retryChildAgent(parent.id, {
        parentRunId: parentRun.runId,
        sourceRunId: child.runId,
      }),
      /already has a successor/,
    );

    const resumedHeader = await runStore.readRun(child.childSessionId, resumed.runId!);
    const resumedTerminal = (
      await runStore.readImmutableRuntimeEvents(child.childSessionId, resumed.runId!)
    ).find(isTerminalRuntimeEvent);
    if (!resumedTerminal) throw new Error('resumed child terminal fact was not recorded');
    runStore.replaceRuntimeEvent(child.childSessionId, resumed.runId!, resumedTerminal.id, {
      ...resumedTerminal,
      actions: {
        ...resumedTerminal.actions,
        stateDelta: {
          ...resumedTerminal.actions?.stateDelta,
          failureClass: 'continuation_abandoned_before_provider_dispatch',
        },
      },
    });
    await runStore.updateRun(child.childSessionId, resumed.runId!, {
      failureClass: 'continuation_abandoned_before_provider_dispatch',
    });
    await expectRejects(
      manager.retryChildAgent(parent.id, {
        parentRunId: parentRun.runId,
        sourceRunId: resumed.runId!,
        execution: {
          kind: 'child_session',
          sessionId: child.childSessionId,
          currentRunId: resumed.runId!,
        },
      }),
      /proven pre-provider continuation abandonment/,
    );
    runStore.replaceRuntimeEvent(
      child.childSessionId,
      resumed.runId!,
      resumedTerminal.id,
      resumedTerminal,
    );
    await runStore.updateRun(child.childSessionId, resumed.runId!, {
      failureClass: resumedHeader.failureClass,
    });

    await expectRejects(
      manager.retryChildAgent(parent.id, {
        parentRunId: parentRun.runId,
        sourceRunId: resumed.runId!,
        execution: {
          kind: 'child_session',
          sessionId: child.childSessionId,
          currentRunId: resumed.runId!,
        },
      }),
      /simulated linked child claim-only crash/,
    );
    expect(childInputs).toHaveLength(2);

    const [claimState] = await runStore.listContinuationClaimsForRecovery(child.childSessionId);
    if (!claimState) throw new Error('linked child continuation claim was not recorded');
    const claimedHeader = claimState.claim.targetRunHeader;
    if (!claimedHeader.agentId || !claimedHeader.agentName) {
      throw new Error('linked child continuation claim lost its trusted agent identity');
    }
    await manager.closePendingHostedAdmission({
      sessionId: child.childSessionId,
      turnId: claimState.claim.target.turnId,
      runId: claimState.claim.target.runId,
      admittedAt: claimState.claim.claimedAt - 1,
      execution: {
        kind: 'linked_child_provider_retry',
        agentId: claimedHeader.agentId,
        agentName: claimedHeader.agentName,
        sourceRunId: resumed.runId!,
      },
    });
    await expectRejects(
      runStore.readRun(child.childSessionId, claimState.claim.target.runId),
      /unknown run/i,
    );

    await manager.recoverInterruptedSessions();
    const repaired = (await runStore.listSessionRuns(child.childSessionId)).find(
      (run) =>
        run.retriedFromRunId === resumed.runId &&
        run.failureClass === 'continuation_abandoned_before_provider_dispatch',
    );
    if (!repaired) throw new Error('linked child claim-only target was not repaired');

    const retried = await manager.retryChildAgent(parent.id, {
      parentRunId: parentRun.runId,
      sourceRunId: repaired.runId,
      execution: {
        kind: 'child_session',
        sessionId: child.childSessionId,
        currentRunId: repaired.runId,
      },
    });
    expect(retried.status).toBe('completed');
    expect(retried.childSessionId).toBe(child.childSessionId);
    expect(retried.retriedFromRunId).toBe(repaired.runId);
    expect(childInputs.map((input) => input.text)).toEqual([
      'inspect with a transient provider failure',
      'retry with additional guidance',
      '',
    ]);
    const retryRun = await runStore.readRun(child.childSessionId, retried.runId!);
    expect(isSessionInlineRun(retryRun)).toBe(true);
    expect(retryRun.parentRunId).toBe(undefined);
    expect(retryRun.retriedFromRunId).toBe(repaired.runId);
    expect(retryRun.continuationSource).toMatchObject({
      protocol: 'continuation_source_v2',
      sourceRunId: repaired.runId,
    });
    const retryStart = (
      await runStore.readImmutableRuntimeEvents(child.childSessionId, retried.runId!)
    )[0]?.actions?.continuationStart;
    expect(retryStart?.protocol).toBe('continuation_start_v2');
    expect(retryStart?.immediateSource.runId).toBe(repaired.runId);
    await expectRejects(
      manager.prepareChildAgentResume(parent.id, child.runId),
      /already has a successor/,
    );
    expect((await manager.prepareChildAgentResume(parent.id, retried.runId!)).execution).toEqual({
      kind: 'child_session',
      sessionId: child.childSessionId,
      currentRunId: retried.runId,
    });
    expect(
      (await store.readMessages(child.childSessionId)).filter(
        (message) => 'turnId' in message && message.turnId === retried.turnId,
      ),
    ).toEqual([]);
    expect((await manager.listChildAgents(parent.id)).executions[0]?.execution).toEqual({
      kind: 'child_session',
      sessionId: child.childSessionId,
      currentRunId: retried.runId,
    });

    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('linked retry exposes its hinted target Session before the first ledger read', async () => {
    const ledgerReadStarted = makeGate();
    const releaseLedgerRead = makeGate();
    let gateLedgerRead = false;
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({
      beforeRuntimeEventRead: async () => {
        if (!gateLedgerRead) return;
        gateLedgerRead = false;
        ledgerReadStarted.release();
        await releaseLedgerRead.promise;
      },
    });
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    const childInputs: BackendSendInput[] = [];
    backends.register('ai-sdk', (ctx) => {
      if (!ctx.header.subagentRuntime) return new TestBackend(ctx, parentGate);
      return {
        kind: 'fake' as const,
        sessionId: ctx.sessionId,
        async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
          childInputs.push(input);
          yield {
            type: 'error',
            id: `${input.turnId}-error`,
            turnId: input.turnId,
            ts: 1,
            recoverable: true,
            reason: 'RateLimit',
            message: 'provider 429',
          };
          yield {
            type: 'complete',
            id: `${input.turnId}-complete`,
            turnId: input.turnId,
            ts: 2,
            stopReason: 'error',
          };
        },
        async stop(): Promise<void> {},
        async respondToSandboxBoundary(): Promise<void> {},
        async dispose(): Promise<void> {},
      };
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      inspectContinuationSafety: async () => ({
        workspaceIdentity: '/tmp/cwd',
        backgroundOperationsSettled: true,
        availableToolNames: [],
      }),
      newId: nextId(),
      now: nextNow(155),
      runtimeSource: 'test',
    });
    const parent = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const parentTurn = manager
      .sendMessage(parent.id, { turnId: 'parent-linked-retry', text: 'keep parent active' })
      [Symbol.asyncIterator]();
    await parentTurn.next();
    const [parentRun] = await runStore.listSessionRuns(parent.id);
    if (!parentRun) throw new Error('parent run was not recorded');
    const child = await manager.spawnChildSession(parent.id, {
      spawnedBy: {
        parentRunId: parentRun.runId,
        parentTurnId: parentRun.turnId,
        toolCallId: 'target-stop-retry',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'fail once before target stop',
    });
    expect(child.status).toBe('failed');

    gateLedgerRead = true;
    const retried = manager.retryChildAgent(parent.id, {
      parentRunId: parentRun.runId,
      sourceRunId: child.runId,
      execution: {
        kind: 'child_session',
        sessionId: child.childSessionId,
        currentRunId: child.runId,
      },
    });
    await ledgerReadStarted.promise;
    let stopSettled = false;
    const stopping = manager
      .stopSession(child.childSessionId, { source: 'stop_button' })
      .finally(() => {
        stopSettled = true;
      });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseLedgerRead.release();
    const [result] = await Promise.all([retried, stopping]);
    expect(result.status).toBe('cancelled');
    expect(result.retriedFromRunId).toBe(child.runId);
    expect(childInputs).toHaveLength(1);
    const retryRun = (await runStore.listSessionRuns(child.childSessionId)).find(
      (run) => run.retriedFromRunId === child.runId,
    );
    expect(retryRun?.status).toBe('cancelled');
    expect((await store.readHeader(child.childSessionId)).status === 'blocked').toBe(false);

    await expectRejects(
      manager.retryChildAgent(parent.id, {
        parentRunId: parentRun.runId,
        sourceRunId: child.runId,
        execution: {
          kind: 'child_session',
          sessionId: child.childSessionId,
          currentRunId: 'stale-hinted-run',
        },
      }),
      /execution identity changed/,
    );
    await manager.stopSession(child.childSessionId, { source: 'stop_button' });

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
    expect((await manager.listChildSessions(parent.id)).length).toBe(1);

    childGate.release();
    const [firstResult, joinedResult] = await Promise.all([first, joined]);
    expect(joinedResult.childSessionId).toBe(firstResult.childSessionId);
    expect(joinedResult.runId).toBe(firstResult.runId);
    expect((await runStore.listSessionRuns(firstResult.childSessionId)).length).toBe(1);

    const durableRetry = await manager.spawnChildSession(parent.id, spawnInput);
    expect(durableRetry.childSessionId).toBe(firstResult.childSessionId);
    expect(durableRetry.runId).toBe(firstResult.runId);
    expect(durableRetry.summary).toBe('ok');
    expect((await manager.listChildSessions(parent.id)).length).toBe(1);
    expect(backendsBySession.get(firstResult.childSessionId)?.sendInputs.length).toBe(1);

    parentGate.release();
    while (!(await parentTurn.next()).done) {}
  });

  test('hosted linked-child gate precedes resume preparation and remains held through terminal', async () => {
    const store = new MemorySessionStore();
    const preparationEntered = makeGate();
    const allowPreparation = makeGate();
    let watchedRunId: string | undefined;
    let preparationReads = 0;
    const runStore = new MemoryAgentRunStore({
      beforeRuntimeEventRead: async (_sessionId, runId) => {
        if (runId !== watchedRunId) return;
        preparationReads += 1;
        preparationEntered.release();
        await allowPreparation.promise;
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
      now: nextNow(165),
      messageAuthority: hostedRootAuthority(),
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
        toolCallId: 'hosted-gate-cut',
      },
      agentProfile: LOCAL_READ_AGENT_PROFILE,
      prompt: 'inspect the gate cut',
    });

    watchedRunId = child.runId;
    const first = manager.resumeChildAgent(parent.id, {
      parentRunId: parentRun.runId,
      sourceRunId: child.runId,
      prompt: 'first successor',
    });
    await preparationEntered.promise;
    const second = manager.resumeChildAgent(parent.id, {
      parentRunId: parentRun.runId,
      sourceRunId: child.runId,
      prompt: 'stale second successor',
    });
    const outcomes = Promise.allSettled([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const readsBeforeRelease = preparationReads;
    allowPreparation.release();

    const [firstOutcome, secondOutcome] = await outcomes;
    expect(readsBeforeRelease).toBe(1);
    expect(firstOutcome.status).toBe('fulfilled');
    expect(secondOutcome.status).toBe('rejected');
    expect(secondOutcome.status === 'rejected' ? String(secondOutcome.reason) : '').toContain(
      'already has an active execution',
    );
    expect(
      (await runStore.listSessionRuns(child.childSessionId)).filter(
        (run) => run.resumedFromRunId === child.runId,
      ).length,
    ).toBe(1);

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
              permissionCeiling: 'ask',
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
    expect(resumed.childSessionId).toBe(metadataOnly.id);
    expect(resumed.runId).toBe('metadata-only-run');
    expect(readyCalls).toBe(1);
    expect((await runStore.listSessionRuns(metadataOnly.id)).length).toBe(1);

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
    expect(cancelledReadyCalls).toBe(0);
    expect(await runStore.listSessionRuns(cancelled.id)).toEqual([]);

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
      expect(refreshSettled).toBe(false);
      expect(contexts.filter((ctx) => ctx.sessionId === parent.id).length).toBe(1);
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
    expect(childContexts.length).toBe(2);
    expect(childContexts[1]?.systemPrompt).toBe(durablePrompt);
    expect(childContexts[1]?.tools?.map((tool) => tool.name)).toEqual(['Read', 'Glob', 'Grep']);

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
      runtimeSource: 'test',
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
      runtimeSource: 'test',
    });
    await drain(
      restarted.sendMessage(child.childSessionId, {
        turnId: 'child-follow-up',
        text: 'inspect it again after restart',
      }),
    );
    const restartedBackend = childBackends.at(-1);
    const followUpContext = restartedBackend?.sendInputs.at(-1)?.runtimeContext ?? [];
    expect(followUpContext.some((event) => event.runId === child.runId)).toBe(true);
    expect(
      followUpContext.some(
        (event) =>
          event.content?.kind === 'text' && event.content.text.includes('private parent context'),
      ),
    ).toBe(false);

    await drain(restarted.compactSession(child.childSessionId, { turnId: 'child-compact' }));
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]?.turnId).toBe('child-compact');

    const childMessages = await restarted.getMessages(child.childSessionId);
    expect(childMessages.some((message) => message.type === 'tool_call')).toBe(true);
    expect(childMessages.some((message) => message.type === 'tool_result')).toBe(true);
    expect(childMessages.some((message) => message.type === 'token_usage')).toBe(true);
    expect(
      childMessages.some(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'child-compact' &&
          message.status === 'completed',
      ),
    ).toBe(true);
    const parentMessages = await restarted.getMessages(parent.id);
    expect(
      parentMessages.some(
        (message) =>
          message.turnId === child.turnId ||
          message.turnId === 'child-follow-up' ||
          message.turnId === 'child-compact',
      ),
    ).toBe(false);

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
          permissionCeiling: 'ask',
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
    expect(recovered.childSessionId).toBe(child.id);
    expect(recovered.runId).toBe('stale-child-run');
    expect(recovered.status).toBe('failed');
    expect(recovered.failureClass).toBe('app_restarted');
    expect((await manager.listChildSessions(parent.id)).length).toBe(1);

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
    expect(await manager.listChildSessions(parent.id)).toEqual([]);
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

    expect(child.status).toBe('completed');
    expect(child.childSessionId === parent.id).toBe(false);
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
    expect(backendsBySession.get(childOneId)?.stopCalls).toBe(1);
    expect(backendsBySession.get(childTwoId)?.stopCalls).toBe(0);
    expect(backendsBySession.get(parent.id)?.stopCalls).toBe(0);
    expect((await runStore.readRun(parent.id, parentRun.runId)).status).toBe('running');

    await manager.stopSession(parent.id, { source: 'stop_button' });
    expect(backendsBySession.get(parent.id)?.stopCalls).toBe(1);
    expect(backendsBySession.get(childOneId)?.stopCalls).toBe(1);
    expect(backendsBySession.get(childTwoId)?.stopCalls).toBe(1);

    parentGate.release();
    for (const gate of childGates) gate.release();
    while (!(await parentTurn.next()).done) {}
    const [childOneResult, childTwoResult] = await Promise.all([childOne, childTwo]);
    expect(childOneResult.status).toBe('cancelled');
    expect(childTwoResult.status).toBe('cancelled');
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
          permissionCeiling: 'ask',
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

    expect(recovered).toEqual([child.id]);
    const recoveredRun = await runStore.readRun(child.id, 'child-run');
    expect(recoveredRun.parentRunId).toBe(undefined);
    expect(isSessionInlineRun(recoveredRun)).toBe(true);
    expect(recoveredRun.status).toBe('failed');
    expect(recoveredRun.failureClass).toBe('app_restarted');
    expect(
      (await store.readMessages(child.id)).some(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'child-turn' &&
          message.status === 'failed',
      ),
    ).toBe(true);
    expect(await store.readMessages(parent.id)).toEqual(parentMessagesBefore);
  });
});

describe('SessionManager automatic titles', () => {
  test('falls back once on generation failure', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const changed = makeGate();
    let calls = 0;
    const manager = new SessionManager({
      store,
      backends,
      newId: nextId(),
      now: nextNow(600),
      generateSessionTitle: async () => {
        calls += 1;
        throw new Error('offline');
      },
      onSessionTitleChanged: () => changed.release(),
    });
    const session = await manager.createSession(makeInput({ name: 'New Chat' }));

    await drain(
      manager.sendMessage(session.id, { turnId: 'first', text: '\nFallback title\nignored' }),
    );
    await changed.promise;
    await drain(manager.sendMessage(session.id, { turnId: 'second', text: 'second prompt' }));

    expect((await store.readHeader(session.id)).name).toBe('Fallback title');
    expect(calls).toBe(1);
  });

  test('does not overwrite or notify after a racing manual rename', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const release = makeGate();
    const attempted = makeGate();
    store.generatedTitleAttempted = attempted;
    let notifications = 0;
    const manager = new SessionManager({
      store,
      backends,
      newId: nextId(),
      now: nextNow(700),
      generateSessionTitle: async () => {
        await release.promise;
        return 'Generated loses';
      },
      onSessionTitleChanged: () => {
        notifications += 1;
      },
    });
    const session = await manager.createSession(makeInput({ name: 'New Chat' }));

    await drain(manager.sendMessage(session.id, { turnId: 'turn-race', text: 'hello' }));
    await manager.renameSession(session.id, 'Manual wins');
    release.release();
    await attempted.promise;

    expect((await store.readHeader(session.id)).name).toBe('Manual wins');
    expect(notifications).toBe(0);
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
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));
    runStore.operations = [];
    const events = await collectSessionEvents(
      manager.compactSession(session.id, { turnId: 'turn-compact' }),
    );

    expect(compactCalls).toEqual([{ turnId: 'turn-compact', runtimeContextCount: 3 }]);
    expect(events.map((event) => event.type)).toEqual(['token_usage', 'complete']);
    const usage = events[0];
    if (usage?.type !== 'token_usage') throw new Error('expected token_usage');
    expect(usage.contextBudget?.compactionDecisions?.[0]?.decision).toBe('replaced');

    const messages = await store.readMessages(session.id);
    expect(
      messages.some((message) => message.type === 'user' && message.text.includes('compact')),
    ).toBe(false);
    expect(
      messages.some(
        (message) => message.type === 'token_usage' && message.turnId === 'turn-compact',
      ),
    ).toBe(true);
    expect(
      messages.some(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'turn-compact' &&
          message.status === 'completed',
      ),
    ).toBe(true);

    const compactRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-compact',
    );
    expect(compactRun?.status).toBe('completed');
    expect(runStore.operations).toEqual(['terminalRuntimeEvent', 'completedRunHeader']);
    expect(
      (await runStore.readRuntimeEvents(session.id, compactRun!.runId)).some(
        (event) => event.actions?.tokenUsage?.contextBudget,
      ),
    ).toBe(true);
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
          maxHistoryEstimatedTokens: 10_000,
          minRecentTurns: 1,
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
    expect(warnings).toHaveLength(1);
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
    expect(stopSettled).toBe(false);
    expect(compactCalls).toEqual([]);

    readGate.release();
    await stop;
    const compactEvents = await compactPromise.catch(() => []);

    expect(compactCalls).toEqual([]);
    expect(compactEvents.some((event) => event.type === 'token_usage')).toBe(false);
    const compactRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-compact',
    );
    expect(compactRun?.status).toBe('cancelled');
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
    expect(cancelledEvents).toEqual([]);

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
    expect(cancelledRun?.status).toBe('cancelled');
    expect(abortErrorRun?.status).toBe('cancelled');
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
    expect(stopSettled).toBe(false);
    expect(compactCalls).toEqual([]);

    releaseRead.release();
    await stop;
    await compact.catch(() => []);

    expect(compactCalls).toEqual([]);
    const compactRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-compact-pending',
    );
    expect(compactRun?.status).toBe('cancelled');
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

    expect(compactingBackend?.stopCalls).toBe(1);
    expect(compactEvents.some((event) => event.type === 'token_usage')).toBe(false);
    const compactRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-compact',
    );
    expect(compactRun?.status).toBe('cancelled');
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
    expect(compactError instanceof RuntimeContextCompactError).toBe(true);
    expect((compactError as RuntimeContextCompactError).code).toBe('session_busy');

    expect(compactCalls).toEqual([]);
    const messages = await store.readMessages(session.id);
    expect(messages.some((message) => message.turnId === 'turn-compact')).toBe(false);
    const compactRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-compact',
    );
    expect(compactRun).toBeUndefined();

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
      configuration: baseConfiguration,
    });
    assert.equal(committed.revision, 2);
    assert.equal(committed.header.orchestrationMode, 'graph');
    assert.deepEqual(kernel.disposed, [session.id]);

    await assert.rejects(
      manager.transitionSessionConfiguration(session.id, {
        expectedRevision: 2,
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
        configuration: {
          backend: session.backend,
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
      configuration: {
        backend: session.backend,
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
    expect(refreshError instanceof Error).toBe(true);
    expect((refreshError as Error).message).toBe('injected delayed disposal failure');
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
    expect(strictSettled).toBe(false);

    releaseDispose.release();
    await bestEffort;
    const strict = await strictResult;

    expect(strict.ok).toBe(false);
    if (strict.ok) throw new Error('Strict refresh unexpectedly succeeded');
    expect(strict.error instanceof Error).toBe(true);
    expect((strict.error as Error).message).toBe('injected concurrent disposal failure');
    expect(disposeCalls).toBe(1);
  });

  test('backend refresh reports a retained child generation disposal failure', async () => {
    const store = new MemorySessionStore();
    let builds = 0;
    let disposeCalls = 0;
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new (class extends TestBackend {
          constructor() {
            super(ctx);
            builds += 1;
          }

          override async dispose(): Promise<void> {
            disposeCalls += 1;
            throw new Error('injected child generation disposal failure');
          }
        })(),
    );
    const newId = nextId();
    const now = nextNow(26_800);
    const childTools = [testTool('Read'), testTool('Glob'), testTool('Grep')];
    const runtimeKernel = new RuntimeKernel({
      store,
      backends,
      childTools,
      newId,
      now,
    });
    const manager = new SessionManager({
      store,
      backends,
      runtimeKernel,
      childTools,
      newId,
      now,
    });
    const session = await manager.createSession(makeInput());

    await drain(
      manager.startChildTurn(session.id, {
        turnId: 'child-disposal-failure',
        parentRunId: 'parent-run',
        spec: {
          id: LOCAL_READ_AGENT_ID,
          name: 'Researcher',
          systemPrompt: 'read only',
        },
        prompt: 'inspect',
      }),
    );

    await expectRejects(
      runtimeKernel.disposeBackend(session.id),
      /injected child generation disposal failure/,
    );
    await expectRejects(
      manager.refreshIdleBackends(),
      /injected child generation disposal failure/,
    );
    expect(builds).toBe(1);
    expect(disposeCalls).toBe(1);
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
    expect(builds).toBe(1);
    const mutation = runMutation(() => manager.refreshIdleBackends());

    releaseFirstDispose.release();
    await bestEffort;
    await replacementTurn;
    await mutation;

    expect(builds).toBe(2);
    expect(disposed).toEqual([1, 2]);
    await drain(manager.sendMessage(session.id, { turnId: 'turn-c', text: 'build C' }));
    expect(builds).toBe(3);
  });

  test('child backend activation waits for disposal and is covered by the later mutation', async () => {
    const store = new MemorySessionStore();
    const firstDisposeStarted = makeGate();
    const releaseFirstDispose = makeGate();
    const childPreBuildReached = makeGate();
    const releaseChildPreBuild = makeGate();
    let childCheckpointArmed = true;
    const runStore = new MemoryAgentRunStore({
      beforeRuntimeEventAppend: async (_sessionId, _runId, event) => {
        if (!childCheckpointArmed || event.turnId !== 'child-turn') return;
        childCheckpointArmed = false;
        childPreBuildReached.release();
        await releaseChildPreBuild.promise;
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
    const now = nextNow(26_900);
    const runtimeKernel = new RuntimeKernel({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId,
      now,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
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
    const childTurn = drain(
      manager.startChildTurn(session.id, {
        turnId: 'child-turn',
        parentRunId: 'parent-run',
        spec: {
          id: LOCAL_READ_AGENT_ID,
          name: 'Researcher',
          systemPrompt: 'read only',
        },
        prompt: 'inspect',
      }),
    );
    await childPreBuildReached.promise;
    releaseChildPreBuild.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(builds).toBe(1);
    const mutation = runMutation(() => manager.refreshIdleBackends());

    releaseFirstDispose.release();
    await bestEffort;
    await childTurn;
    await mutation;

    expect(builds).toBe(2);
    expect(disposed).toEqual([1, 2]);
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

    expect(disposed).toEqual([cached.id]);
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

    expect(calls).toEqual([`terminate:${session.id}`, 'commit', `resume:${session.id}`]);
    const boundary = await store.readExecutionBoundary(session.id);
    expect(boundary.kind).toBe('managed');
    if (boundary.kind === 'managed') expect(boundary.profile.name).toBe('read-only');
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

    expect(calls).toEqual([
      `terminate:${session.id}`,
      `terminate:${child.id}`,
      `terminate:${grandchild.id}`,
      'commit',
      'commit',
      'commit',
      `resume:${session.id}`,
    ]);
    expect(store.disposeCount).toBe(3);
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
    expect((await store.readHeader(session.id)).status).toBe('running');
    const afterFirstRuns = await runStore.listSessionRuns(session.id);
    expect(afterFirstRuns.find((run) => run.turnId === 'turn-1')?.status).toBe('completed');
    expect(afterFirstRuns.find((run) => run.turnId === 'turn-2')?.status).toBe('running');

    await expectRejects(manager.setPermissionMode(session.id, 'execute'), /当前任务正在运行/);

    secondGate.release();
    await second.next();
    await second.next();
    expect((await store.readHeader(session.id)).status).toBe('active');
    const finalRuns = await runStore.listSessionRuns(session.id);
    expect(finalRuns.map((run) => [run.turnId, run.status])).toEqual([
      ['turn-1', 'completed'],
      ['turn-2', 'completed'],
    ]);
    const firstEvents = await runStore.readEvents(session.id, finalRuns[0]!.runId);
    expect(firstEvents.map((event) => event.type)).toContain('run_created');
    expect(firstEvents.map((event) => event.type)).toContain('run_started');
    expect(firstEvents.map((event) => event.type)).toContain('run_completed');

    const summary = await manager.setPermissionMode(session.id, 'execute');
    expect(summary.permissionMode).toBe('execute');
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

    expect(summary.permissionMode).toBe('ask');
    expect(summary.labels).toEqual(['kept']);
    expect((await store.readHeader(session.id)).labels).toEqual(['kept']);

    const messages = await store.readMessages(session.id);
    const modeNote = messages.find(
      (message) => message.type === 'system_note' && message.kind === 'mode_change',
    );
    if (modeNote?.type !== 'system_note') throw new Error('mode_change note was not written');
    expect(modeNote.data).toEqual({ from: 'explore', to: 'ask' });
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
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    const events = await collectSessionEvents(
      manager.sendMessage(session.id, {
        turnId: 'turn-workspace-identity-unavailable',
        text: 'continue without resumability',
      }),
    );

    expect(events.map((event) => event.type)).toEqual(['text_complete', 'complete']);
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.workspaceIdentity).toBeUndefined();
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
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await collectSessionEvents(
      manager.sendMessage(session.id, {
        turnId: 'turn-resume-disabled',
        text: 'normal happy path',
      }),
    );

    expect(inspectionCalls).toBe(0);
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.workspaceIdentity).toBeUndefined();
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
      runtimeSource: 'test',
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
    expect(events[0]?.actions?.runtimeProtocol).toEqual({
      toolBoundary: 't1_after_preflight_v1',
    });
  });

  test('plans continuation from authoritative host facts without caller-supplied safety claims', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
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
      runtimeSource: 'test',
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

    expect(plan.disposition).toBe('continue');
    expect(plan.continuation?.safetySnapshot).toEqual({
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

    expect(plan.disposition).toBe('park');
    expect(plan.rejectionReasons).toEqual(['safety_observation_unavailable']);
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

    expect(plan.disposition).toBe('park');
    expect(plan.rejectionReasons).toEqual(['resume_feature_disabled']);
    expect(lifecycleEvents).toEqual([
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

    expect(plan.disposition).toBe('continue');
    expect(plan.continuation?.sourceRunId).toBe('source-run-newer');
  });

  test('RuntimeKernel drives RuntimeRunner while preserving the SessionEvent stream', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const runtimeEventStore = new MemoryRuntimeEventStore();
    const backends = new BackendRegistry();
    const observed: InvocationResult[] = [];
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
      runtimeSource: 'test',
      runtimeInvocationObserver: (result) => {
        observed.push(result);
      },
    });
    const session = await manager.createSession(makeInput());

    const sessionEvents = await collectSessionEvents(
      manager.sendMessage(session.id, {
        turnId: 'turn-1',
        text: 'hello',
        toolMode: 'code_mode',
      }),
    );

    expect(sessionEvents.map((event) => event.type)).toEqual(['text_complete', 'complete']);
    expect(sessionEvents.map((event) => event.id)).toEqual(['turn-1-final', 'turn-1-complete']);
    expect(backend?.sendInputs[0]?.toolMode).toBe('code_mode');
    expect(observed.length).toBe(1);

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('AgentRunStore run was not created');
    const result = observed[0]!;
    expect(result.runId).toBe(run.runId);
    expect(result.sessionId).toBe(session.id);
    expect(result.turnId).toBe('turn-1');
    expect(result.status).toBe('completed');
    expect(result.finalOutput).toBe('ok');
    expect(result.events.map((event) => event.runId)).toEqual([run.runId, run.runId, run.runId]);
    expect(result.events.map((event) => event.sessionId)).toEqual([
      session.id,
      session.id,
      session.id,
    ]);
    expect(result.events.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1', 'turn-1']);
    expect(result.events.map((event) => event.role)).toEqual(['user', 'model', 'system']);
    expect(result.events[0]?.content).toEqual({ kind: 'text', text: 'hello' });
    expect(result.events[1]?.content).toEqual({ kind: 'text', text: 'ok' });
    expect(result.events[2]?.status).toBe('completed');

    const runtimeEvents = await runtimeEventStore.readRuntimeEvents(session.id, run.runId);
    expect(runtimeEvents.map((event) => event.id)).toEqual(result.events.map((event) => event.id));
    expect(runtimeEvents.map((event) => event.runId)).toEqual([run.runId, run.runId, run.runId]);
    expect(runtimeEvents.map((event) => event.sessionId)).toEqual([
      session.id,
      session.id,
      session.id,
    ]);
    expect(runtimeEvents.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1', 'turn-1']);
    expect(runtimeEvents.map((event) => event.role)).toEqual(['user', 'model', 'system']);
    expect(runtimeEvents[0]?.content).toEqual({ kind: 'text', text: 'hello' });
    expect(runtimeEvents[1]?.content).toEqual({ kind: 'text', text: 'ok' });
    expect(runtimeEvents[2]?.status).toBe('completed');
  });

  test('executes an approved continuation after a path move without another user message', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const lifecycleEvents: Array<{ type: string }> = [];
    let backend: FinalTextTestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new FinalTextTestBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      toolBoundaryProtocol: 't1_after_preflight_v1',
      backends,
      inspectContinuationSafety: inspectStableContinuationSafety,
      onContinuationLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
      newId: nextId(),
      now: nextNow(6_550),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
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
        id: 'source-terminal',
        sessionId: session.id,
        invocationId: sourceInvocationId,
        runId: sourceRunId,
        turnId: sourceTurnId,
        ts: 2,
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
      availableToolNames: [],
    });
    expect(plan.disposition).toBe('continue');
    if (!plan.continuation) throw new Error('expected continuation');

    const movedCwd = '/fresh-sandbox/repo';
    await store.updateHeader(session.id, { cwd: movedCwd });
    const sessionEvents = await collectSessionEvents(
      manager.resumeSafeBoundaryContinuation(plan.continuation),
    );

    expect(sessionEvents.map((event) => event.type)).toEqual(['text_complete', 'complete']);
    const continuationRun = await runStore.readRun(session.id, plan.continuation.runId);
    expect(continuationRun.invocationId).toBe(plan.continuation.invocationId);
    expect(continuationRun.turnId).toBe(plan.continuation.turnId);
    expect(continuationRun.parentRunId).toBe(sourceRunId);
    expect(continuationRun.parentTurnId).toBe(sourceTurnId);
    expect(continuationRun.cwd).toBe(movedCwd);
    expect(continuationRun.status).toBe('completed');
    expect(continuationRun).toMatchObject({
      orchestrationMode: 'swarm',
      orchestrationSource: 'turn_override',
      agentSwarmAuthorization: 'turn_override',
      toolMode: 'code_mode',
    });
    expect(backend?.sendInputs[0]?.toolMode).toBe('code_mode');
    const continuationEvents = await runStore.readRuntimeEvents(
      session.id,
      plan.continuation.runId,
    );
    expect(continuationEvents[0]?.actions?.continuationStart).toMatchObject({
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
      providerProjectionVersion: 1,
      providerReplayDigest: plan.continuation.providerReplayDigest,
    });
    expect(continuationEvents[0]?.actions?.runtimeProtocol).toEqual({
      toolBoundary: 't1_after_preflight_v1',
    });
    expect(continuationEvents[0]?.refs).toBe(undefined);
    expect(continuationEvents.some((event) => event.role === 'user')).toBe(false);
    expect((await store.readMessages(session.id)).some((message) => message.type === 'user')).toBe(
      false,
    );
    expect(await runStore.readRuntimeEvents(session.id, sourceRunId)).toEqual(sourceEvents);
    expect(lifecycleEvents.map((event) => event.type)).toEqual([
      'plan_approved',
      'execution_started',
      'execution_completed',
    ]);

    await collectSessionEvents(
      manager.sendMessage(session.id, {
        turnId: 'turn-after-continuation',
        text: 'what happened after recovery?',
      }),
    );
    const followUpContext = backend?.sendInputs.at(-1)?.runtimeContext ?? [];
    expect(followUpContext.some((event) => event.runId === plan.continuation?.runId)).toBe(true);
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
      runtimeSource: 'test',
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
    expect(refreshSettled).toBe(false);
    await manager.stopSession(session.id, { source: 'stop_button' });
    sendGate.release();
    await execution;
    await refresh;
    expect(store.disposeCount).toBe(1);

    const cachedMessages = await store.readMessages(session.id);
    expect(
      cachedMessages
        .filter(
          (message) =>
            message.type === 'turn_state' && message.turnId === plan.continuation?.turnId,
        )
        .at(-1),
    ).toMatchObject({
      type: 'turn_state',
      status: 'aborted',
      abortSource: 'renderer.stop_button',
      parentTurnId: sourceTurnId,
    });
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
      runtimeSource: 'test',
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

    expect(repeatedPlan.disposition).toBe('park');
    expect(repeatedPlan.rejectionReasons).toEqual(['continuation_already_exists']);

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
    expect(targetIdentityMismatch.rejectionReasons).toEqual(['continuation_claim_repair_required']);

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
    expect(targetTerminalMismatch.rejectionReasons).toEqual(['continuation_claim_repair_required']);

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
    expect(postTerminalMismatch.rejectionReasons).toEqual(['continuation_claim_repair_required']);
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
      runtimeSource: 'test',
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
      runtimeSource: 'test',
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

    expect(backendCalls).toBe(1);
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
      runtimeSource: 'test',
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

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(backendCalls).toBe(1);
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
      runtimeSource: 'test',
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

    expect(backendCalls).toBe(0);
    const targetRun = await runStore.readRun(session.id, plan.continuation.runId);
    expect(['created', 'running'].includes(targetRun.status)).toBe(true);
    expect(targetRun.completedAt).toBeUndefined();
    expect(await runStore.readRuntimeEvents(session.id, plan.continuation.runId)).toEqual([]);

    await manager.recoverInterruptedSessions();

    const recoveredRun = await runStore.readRun(session.id, plan.continuation.runId);
    const recoveredEvents = await runStore.readRuntimeEvents(session.id, plan.continuation.runId);
    expect(recoveredRun.status).toBe('failed');
    expect(recoveredRun.failureClass).toBe('continuation_abandoned_before_provider_dispatch');
    expect(recoveredEvents).toHaveLength(2);
    expect(recoveredEvents[0]?.actions?.continuationStart?.claimId).toBe(plan.continuation.claimId);
    expect(recoveredEvents.filter(isTerminalRuntimeEvent)).toHaveLength(1);
    expect(recoveredEvents.at(-1)?.actions?.stateDelta).toMatchObject({
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
      runtimeSource: 'test',
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

    expect(backendCalls).toBe(0);
    const targetRun = await runStore.readRun(session.id, plan.continuation.runId);
    expect(targetRun.status).toBe('cancelled');
    const targetEvents = await runStore.readRuntimeEvents(session.id, plan.continuation.runId);
    expect(
      targetEvents.filter((event) => event.actions?.continuationStart !== undefined),
    ).toHaveLength(1);
    expect(targetEvents.filter(isTerminalRuntimeEvent)).toHaveLength(1);
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
      runtimeSource: 'test',
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

    expect(backendCalls).toBe(0);
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
      runtimeSource: 'test',
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
    expect(backendCalls).toBe(0);
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
      runtimeSource: 'test',
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
    expect(backendCalls).toBe(0);

    expect(await manager.recoverInterruptedSessions()).not.toContain(session.id);
    const durableRepairEvents = await runStore.readRuntimeEvents(
      session.id,
      plan.continuation.runId,
    );
    expect(durableRepairEvents).toHaveLength(2);
    expect(durableRepairEvents.filter(isTerminalRuntimeEvent)).toHaveLength(1);
    expect((await runStore.readRun(session.id, plan.continuation.runId)).status).toBe('created');

    expect(await manager.recoverInterruptedSessions()).toContain(session.id);
    const repairedRun = await runStore.readRun(session.id, plan.continuation.runId);
    expect(repairedRun.status).toBe('failed');
    expect(repairedRun.failureClass).toBe('continuation_abandoned_before_provider_dispatch');
    expect(
      repairedRun.continuationSource && 'protocol' in repairedRun.continuationSource
        ? repairedRun.continuationSource.protocol
        : undefined,
    ).toBe('continuation_source_v2');
    expect(
      repairedRun.continuationSource && 'claimId' in repairedRun.continuationSource
        ? repairedRun.continuationSource.claimId
        : undefined,
    ).toBe(plan.continuation.claimId);
    const repairedEvents = await runStore.readRuntimeEvents(session.id, plan.continuation.runId);
    expect(repairedEvents).toHaveLength(2);
    expect(repairedEvents[0]?.actions?.continuationStart?.claimId).toBe(plan.continuation.claimId);
    expect(repairedEvents[1]?.status).toBe('failed');
    expect(backendCalls).toBe(0);

    const snapshot = JSON.stringify({
      run: repairedRun,
      events: repairedEvents,
    });
    await manager.recoverInterruptedSessions();
    expect(
      JSON.stringify({
        run: await runStore.readRun(session.id, plan.continuation.runId),
        events: await runStore.readRuntimeEvents(session.id, plan.continuation.runId),
      }),
    ).toBe(snapshot);
    expect(backendCalls).toBe(0);

    const nextPlan = await manager.planSafeBoundaryContinuation(session.id, {
      sourceRunId: plan.continuation.runId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    });
    expect(nextPlan.disposition).toBe('continue');
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
      runtimeSource: 'test',
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
    expect(backendCalls).toBe(0);
    expect(lifecycleEvents.at(-1)).toEqual({
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
        runtimeSource: 'test',
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
      expect(backendCalls).toBe(0);
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
      runtimeSource: 'test',
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
      runtimeSource: 'test',
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

    expect(backendCalls).toBe(0);
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
      runtimeSource: 'test',
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
    expect(backendCalls).toBe(0);
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
      runtimeSource: 'test',
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
      runtimeSource: 'test',
    });
    const sessionEvents = await collectSessionEvents(
      restarted.sendMessage(session.id, { turnId: 'turn-2', text: 'follow up' }),
    );

    expect(sessionEvents.map((event) => event.type)).toEqual(['text_delta', 'complete']);
    expect(backend?.sendInputs[0]?.context.map((message) => message.type)).toEqual([
      'user',
      'assistant',
      'token_usage',
      'turn_state',
    ]);
    expect(
      backend?.sendInputs[0]?.context.map((message) =>
        'text' in message ? message.text : message.type,
      ),
    ).toEqual(['prior question', 'prior answer', 'token_usage', 'turn_state']);
    expect(backend?.sendInputs[0]?.runtimeContext?.map((event) => event.runId)).toEqual([
      'run-1',
      'run-1',
      'run-1',
      'run-1',
    ]);
    const resumedUsage = backend?.sendInputs[0]?.runtimeContext?.find(
      (event) => event.actions?.tokenUsage,
    );
    expect(resumedUsage?.actions?.tokenUsage?.runtimeSteps).toBe(3);
    expect(resumedUsage?.actions?.tokenUsage?.contextRemaining).toBe(9000);
    expect(resumedUsage?.refs?.providerRequestTraceId).toBe('provider-trace-1');
    const repairedRuntimeEvents = await runStore.readRuntimeEvents(session.id, 'run-1');
    expect(repairedRuntimeEvents.map((event) => event.refs?.storedMessageId)).toEqual([
      'legacy-user',
      'legacy-assistant',
      'legacy-usage',
      'legacy-state',
    ]);
    expect(repairedRuntimeEvents.at(-1)?.status).toBe('completed');
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
      runtimeSource: 'test',
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

    expect(
      backend?.sendInputs[0]?.runtimeContext?.flatMap((event) =>
        event.content?.kind === 'text' ? [event.content.text] : [],
      ),
    ).toEqual([
      'First question',
      'First answer',
      'Second question',
      'Second answer',
      'Native question',
      'Native answer',
    ]);
    expect((await store.readHeader(session.id)).transcriptLedgerVersion).toBe(1);
    const repairedRuns = await runStore.listSessionRuns(session.id);
    expect(repairedRuns.filter((run) => run.turnId === 'turn-1')).toHaveLength(1);
    expect(repairedRuns.filter((run) => run.turnId === 'turn-2')).toHaveLength(1);
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
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    await store.updateHeader(session.id, { transcriptLedgerVersion: 0 });

    await expectRejects(
      drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'Too early' })),
      /history is still being prepared/,
    );

    expect(await runStore.listSessionRuns(session.id)).toHaveLength(0);
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
      runtimeSource: 'test',
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
    expect(backend?.sendInputs.length ?? 0).toBe(0);
    const currentRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-2',
    );
    if (!currentRun) throw new Error('current AgentRunStore run was not created');
    expect(currentRun.status).toBe('failed');
    expect(currentRun.failureClass).toBe('missing_terminal_event');
    const currentTerminalEvents = (
      await runStore.readRuntimeEvents(session.id, currentRun.runId)
    ).filter(isTerminalRuntimeEvent);
    expect(currentTerminalEvents).toHaveLength(1);
    expect(currentTerminalEvents[0]?.status).toBe('failed');
    expect(currentTerminalEvents[0]?.actions?.stateDelta?.failureClass).toBe(
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
      runtimeSource: 'test',
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

    expect(backend?.sendInputs[0]?.runtimeContext?.map((event) => event.id)).toEqual([
      'rt-user',
      'rt-assistant',
    ]);
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

    expect(view.messages).toEqual(seeded.projectedMessages);
    expect(view.turns).toEqual([
      {
        turnId: 'turn-1',
        status: 'completed',
        statusSource: 'recorded',
        partialOutputRetained: true,
      },
    ]);
    expect(view.terminalFacts.map((fact) => fact.runStatus)).toEqual(['completed']);
    expect(view.replayPlan.textMessages.map((message) => message.content)).toEqual([
      'runtime question',
      'runtime answer',
    ]);
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

    expect(messages.find((message) => message.type === 'permission_decision')).toEqual({
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
    });

    const cachedView = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
      projectionCache: {
        readMessages: async () =>
          messages.filter((message) => message.type !== 'permission_decision'),
      },
      canonicalPermissionOutcomes,
    }).getSessionView(header.sessionId);

    expect(cachedView.diagnostics).toEqual([]);
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

    expect(messages.find((message) => message.type === 'permission_decision')).toEqual({
      type: 'permission_decision',
      id: 'request-canonical',
      turnId: header.turnId,
      ts: 125,
      toolUseId: 'tool-canonical',
      toolName: 'Write',
      decision: 'allow',
      rememberForTurn: true,
      reviewer: 'auto_review',
    });
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
    expect(startedReads).toBe(8);
    expect(maxActiveReads).toBe(8);
    releaseReads();
    const view = await viewPromise;

    expect(startedReads).toBe(requestIds.length);
    expect(maxActiveReads).toBe(8);
    expect(view.messages.filter((message) => message.type === 'permission_decision').length).toBe(
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

    expect(view.runs.map((run) => run.runId)).toEqual(['parent-run']);
    expect(view.messages.map((message) => message.turnId)).toEqual([
      'parent-turn',
      'parent-turn',
      'parent-turn',
    ]);
    expect(view.replayPlan.textMessages.map((message) => message.content)).toEqual([
      'parent question',
      'parent answer',
    ]);
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

    expect(await manager.getMessages(session.id)).toEqual([
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

    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant', 'turn_state']);
    expect(messages.at(-1)).toEqual({
      type: 'turn_state',
      id: 'legacy-state',
      turnId: 'turn-1',
      ts: 103,
      status: 'completed',
      partialOutputRetained: true,
    });
    expect(runtimeEvents.slice(0, 2).map((event) => event.id)).toEqual(['rt-user', 'rt-assistant']);
    expect(runtimeEvents.at(-1)?.status).toBe('completed');
    expect(runtimeEvents.at(-1)?.refs?.storedMessageId).toBe('legacy-state');
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
    expect(
      cachedMessages.find(
        (message) => message.type === 'turn_state' && message.turnId === 'repair-continuation-turn',
      ),
    ).toMatchObject({
      type: 'turn_state',
      status: 'failed',
      errorClass: 'missing_terminal_event',
      parentTurnId: sourceTurnId,
      partialOutputRetained: false,
    });
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

    expect(repairedRun.status).toBe('failed');
    expect(repairedRun.failureClass).toBe('missing_terminal_event');
    expect(messages.at(-1)?.type).toBe('turn_state');
    expect(runtimeEvents.filter((event) => event.status === 'failed')).toHaveLength(1);
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

    expect(repairedRun.failureClass).toBe('tool_failed');
    expect(messages.at(-1)).toEqual({
      type: 'turn_state',
      id: 'rt-failed',
      turnId: 'turn-1',
      ts: 103,
      status: 'failed',
      errorClass: 'tool_failed',
      partialOutputRetained: true,
    });
    expect(runtimeEvents.filter((event) => event.status === 'failed')).toHaveLength(1);
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

    expect(repairedRun.failureClass).toBe('missing_terminal_event');
    expect(runtimeEvents.filter((event) => event.status === 'failed')).toHaveLength(1);
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
    expect(runtimeEvents.filter((event) => event.status === 'failed')).toHaveLength(1);
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

    expect(assistantTexts).toContain('the resumed article');
    expect(assistantTexts).not.toContain('private child output');
    expect(messages.some((message) => message.id === 'continuation-start')).toBe(false);
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
    expect(messages).toEqual([...completed.projectedMessages, ...activeMessages]);
    expect(await manager.listTurns(session.id)).toEqual([
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
    expect(
      view.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'incomplete_event' &&
          diagnostic.message.includes('in-flight projection cache'),
      ),
    ).toBe(true);
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

    expect(
      (await manager.getMessages(session.id)).find(
        (message) => message.type === 'permission_decision',
      ),
    ).toMatchObject({
      type: 'permission_decision',
      id: 'request-canonical',
      turnId: header.turnId,
      toolUseId: 'tool-canonical',
      decision: 'allow',
      reviewer: 'auto_review',
    });
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
    expect(
      view.events.flatMap((event) =>
        readRequestId(event.actions?.stateDelta?.sandboxBoundaryRequest),
      ),
    ).toEqual(['boundary-pending']);
    expect(
      view.events.flatMap((event) =>
        readRequestId(event.actions?.stateDelta?.sandboxBoundaryDecision),
      ),
    ).toEqual(['boundary-pending']);
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
      data: { from: 'ask', to: 'execute' },
    };
    await store.appendMessage(session.id, legacyNote);

    const messages = await manager.getMessages(session.id);

    expect(messages).toEqual(seeded.projectedMessages);
  });

  test('getMessages orders RuntimeEvent-primary reads by session event chronology across runs', async () => {
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

    expect(
      messages.map(
        (message) =>
          `${message.type}:${'turnId' in message ? message.turnId : 'none'}:${message.ts}`,
      ),
    ).toEqual([
      'user:slow:101',
      'user:fast:103',
      'assistant:fast:104',
      'turn_state:fast:105',
      'assistant:slow:106',
      'turn_state:slow:107',
    ]);
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
    expect(regenUser?.type === 'user' ? regenUser.text : undefined).toBe('runtime regenerate text');
    const regenState = deriveTurnRecords(messages).find((turn) => turn.turnId === 'regen-1');
    expect(regenState?.regeneratedFromTurnId).toBe('source');
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
    expect(stopSettled).toBe(false);

    releasePreflight.release();
    await stopping;
    expect((await firstEvent).done).toBe(true);
    expect(backend?.sendInputs).toEqual([]);
    const regenerated = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'regen-stopped-preflight',
    );
    expect(regenerated?.status).toBe('cancelled');
    expect((await store.readHeader(session.id)).status === 'blocked').toBe(false);
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
    expect(regenUser?.type === 'user' ? regenUser.text : undefined).toBe('aborted turn text');
  });

  test('branchFromTurn copies through the RuntimeEvent-primary message boundary', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput({ name: 'Parent' }));
    await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'source',
      runId: 'source-run',
      userText: 'runtime branch context',
      assistantText: 'runtime branch answer',
      legacyIdPrefix: 'legacy',
    });
    store.failNextReadMessagesFor.set(session.id, 1);

    const child = await manager.branchFromTurn(session.id, {
      sourceTurnId: 'source',
      name: 'Child',
    });

    const childMessages = await store.readMessages(child.id);
    expect(childMessages[0]).toMatchObject({
      type: 'user',
      turnId: 'source',
      text: 'runtime branch context',
    });
    expect(childMessages[1]).toMatchObject({
      type: 'assistant',
      turnId: 'source',
      text: 'runtime branch answer',
    });
    expect(childMessages[2]).toMatchObject({ type: 'system_note', kind: 'session_start' });
    expect(childMessages.some((message) => message.type === 'turn_state')).toBe(false);

    const runtimeMessages = await manager.getMessages(child.id);
    expect(runtimeMessages[0]).toMatchObject({
      type: 'user',
      turnId: 'source',
      text: 'runtime branch context',
    });
    expect(runtimeMessages[1]).toMatchObject({
      type: 'assistant',
      turnId: 'source',
      text: 'runtime branch answer',
    });
  });

  test('conversation copies materialize requestless hosted permission history', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const backendInstances: TestBackend[] = [];
    backends.register('ai-sdk', (ctx) => {
      const backend = new TestBackend(ctx);
      backendInstances.push(backend);
      return backend;
    });
    const session = await store.create(makeInput({ name: 'Parent' }));
    const header = makeRunHeader({
      sessionId: session.id,
      runId: 'source-run',
      turnId: 'source',
      status: 'completed',
      createdAt: 100,
      updatedAt: 130,
      completedAt: 130,
    });
    await seedCanonicalPermissionRun(runStore, header, false);
    const sourcePermissionEvents = await runStore.readRuntimeEvents(session.id, header.runId);
    expect(sourcePermissionEvents.some((event) => event.actions?.permissionRequest)).toBe(false);
    expect(sourcePermissionEvents.some((event) => event.content?.kind === 'function_call')).toBe(
      false,
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'later-run',
        turnId: 'later',
        status: 'completed',
        createdAt: 140,
        updatedAt: 141,
        completedAt: 141,
      }),
      [
        runtimeEvent({
          id: 'later-user',
          sessionId: session.id,
          runId: 'later-run',
          turnId: 'later',
          ts: 140,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'replace this turn' },
        }),
        runtimeEvent({
          id: 'later-terminal',
          sessionId: session.id,
          runId: 'later-run',
          turnId: 'later',
          ts: 141,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    let sourceInteractionAvailable = true;
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(6_755),
      interactionAuthority: testInteractionAuthority(),
      canonicalPermissionOutcomes: {
        readPermissionOutcome: async () =>
          sourceInteractionAvailable ? canonicalPermissionRecord(header) : undefined,
      },
    });

    const child = await manager.branchFromTurn(session.id, {
      sourceTurnId: header.turnId,
      name: 'Child',
    });
    const revision = await manager.reviseBeforeTurn(session.id, { sourceTurnId: 'later' });
    sourceInteractionAvailable = false;

    const [childSourceRun] = await runStore.listSessionRuns(child.id);
    const childSourceEvents = childSourceRun
      ? await runStore.readRuntimeEvents(child.id, childSourceRun.runId)
      : [];
    expect(
      childSourceEvents.find((event) => event.actions?.permissionDecision)?.actions
        ?.permissionDecision,
    ).toMatchObject({
      requestId: 'request-canonical',
      toolName: 'Write',
      decision: 'deny',
    });
    expect(childSourceEvents.some((event) => event.actions?.permissionRequest)).toBe(false);
    expect(childSourceEvents.some((event) => event.actions?.permissionAnswerAccepted)).toBe(false);

    for (const copiedSession of [child, revision]) {
      expect(
        (await manager.getMessages(copiedSession.id)).find(
          (message) => message.type === 'permission_decision',
        ),
      ).toMatchObject({
        type: 'permission_decision',
        id: 'request-canonical',
        turnId: header.turnId,
        toolUseId: 'tool-canonical',
        toolName: 'Write',
        decision: 'deny',
        reviewer: 'user',
      });
    }

    await drain(manager.sendMessage(child.id, { turnId: 'child-next', text: 'continue' }));
    expect(
      backendInstances
        .find((backend) => backend.sessionId === child.id)
        ?.sendInputs[0]?.context.find((message) => message.type === 'permission_decision'),
    ).toMatchObject({
      id: 'request-canonical',
      toolUseId: 'tool-canonical',
      toolName: 'Write',
      decision: 'deny',
    });
  });

  test('branch child next turn receives cloned RuntimeEvent context', async () => {
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
      now: nextNow(6_870),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ name: 'Parent' }));

    await drain(manager.sendMessage(session.id, { turnId: 'source', text: 'branch seed' }));
    const child = await manager.branchFromTurn(session.id, {
      sourceTurnId: 'source',
      name: 'Child',
    });
    await store.appendMessage(child.id, {
      type: 'assistant',
      id: 'child-cache-only',
      turnId: 'cache-only',
      ts: 6_999,
      text: 'cache-only child context',
      modelId: 'fake-model',
    });

    await drain(manager.sendMessage(child.id, { turnId: 'child-next', text: 'child follow-up' }));

    const childInput = backendInstances[1]?.sendInputs[0];
    if (!childInput) throw new Error('child backend input was not recorded');
    expect(
      childInput.context.some(
        (message) =>
          message.type === 'user' && message.turnId === 'source' && message.text === 'branch seed',
      ),
    ).toBe(true);
    expect(
      childInput.context.some(
        (message) => message.type === 'assistant' && message.id === 'child-cache-only',
      ),
    ).toBe(false);
    expect(childInput.runtimeContext?.map((event) => event.turnId)).toEqual([
      'source',
      'source',
      'source',
    ]);
    expect(childInput.runtimeContext?.[0]?.sessionId).toBe(child.id);
  });

  test('branchFromTurn removes an incomplete target when Runtime ledger copy fails', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failRuntimeEventAppendAfter: 5 });
    const manager = makeManagerForReadCutover(store, runStore);
    const session = await manager.createSession(makeInput({ name: 'Parent' }));
    await seedRuntimeReadTurn({
      store,
      runStore,
      sessionId: session.id,
      turnId: 'source',
      runId: 'source-run',
      userText: 'runtime branch context',
      assistantText: 'runtime branch answer',
      legacyIdPrefix: 'legacy',
    });

    let branchError: unknown;
    try {
      await manager.branchFromTurn(session.id, { sourceTurnId: 'source', name: 'Child' });
    } catch (error) {
      branchError = error;
    }
    expect(branchError instanceof Error ? branchError.message : String(branchError)).toContain(
      'runtime event append failed',
    );

    const child = (await store.list()).find((summary) => summary.parentSessionId === session.id);
    expect(child).toBeUndefined();
    const childRuns = await runStore.listSessionRuns('session-2');
    for (const run of childRuns) {
      const runtimeEvents = await runStore.readRuntimeEvents('session-2', run.runId);
      const hasTerminalFact = runtimeEvents.some(isTerminalRuntimeEvent);
      expect(
        run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
          ? hasTerminalFact
          : true,
      ).toBe(true);
    }
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

    expect(turns.find((turn) => turn.turnId === 'retry')).toMatchObject({
      status: 'completed',
      parentTurnId: 'root',
      retriedFromTurnId: 'root',
    });
    expect(turns.find((turn) => turn.turnId === 'regen')).toMatchObject({
      status: 'completed',
      parentTurnId: 'root',
      regeneratedFromTurnId: 'root',
    });
    expect(turns.find((turn) => turn.turnId === 'branch')).toMatchObject({
      status: 'completed',
      parentSessionId: 'parent-session',
      branchOfTurnId: 'root',
    });
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
      runtimeSource: 'test',
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
    expect(secondInput.runtimeContext?.map((event) => event.turnId)).toEqual([
      'turn-1',
      'turn-1',
      'turn-1',
    ]);
    const turnState = secondInput.context.find(
      (message) => message.type === 'turn_state' && message.turnId === 'turn-1',
    );
    if (turnState?.type !== 'turn_state')
      throw new Error('prior failed turn_state was not projected');
    expect(turnState.status).toBe('failed');
    expect(turnState.errorClass).toBe('tool_failed');
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
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'first' }));
    const [firstRun] = await runStore.listSessionRuns(session.id);
    if (!firstRun) throw new Error('first run was not recorded');
    expect(firstRun.status).toBe('running');
    const firstRuntimeEvents = await runStore.readRuntimeEvents(session.id, firstRun.runId);
    const firstTerminalEvents = firstRuntimeEvents.filter(isTerminalRuntimeEvent);
    expect(firstTerminalEvents).toHaveLength(1);
    expect(firstTerminalEvents[0]?.status).toBe('failed');
    expect(firstTerminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('runtime_error');

    await drain(manager.sendMessage(session.id, { turnId: 'turn-2', text: 'second' }));

    const secondInput = backend?.sendInputs[1];
    if (!secondInput) throw new Error('second backend input was not recorded');
    expect(secondInput.runtimeContext?.map((event) => event.turnId)).toEqual(['turn-1', 'turn-1']);
    const turnState = secondInput.context.find(
      (message) => message.type === 'turn_state' && message.turnId === 'turn-1',
    );
    if (turnState?.type !== 'turn_state')
      throw new Error('prior failed turn_state was not projected');
    expect(turnState.status).toBe('failed');
    expect(turnState.errorClass).toBe('runtime_error');
    const terminalEventsAfterSecondTurn = (
      await runStore.readRuntimeEvents(session.id, firstRun.runId)
    ).filter(isTerminalRuntimeEvent);
    expect(terminalEventsAfterSecondTurn).toHaveLength(1);
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
      runtimeSource: 'test',
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
    expect(secondInput.runtimeContext?.map((event) => event.turnId)).toEqual([
      'turn-1',
      'turn-1',
      'turn-1',
    ]);
    expect(secondInput.runtimeContext?.some((event) => event.turnId === 'child-turn')).toBe(false);
    expect(
      secondInput.context.some(
        (message) => message.type === 'user' && message.turnId === 'child-turn',
      ),
    ).toBe(false);
  });

  test('child run input records parentRunId and starts without implicit prior context', async () => {
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
      now: nextNow(6_835),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');
    await drain(
      manager.sendMessage(session.id, {
        turnId: 'child-turn',
        text: 'child prompt',
        parentRunId: parentRun.runId,
        agentName: 'Researcher',
      }),
    );

    const childRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'child-turn',
    );
    if (!childRun) throw new Error('child run was not recorded');
    expect(childRun.parentRunId).toBe(parentRun.runId);
    expect(childRun.agentName).toBe('Researcher');

    const childInput = backendInstances[0]?.sendInputs[1];
    if (!childInput) throw new Error('child backend input was not recorded');
    expect(childInput.context).toEqual([]);
    expect(childInput.runtimeContext).toBe(undefined);
  });

  test('resumeChildAgent replays durable child history into a fresh lineage run', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const childBackends: TestBackend[] = [];
    backends.register('ai-sdk', (ctx) => {
      const backend = new TestBackend(ctx);
      if (ctx.systemPrompt) childBackends.push(backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_846),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const source = await manager.spawnChildAgent(session.id, {
      turnId: 'child-source',
      parentRunId: parentRun.runId,
      spec: { id: LOCAL_READ_AGENT_ID, name: 'ignored', systemPrompt: 'ignored' },
      prompt: 'inspect runtime',
    });
    if (!source.runId) throw new Error('source child run was not recorded');

    expect(await manager.prepareChildAgentResume(session.id, source.runId)).toEqual({
      sourceRunId: source.runId,
      execution: {
        kind: 'legacy_child_run',
        sessionId: session.id,
        runId: source.runId,
      },
      agentId: LOCAL_READ_AGENT_ID,
      agentName: LOCAL_READ_AGENT_DEFINITION.name,
      profile: LOCAL_READ_AGENT_DEFINITION.profile,
    });
    const resumed = await manager.resumeChildAgent(session.id, {
      turnId: 'child-resumed',
      parentRunId: parentRun.runId,
      sourceRunId: source.runId,
      prompt: 'continue with tests',
    });

    expect(resumed.resumedFromRunId).toBe(source.runId);
    const resumedHeader = await runStore.readRun(session.id, resumed.runId!);
    expect(resumedHeader).toMatchObject({
      parentRunId: parentRun.runId,
      resumedFromRunId: source.runId,
      agentId: LOCAL_READ_AGENT_ID,
      agentName: LOCAL_READ_AGENT_DEFINITION.name,
    });
    const resumedInput = childBackends[1]?.sendInputs[0];
    expect(resumedInput?.text).toBe('continue with tests');
    expect(resumedInput?.runtimeContext?.some((event) => event.runId === source.runId)).toBe(true);
    expect(
      resumedInput?.runtimeContext?.some(
        (event) =>
          event.role === 'user' &&
          event.content?.kind === 'text' &&
          event.content.text === 'inspect runtime',
      ),
    ).toBe(true);
    await expectRejects(
      manager.prepareChildAgentResume(session.id, source.runId),
      /already has a successor/,
    );
    expect(await manager.prepareChildAgentResume(session.id, resumed.runId!)).toMatchObject({
      sourceRunId: resumed.runId,
    });
  });

  test('prepareChildAgentResume rejects an indeterminate child tool boundary', async () => {
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
      now: nextNow(6_847),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const child = makeRunHeader({
      sessionId: session.id,
      runId: 'unsafe-child',
      turnId: 'unsafe-turn',
      status: 'failed',
      parentRunId: 'parent-run',
      agentId: LOCAL_READ_AGENT_ID,
      agentName: LOCAL_READ_AGENT_DEFINITION.name,
      permissionMode: 'explore',
      createdAt: 1,
      updatedAt: 4,
      completedAt: 4,
    });
    await seedRuntimeRun(runStore, child, [
      runtimeEvent({
        id: 'unsafe-user',
        sessionId: session.id,
        runId: child.runId,
        turnId: child.turnId,
        ts: 1,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'inspect' },
      }),
      runtimeEvent({
        id: 'unsafe-call',
        sessionId: session.id,
        runId: child.runId,
        turnId: child.turnId,
        ts: 2,
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'read-1', name: 'Read', args: { path: 'x' } },
        refs: { toolCallId: 'read-1', stepId: 'step-1' },
      }),
      runtimeEvent({
        id: 'unsafe-terminal',
        sessionId: session.id,
        runId: child.runId,
        turnId: child.turnId,
        ts: 4,
        status: 'failed',
        actions: { endInvocation: true },
      }),
    ]);

    await expectRejects(
      manager.prepareChildAgentResume(session.id, child.runId),
      /unmatched_tool_call/,
    );
  });

  test('retryChildAgent replays a rate-limited child without appending its prompt again', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const sendInputs: BackendSendInput[] = [];
    const contexts: BackendFactoryContext[] = [];
    let childAttempt = 0;
    const createBackend = (ctx: BackendFactoryContext) => ({
      kind: 'fake' as const,
      sessionId: ctx.sessionId,
      async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
        childAttempt += 1;
        sendInputs.push(input);
        if (childAttempt <= 2) {
          yield {
            type: 'error',
            id: `${input.turnId}-error`,
            turnId: input.turnId,
            ts: 1,
            recoverable: true,
            reason: 'RateLimit',
            message: 'provider 429',
          };
          yield {
            type: 'complete',
            id: `${input.turnId}-complete`,
            turnId: input.turnId,
            ts: 2,
            stopReason: 'error',
          };
          return;
        }
        yield {
          type: 'text_delta',
          id: `${input.turnId}-delta`,
          turnId: input.turnId,
          ts: 3,
          messageId: `${input.turnId}-message`,
          text: 'recovered',
        };
        yield {
          type: 'complete',
          id: `${input.turnId}-complete`,
          turnId: input.turnId,
          ts: 4,
          stopReason: 'end_turn',
        };
      },
      async stop(): Promise<void> {},
      async respondToSandboxBoundary(): Promise<void> {},
      async dispose(): Promise<void> {},
    });
    backends.register('ai-sdk', (ctx) => {
      contexts.push(ctx);
      return createBackend(ctx);
    });
    const retryResolutionStarted = makeGate();
    const releaseRetryResolution = makeGate();
    const policyGate = makeTestRuntimePolicyGate();
    let activationDepth = 0;
    let holdRetryActivation = false;
    let shellRevision = 'A';
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      resolveChildTools: async () => {
        const capturedRevision = shellRevision;
        if (holdRetryActivation && activationDepth > 0) {
          retryResolutionStarted.release();
          await releaseRetryResolution.promise;
        }
        return {
          tools: ['Read', 'Glob', 'Grep'].map((name) => ({
            ...testTool(name),
            description: `${name} retry shell ${capturedRevision}`,
          })),
          shell: {
            plan: { kind: 'posix', displayName: `retry shell ${capturedRevision}` },
          },
        };
      },
      runBackendActivation: (operation) =>
        policyGate.runBackendActivation(async () => {
          activationDepth += 1;
          try {
            return await operation();
          } finally {
            activationDepth -= 1;
          }
        }),
      inspectContinuationSafety: async () => ({
        workspaceIdentity: '/tmp/cwd',
        backgroundOperationsSettled: true,
        availableToolNames: [],
      }),
      newId: nextId(),
      now: nextNow(6_843),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const parentRun = makeRunHeader({
      sessionId: session.id,
      runId: 'parent-run',
      turnId: 'parent-turn',
      status: 'completed',
      createdAt: 100,
      updatedAt: 110,
      completedAt: 110,
    });
    await seedRuntimeRun(runStore, parentRun, [
      runtimeEvent({
        id: 'parent-complete',
        sessionId: session.id,
        runId: parentRun.runId,
        turnId: parentRun.turnId,
        ts: 110,
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ]);

    const first = await manager.spawnChildAgent(session.id, {
      turnId: 'child-rate-limited',
      parentRunId: parentRun.runId,
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Reader', systemPrompt: 'read only' },
      prompt: 'inspect auth',
    });
    expect(first.status).toBe('failed');
    expect(first.failureClass).toBe('RateLimit');
    if (!first.runId) throw new Error('rate-limited child run id was not recorded');

    const second = await manager.resumeChildAgent(session.id, {
      parentRunId: parentRun.runId,
      sourceRunId: first.runId,
      prompt: 'retry with additional guidance',
    });
    expect(second.status).toBe('failed');
    expect(second.failureClass).toBe('RateLimit');
    if (!second.runId) throw new Error('second rate-limited child run id was not recorded');
    await expectRejects(
      manager.retryChildAgent(session.id, {
        parentRunId: parentRun.runId,
        sourceRunId: first.runId,
      }),
      /already has a successor/,
    );

    const retryAbort = new AbortController();
    retryAbort.abort();
    const runsBeforeAbortedRetry = await runStore.listSessionRuns(session.id);
    let abortedRetryReady = 0;
    await expectRejects(
      manager.retryChildAgent(session.id, {
        parentRunId: parentRun.runId,
        sourceRunId: second.runId,
        abortSignal: retryAbort.signal,
        onReady: () => {
          abortedRetryReady += 1;
        },
      }),
      /cancelled before start/,
    );
    expect((await runStore.listSessionRuns(session.id)).length).toBe(runsBeforeAbortedRetry.length);
    expect(sendInputs).toHaveLength(2);
    expect(abortedRetryReady).toBe(0);

    holdRetryActivation = true;
    const retriedPromise = manager.retryChildAgent(session.id, {
      parentRunId: parentRun.runId,
      sourceRunId: second.runId,
    });
    await retryResolutionStarted.promise;
    let mutationApplied = false;
    const mutation = policyGate.runMutation(async () => {
      shellRevision = 'B';
      mutationApplied = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mutationApplied).toBe(false);
    releaseRetryResolution.release();
    const retried = await retriedPromise;
    await mutation;

    expect(retried.status).toBe('completed');
    expect(retried.retriedFromRunId).toBe(second.runId);
    expect(contexts.at(-1)?.turnShellPlan?.plan.displayName).toBe('retry shell A');
    expect(contexts.at(-1)?.tools?.[0]?.description).toMatch(/retry shell A/);
    expect(sendInputs.map((input) => input.text)).toEqual([
      'inspect auth',
      'retry with additional guidance',
      '',
    ]);
    expect(
      sendInputs[2]?.runtimeContext?.some(
        (event) =>
          event.role === 'user' &&
          event.content?.kind === 'text' &&
          event.content.text === 'inspect auth',
      ),
    ).toBe(true);
    const retryRun = await runStore.readRun(session.id, retried.runId!);
    expect(retryRun.retriedFromRunId).toBe(second.runId);
    expect(isSessionInlineRun(retryRun)).toBe(false);
    expect(retryRun.continuationSource).toMatchObject({
      protocol: 'continuation_source_v2',
      sourceRunId: second.runId,
    });
    const retryStart = (await runStore.readImmutableRuntimeEvents(session.id, retried.runId!))[0]
      ?.actions?.continuationStart;
    expect(retryStart?.protocol).toBe('continuation_start_v2');
    expect(retryStart?.immediateSource.runId).toBe(second.runId);
    expect(
      (await store.readMessages(session.id)).filter(
        (message) => 'turnId' in message && message.turnId === retried.turnId,
      ),
    ).toEqual([]);
  });

  test('retryChildAgent fails closed without a complete continuation composition', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let providerDispatches = 0;
    backends.register('ai-sdk', (ctx) => ({
      kind: 'fake' as const,
      sessionId: ctx.sessionId,
      async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
        providerDispatches += 1;
        yield {
          type: 'error',
          id: `${input.turnId}-error`,
          turnId: input.turnId,
          ts: 1,
          recoverable: true,
          reason: 'RateLimit',
          message: 'provider 429',
        };
        yield {
          type: 'complete',
          id: `${input.turnId}-complete`,
          turnId: input.turnId,
          ts: 2,
          stopReason: 'error',
        };
      },
      async stop(): Promise<void> {},
      async respondToSandboxBoundary(): Promise<void> {},
      async dispose(): Promise<void> {},
    }));
    const inspectContinuationSafety = async () => ({
      workspaceIdentity: '/tmp/cwd',
      backgroundOperationsSettled: true,
      availableToolNames: [] as string[],
    });
    const composeManager = (options: {
      runtimeEventStore?: RuntimeEventStore;
      withSafetyInspector?: boolean;
    }) =>
      new SessionManager({
        store,
        runStore,
        runtimeEventStore: options.runtimeEventStore ?? runStore,
        backends,
        childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
        ...(options.withSafetyInspector ? { inspectContinuationSafety } : {}),
        newId: nextId(),
        now: nextNow(6_845),
        runtimeSource: 'test',
      });
    const eventStoreWithoutAuthority = new Proxy(runStore, {
      get(target, property, receiver) {
        if (property === 'continuationAuthorityCapability') return undefined;
        return Reflect.get(target, property, receiver);
      },
    });

    const seeder = composeManager({});
    const session = await seeder.createSession(makeInput({ permissionMode: 'ask' }));
    const parentRun = makeRunHeader({
      sessionId: session.id,
      runId: 'parent-run',
      turnId: 'parent-turn',
      status: 'completed',
      createdAt: 100,
      updatedAt: 110,
      completedAt: 110,
    });
    await seedRuntimeRun(runStore, parentRun, [
      runtimeEvent({
        id: 'parent-complete',
        sessionId: session.id,
        runId: parentRun.runId,
        turnId: parentRun.turnId,
        ts: 110,
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ]);
    const first = await seeder.spawnChildAgent(session.id, {
      turnId: 'child-rate-limited',
      parentRunId: parentRun.runId,
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Reader', systemPrompt: 'read only' },
      prompt: 'inspect auth',
    });
    expect(first.status).toBe('failed');
    expect(first.failureClass).toBe('RateLimit');
    if (!first.runId) throw new Error('rate-limited child run id was not recorded');
    const runsBeforeRetries = await runStore.listSessionRuns(session.id);

    const incompleteCompositions = [
      {
        label: 'continuation authority and safety inspector are both missing',
        runtimeEventStore: eventStoreWithoutAuthority,
        withSafetyInspector: false,
      },
      {
        label: 'continuation authority is missing its safety inspector',
        runtimeEventStore: runStore,
        withSafetyInspector: false,
      },
      {
        label: 'safety inspector is missing its continuation authority',
        runtimeEventStore: eventStoreWithoutAuthority,
        withSafetyInspector: true,
      },
    ];
    for (const composition of incompleteCompositions) {
      const manager = composeManager(composition);
      await expectRejects(
        manager.retryChildAgent(session.id, {
          parentRunId: parentRun.runId,
          sourceRunId: first.runId,
        }),
        /composition is incomplete/,
      );
    }
    expect(providerDispatches).toBe(1);
    expect(await runStore.listSessionRuns(session.id)).toHaveLength(runsBeforeRetries.length);
  });

  test('parent and child runs can read their ledger while only parents may compact session history', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const contexts: BackendFactoryContext[] = [];
    const seamReads: Array<{ turnId: string; eventIds: string[] } | undefined> = [];
    class SeamProbeBackend extends TestBackend {
      constructor(private readonly probeCtx: BackendFactoryContext) {
        super(probeCtx);
      }

      override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
        seamReads.push(
          this.probeCtx.loadTurnRuntimeEvents
            ? {
                turnId: input.turnId,
                eventIds: (await this.probeCtx.loadTurnRuntimeEvents(input.turnId)).map(
                  (event) => event.id,
                ),
              }
            : undefined,
        );
        yield* super.send(input);
      }
    }
    backends.register('ai-sdk', (ctx) => {
      contexts.push(ctx);
      return new SeamProbeBackend(ctx);
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_850),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');
    await manager.spawnChildAgent(session.id, {
      turnId: 'child-turn',
      parentRunId: parentRun.runId,
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Reader', systemPrompt: 'read only' },
      prompt: 'inspect',
    });

    // The parent (main-session) backend can read its turn's durable ledger —
    // the seam resolves the active run and returns the persisted events.
    expect(seamReads.length).toBe(2);
    expect(seamReads[0]?.turnId).toBe('parent-turn');
    expect((seamReads[0]?.eventIds.length ?? 0) > 0).toBe(true);

    // Both runs need their authoritative ledger for Runtime-owned continuation.
    // A separate capability keeps child-only ledgers from claiming coverage of
    // the parent session projection during mid-turn history compaction.
    expect(contexts.length).toBe(2);
    expect(typeof contexts[0]?.loadTurnRuntimeEvents).toBe('function');
    expect(typeof contexts[1]?.loadTurnRuntimeEvents).toBe('function');
    expect((seamReads[1]?.eventIds.length ?? 0) > 0).toBe(true);
    const capabilities = contexts as Array<
      BackendFactoryContext & { allowMidTurnHistoryCompaction?: boolean }
    >;
    expect(capabilities[0]?.allowMidTurnHistoryCompaction).toBe(true);
    expect(capabilities[1]?.allowMidTurnHistoryCompaction).toBe(false);
  });

  test('resolves the child execution toolset at activation time', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const contexts: BackendFactoryContext[] = [];
    backends.register('ai-sdk', (ctx) => {
      contexts.push(ctx);
      return new TestBackend(ctx);
    });
    let resolutions = 0;
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      resolveChildTools: async () => {
        resolutions += 1;
        return {
          tools: ['Read', 'Glob', 'Grep'].map((name) => ({
            ...testTool(name),
            description: `${name} turn-scoped toolset ${resolutions}`,
          })),
        };
      },
      newId: nextId(),
      now: nextNow(6_851),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    await manager.spawnChildAgent(session.id, {
      turnId: 'child-turn',
      parentRunId: parentRun.runId,
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Reader', systemPrompt: 'read only' },
      prompt: 'inspect',
    });

    assert.equal(resolutions, 1);
    assert.match(contexts[1]?.tools?.[0]?.description ?? '', /turn-scoped toolset/);
  });

  test('captures child tools and shell plan inside one backend activation snapshot', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const contexts: BackendFactoryContext[] = [];
    backends.register('ai-sdk', (ctx) => {
      contexts.push(ctx);
      return new TestBackend(ctx);
    });
    const resolutionStarted = makeGate();
    const releaseResolution = makeGate();
    const { runBackendActivation, runMutation } = makeTestRuntimePolicyGate();
    let shellRevision = 'A';
    let mutationApplied = false;
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      resolveChildTools: async () => {
        const capturedRevision = shellRevision;
        resolutionStarted.release();
        await releaseResolution.promise;
        return {
          tools: ['Read', 'Glob', 'Grep'].map((name) => ({
            ...testTool(name),
            description: `${name} shell snapshot ${capturedRevision}`,
          })),
          shell: {
            plan: { kind: 'posix', displayName: `shell ${capturedRevision}` },
          },
        };
      },
      runBackendActivation,
      newId: nextId(),
      now: nextNow(6_852),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const childTurn = manager.spawnChildAgent(session.id, {
      turnId: 'child-turn',
      parentRunId: parentRun.runId,
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Reader', systemPrompt: 'read only' },
      prompt: 'inspect',
    });
    await resolutionStarted.promise;
    const mutation = runMutation(async () => {
      shellRevision = 'B';
      mutationApplied = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mutationApplied).toBe(false);

    releaseResolution.release();
    await childTurn;
    await mutation;

    expect(contexts[1]?.turnShellPlan?.plan.displayName).toBe('shell A');
    expect(contexts[1]?.tools?.[0]?.description).toMatch(/shell snapshot A/);
    expect(shellRevision).toBe('B');
  });

  test('spawnChildAgent returns the terminal RuntimeEvent status when the child header commit fails', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore({ failUpdateRunStatusOnce: 'completed' });
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new TestBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_843),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const parentRun = makeRunHeader({
      sessionId: session.id,
      runId: 'parent-run',
      turnId: 'parent-turn',
      status: 'completed',
      createdAt: 100,
      updatedAt: 110,
      completedAt: 110,
    });
    await seedRuntimeRun(runStore, parentRun, [
      runtimeEvent({
        id: 'parent-complete',
        sessionId: session.id,
        runId: parentRun.runId,
        turnId: parentRun.turnId,
        ts: 110,
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ]);

    const result = await manager.spawnChildAgent(session.id, {
      turnId: 'child-turn',
      parentRunId: parentRun.runId,
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Researcher', systemPrompt: 'read only' },
      prompt: 'inspect',
    });

    expect(result.status).toBe('completed');
    const childRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'child-turn',
    );
    expect(childRun?.status).toBe('running');
    const childTerminalEvents = (
      await runStore.readRuntimeEvents(session.id, childRun!.runId)
    ).filter(isTerminalRuntimeEvent);
    expect(childTerminalEvents).toHaveLength(1);
  });

  test('spawnChildAgent preserves step-limit failure without a run store', async () => {
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) => new EventBackend(ctx, [{ type: 'complete', stopReason: 'step_limit' }]),
    );
    const manager = new SessionManager({
      store,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_844),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));

    const result = await manager.spawnChildAgent(session.id, {
      turnId: 'child-turn',
      parentRunId: 'parent-run',
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Researcher', systemPrompt: 'read only' },
      prompt: 'inspect',
    });

    expect(result.status).toBe('failed');
    expect(result.failureClass).toBe('tool_step_cap_reached');
  });

  test('spawnChildAgent summarizes high-volume child output without returning the full stream', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new HighVolumeDeltaBackend(ctx, 512));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_844),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const observed: SessionEvent[] = [];
    const result = await manager.spawnChildAgent(session.id, {
      turnId: 'child-turn',
      parentRunId: parentRun.runId,
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Researcher', systemPrompt: 'read only' },
      prompt: 'produce a large report',
      onEvent: (event) => observed.push(event),
    });

    expect(result.status).toBe('completed');
    expect(result.eventCount).toBe(513);
    expect(result.summary.length <= 4_000).toBe(true);
    expect(result.summary.startsWith('…')).toBe(true);
    expect(result.summary.includes('chunk-000')).toBe(false);
    expect(result.summary.includes('chunk-511')).toBe(true);
    expect(observed).toHaveLength(513);
    expect(observed[0]?.type).toBe('text_delta');
    expect(observed.at(-1)?.type).toBe('complete');
  });

  test('stopSession cancels active child runs and disposes their backend', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const childGate = makeGate();
    const backendInstances: TestBackend[] = [];
    backends.register('ai-sdk', (ctx) => {
      const backend = new TestBackend(
        ctx,
        ctx.header.permissionMode === 'explore' ? childGate : undefined,
      );
      backendInstances.push(backend);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_845),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    const child = manager
      .startChildTurn(session.id, {
        turnId: 'child-turn',
        parentRunId: parentRun.runId,
        spec: { id: LOCAL_READ_AGENT_ID, name: 'Researcher', systemPrompt: 'read only' },
        prompt: 'inspect slowly',
      })
      [Symbol.asyncIterator]();
    await child.next();

    await manager.stopSession(session.id, { source: 'stop_button' });
    expect(backendInstances[0]?.stopCalls).toBe(0);
    expect(backendInstances[1]?.stopCalls).toBe(1);
    childGate.release();
    await child.next();
    await child.next();

    const childRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'child-turn',
    );
    if (!childRun) throw new Error('child run was not recorded');
    expect(childRun.status).toBe('cancelled');
    expect(store.disposeCount).toBe(1);
    await manager.setPermissionMode(session.id, 'execute');
    expect((await store.readHeader(session.id)).permissionMode).toBe('execute');
  });

  test('stopSession waits for a child start blocked before Run reservation', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let childBackend: TestBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      childBackend = new TestBackend(ctx);
      return childBackend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_845),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const readStarted = makeGate();
    const releaseRead = makeGate();
    store.nextReadHeaderGate = { started: readStarted, release: releaseRead };
    const child = manager
      .startChildTurn(session.id, {
        turnId: 'pending-child-turn',
        parentRunId: 'parent-run',
        spec: { id: LOCAL_READ_AGENT_ID, name: 'Researcher', systemPrompt: 'read only' },
        prompt: 'must not dispatch after stop',
      })
      [Symbol.asyncIterator]();
    const firstEvent = child.next();
    await readStarted.promise;

    let stopSettled = false;
    const stop = manager.stopSession(session.id, { source: 'stop_button' }).finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseRead.release();
    await stop;
    expect((await firstEvent).done).toBe(true);
    expect(childBackend?.sendInputs).toEqual([]);
    const childRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'pending-child-turn',
    );
    expect(childRun?.status).toBe('cancelled');
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
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const active = manager
      .sendMessage(session.id, { turnId: 'active-parent-turn', text: 'hold active' })
      [Symbol.asyncIterator]();
    expect((await active.next()).value?.type).toBe('text_delta');

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
    expect(stopSettled).toBe(false);

    releaseRead.release();
    activeGate.release();
    await stopping;
    expect((await pendingEvent).done).toBe(true);
    while (!(await active.next()).done) {}
    expect(backend?.sendInputs.map((input) => input.turnId)).toEqual(['active-parent-turn']);
    const runs = await runStore.listSessionRuns(session.id);
    expect(runs.find((run) => run.turnId === 'active-parent-turn')?.status).toBe('cancelled');
    expect(runs.find((run) => run.turnId === 'pending-parent-turn')?.status).toBe('cancelled');
    expect((await store.readHeader(session.id)).status).toBe('aborted');
  });

  test('public child spawn is stop-visible while async onReady is pending', async () => {
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
      now: nextNow(6_845),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const readyStarted = makeGate();
    const releaseReady = makeGate();
    const spawned = manager.spawnChildAgent(session.id, {
      turnId: 'child-on-ready-stop',
      parentRunId: 'parent-run',
      spec: { id: LOCAL_READ_AGENT_ID, name: 'Researcher', systemPrompt: 'read only' },
      prompt: 'must not reach the provider',
      onReady: async () => {
        readyStarted.release();
        await releaseReady.promise;
      },
    });
    await readyStarted.promise;

    let stopSettled = false;
    const stopping = manager.stopSession(session.id, { source: 'stop_button' }).finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseReady.release();
    const [result] = await Promise.all([spawned, stopping]);
    expect(result.status).toBe('cancelled');
    expect(backend?.sendInputs).toEqual([]);
    const run = (await runStore.listSessionRuns(session.id)).find(
      (candidate) => candidate.turnId === 'child-on-ready-stop',
    );
    expect(run?.status).toBe('cancelled');
    expect((await store.readHeader(session.id)).status === 'blocked').toBe(false);
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
      runtimeSource: 'test',
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
    expect(stopSettled).toBe(false);

    releaseBuild.release();
    await expectRejects(firstEvent, /backend activation timed out/);
    await stopping;
    const run = await runStore.readRun(
      session.id,
      (await runStore.listSessionRuns(session.id))[0]!.runId,
    );
    expect(run.status).toBe('cancelled');
    expect(run.failureClass).toBe(undefined);
    expect((await store.readHeader(session.id)).status).toBe('aborted');
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
      runtimeSource: 'test',
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

    expect(factorySignal?.aborted).toBe(true);
    expect((await firstEvent).done).toBe(true);
    expect(dispatches).toBe(0);
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('cancelled');
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
      runtimeSource: 'test',
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

    expect((await firstEvent).done).toBe(true);
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('cancelled');
    expect(run?.failureClass).toBe(undefined);
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
      runtimeSource: 'test',
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

    expect((await firstEvent).done).toBe(true);
    expect(firstDisposeCalls).toBe(1);
    expect(firstDispatches).toBe(0);
    const [stoppedRun] = await runStore.listSessionRuns(session.id);
    expect(stoppedRun?.status).toBe('cancelled');

    await drain(
      manager.sendMessage(session.id, {
        turnId: 'post-ignored-factory-stop',
        text: 'must build a fresh backend',
      }),
    );
    expect(builds).toBe(2);
    expect(firstDisposeCalls).toBe(1);
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
      runtimeSource: 'test',
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
    expect(disposeCalls).toBe(1);
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('cancelled');

    await expectRejects(
      drain(
        manager.sendMessage(session.id, {
          turnId: 'late-disposal-next-turn',
          text: 'must not create a second backend after quarantine failure',
        }),
      ),
      /permanently quarantined/,
    );
    expect(builds).toBe(1);
    expect(disposeCalls).toBe(1);
  });

  test('stopSession keeps a rejected backend generation quarantined across retries', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const childGate = makeGate();
    let childBackend: RetryStopBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      if (ctx.header.permissionMode !== 'explore') return new TestBackend(ctx);
      childBackend = new RetryStopBackend(ctx, childGate);
      return childBackend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_846),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');
    const child = manager
      .startChildTurn(session.id, {
        turnId: 'child-turn',
        parentRunId: parentRun.runId,
        spec: { id: LOCAL_READ_AGENT_ID, name: 'Researcher', systemPrompt: 'read only' },
        prompt: 'inspect slowly',
      })
      [Symbol.asyncIterator]();
    await child.next();

    await expectRejects(
      manager.stopSession(session.id, { source: 'stop_button' }),
      /first stop failed/,
    );
    await expectRejects(
      manager.stopSession(session.id, { source: 'stop_button' }),
      /first stop failed/,
    );
    expect(childBackend?.stopCalls).toBe(1);
    childGate.release();
    while (!(await child.next()).done) {}
    const childRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'child-turn',
    );
    expect(childRun?.status).toBe('cancelled');
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
      runtimeSource: 'test',
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
    expect(secondStopSettled).toBe(false);
    releaseStop.release();
    await Promise.all([firstStop, secondStop]);
    while (!(await turn.next()).done) {}

    expect(backend?.stopCalls).toBe(1);
    const messages = await store.readMessages(session.id);
    expect(
      messages.filter((message) => message.type === 'system_note' && message.kind === 'abort'),
    ).toHaveLength(1);
    expect(
      messages.filter(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'turn-1' &&
          message.status === 'aborted',
      ),
    ).toHaveLength(1);
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
      runtimeSource: 'test',
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
    expect(stopSettled).toBe(false);
    releaseRead.release();
    await stop;
    expect((await firstEvent).done).toBe(true);

    expect(backend?.stopCalls).toBe(1);
    expect(backend?.stopModes).toEqual(['after_step']);
    expect(backend?.sendInputs.map((input) => input.turnId)).toEqual(['turn-warm-cache']);
    const registeringRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-registering',
    );
    expect(registeringRun?.status).toBe('cancelled');
    expect(
      (await runStore.readRuntimeEvents(session.id, registeringRun!.runId)).filter(
        isTerminalRuntimeEvent,
      ),
    ).toHaveLength(1);
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
      runtimeSource: 'test',
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
    expect((await firstEvent).done).toBe(true);
    expect(backend?.sendInputs).toEqual([]);
    const stoppedRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'turn-post-start-hook-stop',
    );
    expect(stoppedRun?.status).toBe('cancelled');
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
      runtimeSource: 'test',
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
    expect(builds).toBe(1);

    releaseBuild.release();
    expect((await firstEvent).value?.type).toBe('text_delta');
    expect((await secondEvent).value?.type).toBe('text_delta');
    await expectRejects(
      manager.respondToSandboxBoundary(session.id, {
        requestId: 'control-broadcast',
        decision: 'deny',
      }),
      /No pending sandbox boundary request/,
    );
    expect(backend?.permissionResponses).toBe(0);
    expect(builds).toBe(1);

    releaseSend.release();
    while (!(await first.next()).done) {}
    while (!(await second.next()).done) {}
    expect(backend?.sendInputs).toHaveLength(2);
  });

  test('routes a sandbox boundary response only to the generation that emitted its request', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const childGate = makeGate();
    let parentBackend: SandboxBoundaryWaitBackend | undefined;
    let childBackend: PermissionBroadcastBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      if (ctx.header.permissionMode === 'explore') {
        childBackend = new PermissionBroadcastBackend(ctx, childGate);
        return childBackend;
      }
      parentBackend = new SandboxBoundaryWaitBackend(ctx);
      return parentBackend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_848),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());
    const parent = manager
      .sendMessage(session.id, { turnId: 'parent-boundary-turn', text: 'parent' })
      [Symbol.asyncIterator]();
    expect((await parent.next()).value?.type).toBe('sandbox_boundary_request');

    const child = manager
      .startChildTurn(session.id, {
        turnId: 'child-running-turn',
        parentRunId: 'parent-run',
        spec: { id: LOCAL_READ_AGENT_ID, name: 'Researcher', systemPrompt: 'read only' },
        prompt: 'stay active',
      })
      [Symbol.asyncIterator]();
    expect((await child.next()).value?.type).toBe('text_delta');

    await manager.respondToSandboxBoundary(session.id, {
      requestId: 'boundary-1',
      decision: 'deny',
    });
    expect(parentBackend?.responses).toEqual([{ requestId: 'boundary-1', decision: 'deny' }]);
    expect(childBackend?.permissionResponses).toBe(0);

    while (!(await parent.next()).done) {}
    childGate.release();
    while (!(await child.next()).done) {}
  });

  test('stopSession does not reenter a failed backend in a multi-generation stop', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const parentGate = makeGate();
    const childGate = makeGate();
    let parentBackend: CountingStopBackend | undefined;
    let childBackend: RetryStopBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      if (ctx.header.permissionMode === 'explore') {
        childBackend = new RetryStopBackend(ctx, childGate);
        return childBackend;
      }
      parentBackend = new CountingStopBackend(ctx, parentGate);
      return parentBackend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(6_848),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const parent = manager
      .sendMessage(session.id, { turnId: 'parent-turn', text: 'parent' })
      [Symbol.asyncIterator]();
    await parent.next();
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');
    const child = manager
      .startChildTurn(session.id, {
        turnId: 'child-turn',
        parentRunId: parentRun.runId,
        spec: { id: LOCAL_READ_AGENT_ID, name: 'Researcher', systemPrompt: 'read only' },
        prompt: 'child',
      })
      [Symbol.asyncIterator]();
    await child.next();

    await expectRejects(
      manager.stopSession(session.id, { source: 'stop_button' }),
      /first stop failed/,
    );
    await expectRejects(
      manager.stopSession(session.id, { source: 'stop_button' }),
      /first stop failed/,
    );

    expect(parentBackend?.stopCalls).toBe(1);
    expect(childBackend?.stopCalls).toBe(1);
    parentGate.release();
    childGate.release();
    while (!(await parent.next()).done) {}
    while (!(await child.next()).done) {}
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
      runtimeSource: 'test',
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

    expect(backend?.stopCalls).toBe(1);
    const messages = await store.readMessages(session.id);
    expect(
      messages.filter(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'turn-1' &&
          message.status === 'aborted',
      ),
    ).toHaveLength(1);
    expect(
      messages.filter((message) => message.type === 'system_note' && message.kind === 'abort'),
    ).toHaveLength(1);
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
      runtimeSource: 'test',
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

    expect(backend?.stopCalls).toBe(1);
    const messages = await store.readMessages(session.id);
    expect(
      messages.filter(
        (message) =>
          message.type === 'turn_state' &&
          message.turnId === 'turn-retained-stop' &&
          message.status === 'aborted',
      ),
    ).toHaveLength(1);
    expect(
      messages.filter((message) => message.type === 'system_note' && message.kind === 'abort'),
    ).toHaveLength(1);
  });

  test('spawnChildAgent fails closed instead of running a degraded catalog agent', async () => {
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
      childTools: [testTool('Read')],
      newId: nextId(),
      now: nextNow(6_847),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'execute' }));
    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'parent context' }));
    const [parentRun] = await runStore.listSessionRuns(session.id);
    if (!parentRun) throw new Error('parent run was not recorded');

    await expectRejects(
      manager.spawnChildAgent(session.id, {
        turnId: 'child-turn',
        parentRunId: parentRun.runId,
        spec: {
          id: LOCAL_READ_AGENT_ID,
          name: LOCAL_READ_AGENT_DEFINITION.name,
          systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
        },
        prompt: 'inspect',
      }),
      /Agent "local-read" is unavailable: missing tools: Glob, Grep/,
    );

    expect(backendInstances).toHaveLength(1);
    expect(
      (await runStore.listSessionRuns(session.id)).some((run) => run.turnId === 'child-turn'),
    ).toBe(false);

    await expectRejects(
      manager.spawnChildAgent(session.id, {
        turnId: 'web-child-turn',
        parentRunId: parentRun.runId,
        spec: {
          id: WEB_RESEARCH_AGENT_ID,
          name: WEB_RESEARCH_AGENT_DEFINITION.name,
          systemPrompt: WEB_RESEARCH_AGENT_DEFINITION.systemPrompt,
        },
        prompt: 'search',
      }),
      /Agent "web-research" is unavailable: missing tools: WebSearch/,
    );
    expect(backendInstances).toHaveLength(1);
    expect(
      (await runStore.listSessionRuns(session.id)).some((run) => run.turnId === 'web-child-turn'),
    ).toBe(false);
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
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'execute' }));
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
    expect(list.definitions.map((agent) => agent.id)).toEqual([
      LOCAL_READ_AGENT_ID,
      WEB_RESEARCH_AGENT_ID,
      IMPLEMENTATION_AGENT_ID,
    ]);
    expect(list.definitions[0]?.availability).toEqual({ status: 'available' });
    expect(list.definitions[0]?.contract.defaultWriteBack).toBe('summary');
    expect(list.definitions[0]?.contract.workspace).toBe('same_workspace');
    expect(list.definitions[1]?.availability).toEqual({
      status: 'unavailable',
      reason: 'missing_tools',
      missingTools: ['WebSearch'],
    });
    expect(list.definitions[2]?.availability).toEqual({
      status: 'unavailable',
      reason: 'workspace_isolation_unavailable',
      workspace: AGENT_WORKSPACE_WORKTREE,
      requiredRuntime: 'worktree_child_executor',
    });
    expect(list.runs.map((agent) => agent.runId)).toEqual(['child-run']);
    expect(list.executions.map((agent) => agent.execution)).toEqual([
      {
        kind: 'legacy_child_run',
        sessionId: session.id,
        runId: 'child-run',
      },
    ]);
    expect(list.runs[0]?.agentId).toBe(LOCAL_READ_AGENT_ID);
    expect(list.runs[0]?.agentName).toBe('Researcher');
    expect(list.runs[0]?.durationMs).toBe(10);

    const output = await manager.readChildAgentOutput(session.id, { runId: 'child-run' });
    expect(output.header.runId).toBe('child-run');
    expect(output.runtimeEvents.map((event) => event.id)).toEqual([
      'child-user',
      'child-answer',
      'child-complete',
    ]);
    expect(output.artifacts.map((artifact) => artifact.id)).toEqual(['artifact-1']);
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
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'execute' }));
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
    expect(list.runs[0]?.runId).toBe('child-run');
    expect(list.runs[0]?.status).toBe('completed');
    expect(list.runs[0]?.completedAt).toBe(140);
    expect(list.runs[0]?.durationMs).toBe(10);

    const output = await manager.readChildAgentOutput(session.id, { runId: 'child-run' });
    expect(output.header.status).toBe('completed');
    expect(output.header.completedAt).toBe(140);
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
      runtimeSource: 'test',
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

    expect(output.header.runId).toBe('child-run');
    expect(output.events.map((event) => event.id)).toEqual([
      'op-20',
      'op-21',
      'op-22',
      'op-23',
      'op-24',
    ]);
    expect(output.runtimeEvents.map((event) => event.id)).toEqual([
      'rt-20',
      'rt-21',
      'rt-22',
      'rt-23',
      'rt-24',
    ]);
    expect(output.truncated.events).toBe(true);
    expect(output.truncated.runtimeEvents).toBe(true);
    expect(output.budget.view).toBe('all');
    expect(output.budget.projectedBytes <= output.budget.maxBytes).toBe(true);
    expect('modelReplay' in output).toBe(false);
    expect('projection' in output).toBe(false);
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
      runtimeSource: 'test',
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

    expect(output.events).toEqual([]);
    expect(output.runtimeEvents.map((event) => event.id)).toEqual(['final']);
    expect(output.truncated.events).toBe(true);
    expect(output.truncated.runtimeEvents).toBe(true);
    expect(output.truncated.bytes).toBe(true);
    expect(output.budget).toMatchObject({
      view: 'runtime_events',
      maxBytes: 1024,
    });
    expect(output.budget.projectedBytes <= output.budget.maxBytes).toBe(true);
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
    expect(header.status).toBe('blocked');
    expect(header.blockedReason).toBe('unknown');
    const messages = await store.readMessages(session.id);
    expect(messages.some((message) => message.type === 'user' && message.turnId === 'turn-1')).toBe(
      true,
    );
    const turn = (await store.listTurns(session.id)).find(
      (candidate) => candidate.turnId === 'turn-1',
    );
    expect(turn?.status).toBe('failed');
    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('AgentRunStore run was not created');
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('missing_terminal_event');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('failed');
    expect(terminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
    expect((await manager.getMessages(session.id)).some((message) => message.type === 'user')).toBe(
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
    expect((await iterator.next()).value?.type).toBe('sandbox_boundary_request');
    const [activeBoundaryRequest] = await manager.listActiveInteractions(session.id);
    expect(activeBoundaryRequest).toMatchObject({
      type: 'sandbox_boundary_request',
      requestId: 'boundary-1',
      toolUseId: 'tool-1',
      turnId: 'turn-1',
    });

    expect((await store.readHeader(session.id)).status).toBe('waiting_for_user');
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('waiting_for_user');
    await expectRejects(manager.setPermissionMode(session.id, 'bypass'), /当前任务正在运行/);
    expect((await store.readHeader(session.id)).permissionMode).toBe('ask');

    await manager.respondToSandboxBoundary(session.id, {
      requestId: 'boundary-1',
      decision: 'deny',
    });
    expect(backend?.responses).toEqual([{ requestId: 'boundary-1', decision: 'deny' }]);
    expect((await iterator.next()).value?.type).toBe('sandbox_boundary_decision_ack');
    expect(await manager.listActiveInteractions(session.id)).toEqual([]);
    while (!(await iterator.next()).done) {}
    expect((await store.readHeader(session.id)).status).toBe('active');
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
    expect(request?.type).toBe('user_question_request');

    // The surface that raised this request may never have been mounted, so the
    // request has to be readable back from the kernel (#2072).
    const active = await manager.listActiveInteractions(session.id);
    expect(active).toEqual([request]);

    const requestId = (request as Extract<SessionEvent, { type: 'user_question_request' }>)
      .requestId;
    // One registry now holds both request kinds, so answering a question as if
    // it were a boundary must settle nothing and leave the entry intact.
    await expectRejects(
      manager.respondToSandboxBoundary(session.id, { requestId, decision: 'deny' }),
      /No pending sandbox boundary request/,
    );
    expect(await manager.listActiveInteractions(session.id)).toEqual([request]);

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
    expect(ack?.type).toBe('user_question_answer_ack');
    expect(await manager.listActiveInteractions(session.id)).toEqual([]);
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
    expect(request?.type).toBe('user_question_request');

    // A stop settles no answer, so this question never gets its ack. Only the
    // turn-end release keeps it from being read back as a prompt for a dead
    // run — one nothing could answer, since the backend generation is gone.
    await manager.stopSession(session.id, { source: 'stop_button' });
    while (!(await iterator.next()).done) {}
    expect(await manager.listActiveInteractions(session.id)).toEqual([]);
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
    expect((await iterator.next()).value?.type).toBe('sandbox_boundary_request');
    await manager.respondToSandboxBoundary(session.id, {
      requestId: 'boundary-1',
      decision: 'allow',
    });
    while (!(await iterator.next()).done) {}

    const messages = await manager.getMessages(session.id);
    expect(messages.some((message) => message.type === 'user')).toBe(true);
    const turns = await manager.listTurns(session.id);
    expect(turns.find((turn) => turn.turnId === 'turn-1')?.status).toBe('completed');
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
    expect(messages.filter((message) => message.type === 'user').length).toBe(1);
    expect(
      messages.some((message) => message.type === 'assistant' && message.text === 'hi back'),
    ).toBe(true);
    const turns = await manager.listTurns(session.id);
    expect(turns.find((turn) => turn.turnId === 'turn-1')?.status).toBe('completed');

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
    }).getSessionView(session.id);
    expect(
      view.diagnostics.filter((diagnostic) => diagnostic.code === 'unclaimed_control_fact').length,
    ).toBe(1);
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
    expect(turn?.status).toBe('failed');
    expect(turn?.errorClass).toBe('runtime_error');
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.failureClass).toBe('runtime_error');
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

    expect((await store.readHeader(session.id)).status).toBe('active');
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('failed');
    expect(turn?.errorClass).toBe('tool_step_cap_reached');
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('failed');
    expect(run?.failureClass).toBe('tool_step_cap_reached');
    const terminal = (await runStore.readRuntimeEvents(session.id, run!.runId)).find(
      (event) => event.actions?.endInvocation,
    );
    expect(terminal?.status).toBe('failed');
    expect(terminal?.actions?.stateDelta).toMatchObject({
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
    expect(states.map((state) => (state.type === 'turn_state' ? state.status : ''))).toEqual([
      'running',
      'failed',
    ]);
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('failed');
    expect(turn?.errorClass).toBe('tool_failed');
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
    expect(turn?.status).toBe('aborted');
    expect(turn?.abortSource).toBe('renderer.stop_button');
    const abortNote = (await store.readMessages(session.id)).find(
      (message) => message.type === 'system_note' && message.kind === 'abort',
    );
    expect(abortNote?.type).toBe('system_note');
    if (abortNote?.type !== 'system_note') throw new Error('abort note missing');
    expect(abortNote.data).toEqual({ source: 'renderer.stop_button' });
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
    expect(abort.value?.type).toBe('abort');
    backend?.allowStopReturn();
    await stopPromise;
    while (!(await iterator.next()).done) {}

    const [run] = await runStore.listSessionRuns(session.id);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run!.runId);
    const terminalEvents = runtimeEvents.filter((event) => event.status === 'aborted');
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.actions?.stateDelta?.abortSource).toBe('renderer.stop_button');
    const messages = await manager.getMessages(session.id);
    expect(messages.some((message) => message.type === 'user' && message.turnId === 'turn-1')).toBe(
      true,
    );
    expect(messages.find((message) => message.type === 'turn_state')).toEqual({
      type: 'turn_state',
      id: terminalEvents[0]?.id,
      turnId: 'turn-1',
      ts: 2,
      status: 'aborted',
      abortedAt: 2,
      abortSource: 'renderer.stop_button',
      partialOutputRetained: false,
    });
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

    expect(emitted.map((event) => event.type)).toEqual(['text_delta', 'abort']);
    expect(
      runtimeEvents
        .filter((event) => event.role === 'model' && event.content?.kind === 'text')
        .map((event) => (event.content?.kind === 'text' ? event.content.text : '')),
    ).toEqual(['before']);
    const abortedEvents = runtimeEvents.filter((event) => event.status === 'aborted');
    expect(abortedEvents).toHaveLength(1);
    expect(abortedEvents[0]?.actions?.stateDelta?.abortSource).toBe('user_stop');
    expect(run?.status).toBe('cancelled');
    expect(run?.abortSource).toBe('user_stop');
    expect(turnStates).toHaveLength(1);
    expect(turnStates[0]?.type === 'turn_state' ? turnStates[0].status : undefined).toBe('aborted');
    expect(turnStates[0]?.type === 'turn_state' ? turnStates[0].abortSource : undefined).toBe(
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

    expect(emitted.map((event) => event.type)).toEqual(['text_delta', 'complete']);
    expect(run?.status).toBe('completed');
    expect(
      runtimeEvents
        .filter((event) => event.role === 'model' && event.content?.kind === 'text')
        .map((event) => (event.content?.kind === 'text' ? event.content.text : '')),
    ).toEqual(['before']);
    expect(runtimeEvents.filter((event) => event.status === 'completed')).toHaveLength(1);
    expect(runtimeEvents.filter((event) => event.status === 'failed')).toHaveLength(0);
    expect(turnStates).toHaveLength(1);
    expect(turnStates[0]?.type === 'turn_state' ? turnStates[0].status : undefined).toBe(
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

    expect((await store.readHeader(session.id)).status).toBe('aborted');
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('aborted');
    expect(turn?.abortSource).toBe('renderer.stop_button');
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('cancelled');
    expect(run?.failureClass).toBeUndefined();
    const events = (await runStore.readEvents(session.id, run!.runId)).map((event) => event.type);
    expect(events).toContain('run_cancelled');
    expect(events.includes('run_failed')).toBe(false);
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
    expect(run?.backendKind).toBe('ai-sdk');
    expect(run?.llmConnectionSlug).toBe('fake');
    expect(run?.modelId).toBe('fake-model');
    expect(run?.permissionMode).toBe('ask');
    expect(run?.status).toBe('completed');
    const events = await runStore.readEvents(session.id, run!.runId);
    expect(events.map((event) => event.type)).toContain('model_stream_started');
    expect(events.map((event) => event.type)).toContain('model_stream_completed');
    expect(events.map((event) => event.type)).toContain('run_completed');
    expect(JSON.stringify(events).includes('sk-live-secret-token-value')).toBe(false);
  });

  test('required capture and later attempt still write after an attempt append fails', async () => {
    const store = new MemorySessionStore();
    const attemptFailureRecorded = makeGate();
    const captureOutcomes: string[] = [];
    let failAttemptOnce = true;
    const runStore = new MemoryAgentRunStore({
      beforeAgentRunEventAppend: async (_sessionId, _runId, event) => {
        if (event.type === 'provider_request_attempt_recorded' && failAttemptOnce) {
          failAttemptOnce = false;
          throw new Error('diagnostic attempt append failed');
        }
        if (event.type === 'trace_write_failed') attemptFailureRecorded.release();
      },
    });
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new ProviderCaptureAfterAttemptFailureBackend(
          ctx,
          attemptFailureRecorded.promise,
          captureOutcomes,
        ),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_762),
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    expect(captureOutcomes).toEqual(['fulfilled']);
    const [run] = await runStore.listSessionRuns(session.id);
    const events = await runStore.readEvents(session.id, run!.runId);
    expect(events.some((event) => event.type === 'provider_request_captured')).toBe(true);
    expect(events.some((event) => event.id === 'attempt-2')).toBe(true);
  });

  test('carries a provider attempt failure latch into the terminal run header', async () => {
    const store = new MemorySessionStore();
    let failAttemptAppend = true;
    let failFailureLatch = true;
    let failFailureSentinel = true;
    const runStore = new MemoryAgentRunStore({
      beforeAgentRunUpdate: async (_sessionId, _runId, patch) => {
        if (patch.traceWriteError && failFailureLatch) {
          failFailureLatch = false;
          throw new Error('trace failure latch update failed');
        }
      },
      beforeAgentRunEventAppend: async (_sessionId, _runId, event) => {
        if (event.type === 'provider_request_attempt_recorded' && failAttemptAppend) {
          failAttemptAppend = false;
          throw new Error('provider attempt append failed');
        }
        if (event.type === 'trace_write_failed' && failFailureSentinel) {
          failFailureSentinel = false;
          throw new Error('trace failure sentinel append failed');
        }
      },
    });
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new ProviderRequestTraceBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_763),
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('completed');
    expect(run?.traceWriteError).toMatch(
      /append provider request attempt: provider attempt append failed/,
    );
    const events = await runStore.readEvents(session.id, run!.runId);
    expect(events.some((event) => event.type === 'trace_write_failed')).toBe(false);
  });

  test('finalizes the run when a required provider capture append fails', async () => {
    const store = new MemorySessionStore();
    let providerDispatches = 0;
    let failCaptureOnce = true;
    const runStore = new MemoryAgentRunStore({
      beforeAgentRunEventAppend: async (_sessionId, _runId, event) => {
        if (event.type === 'provider_request_captured' && failCaptureOnce) {
          failCaptureOnce = false;
          throw new Error('required capture append failed');
        }
      },
    });
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) => new ProviderCaptureGateBackend(ctx, () => (providerDispatches += 1)),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(12_764),
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })).catch(
      () => {},
    );

    expect(providerDispatches).toBe(0);
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('failed');
    expect(run?.completedAt).toBeDefined();
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

    expect(observedEventIds).toContain('cleanup-continuation-text');
    expect(observedEventIds).not.toContain('cleanup-child-text');
  });

  test('shares the latest history compact checkpoint across disposable child backends', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const observedCheckpointIds: Array<string | undefined> = [];
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) => new HistoryCompactCheckpointCacheProbeBackend(ctx, observedCheckpointIds),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(12_795),
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'parent-turn', text: 'hello' }));
    const parentRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'parent-turn',
    );
    if (!parentRun) throw new Error('parent run was not recorded');
    runStore.readEventsCalls = 0;

    for (const turnId of ['child-turn-1', 'child-turn-2']) {
      await drain(
        manager.startChildTurn(session.id, {
          turnId,
          parentRunId: parentRun.runId,
          spec: {
            id: LOCAL_READ_AGENT_ID,
            name: LOCAL_READ_AGENT_DEFINITION.name,
            systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
          },
          prompt: 'inspect the repo',
        }),
      );
    }

    expect(observedCheckpointIds).toEqual([undefined, 'hcheckpoint-shared', 'hcheckpoint-shared']);
    expect(runStore.readEventsCalls).toBe(0);
  });

  test('does not let a stale child checkpoint move the session cache backward', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const observedCoverage: Array<number | undefined> = [];
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) => new HistoryCompactCheckpointMonotonicProbeBackend(ctx, observedCoverage),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(12_796),
    });
    const session = await manager.createSession(makeInput());

    await drain(manager.sendMessage(session.id, { turnId: 'parent-furthest', text: 'hello' }));
    const parentRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'parent-furthest',
    );
    if (!parentRun) throw new Error('parent run was not recorded');

    for (const turnId of ['child-stale', 'child-observe']) {
      await drain(
        manager.startChildTurn(session.id, {
          turnId,
          parentRunId: parentRun.runId,
          spec: {
            id: LOCAL_READ_AGENT_ID,
            name: LOCAL_READ_AGENT_DEFINITION.name,
            systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
          },
          prompt: 'inspect the repo',
        }),
      );
    }

    expect(observedCoverage).toEqual([undefined, 2, 2]);
    const recordedCoverage: number[] = [];
    for (const run of await runStore.listSessionRuns(session.id)) {
      for (const event of await runStore.readEvents(session.id, run.runId)) {
        if (event.type === 'history_compact_checkpoint_recorded') {
          recordedCoverage.push(
            (event.data!.checkpoint as HistoryCompactCheckpoint).coverage.eventCount,
          );
        }
      }
    }
    expect(recordedCoverage).toEqual([2]);
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

    expect(writeOutcomes).toEqual([
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
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[1]?.previousCheckpointId).toBe(checkpoints[0]?.checkpointId);
    expect(checkpoints[1]?.coverage).toEqual(checkpoints[0]?.coverage);
  });

  test('serializes accepted checkpoint persistence across parent and child runs', async () => {
    const store = new MemorySessionStore();
    const parentWriteGate = makeGate();
    const parentWriteStarted = makeGate();
    const childRecorderCalled = makeGate();
    const physicalCoverage: number[] = [];
    const recorderReturnedPromises: boolean[] = [];
    const runStore = new MemoryAgentRunStore({
      beforeAgentRunEventAppend: async (_sessionId, _runId, event) => {
        if (event.type !== 'history_compact_checkpoint_recorded') return;
        const coverage = (event.data!.checkpoint as HistoryCompactCheckpoint).coverage.eventCount;
        if (coverage === 1) {
          parentWriteStarted.release();
          await parentWriteGate.promise;
        }
        physicalCoverage.push(coverage);
      },
    });
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new SerializedCheckpointProbeBackend(ctx, childRecorderCalled, recorderReturnedPromises),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(12_797),
    });
    const session = await manager.createSession(makeInput());

    const parentTurn = drain(
      manager.sendMessage(session.id, { turnId: 'parent-delayed', text: 'hello' }),
    );
    await parentWriteStarted.promise;
    const parentRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'parent-delayed',
    );
    if (!parentRun) throw new Error('parent run was not recorded');
    const childTurn = drain(
      manager.startChildTurn(session.id, {
        turnId: 'child-furthest',
        parentRunId: parentRun.runId,
        spec: {
          id: LOCAL_READ_AGENT_ID,
          name: LOCAL_READ_AGENT_DEFINITION.name,
          systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
        },
        prompt: 'inspect the repo',
      }),
    );
    await childRecorderCalled.promise;
    try {
      expect(recorderReturnedPromises).toEqual([true]);
    } finally {
      parentWriteGate.release();
    }
    await Promise.all([parentTurn, childTurn]);

    expect(physicalCoverage).toEqual([1, 2]);
  });

  test('keeps failed checkpoint writes out of the cache and continues the session write queue', async () => {
    const store = new MemorySessionStore();
    const parentWriteGate = makeGate();
    const parentWriteStarted = makeGate();
    const childRecorderCalled = makeGate();
    const physicalCoverage: number[] = [];
    const observedCoverage: Array<number | undefined> = [];
    const writeOutcomes: string[] = [];
    const runStore = new MemoryAgentRunStore({
      beforeAgentRunEventAppend: async (_sessionId, _runId, event) => {
        if (event.type !== 'history_compact_checkpoint_recorded') return;
        const coverage = (event.data!.checkpoint as HistoryCompactCheckpoint).coverage.eventCount;
        physicalCoverage.push(coverage);
        if (coverage === 1) {
          parentWriteStarted.release();
          await parentWriteGate.promise;
          throw new Error('checkpoint append failed');
        }
      },
    });
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new RecoveringCheckpointWriteProbeBackend(
          ctx,
          childRecorderCalled,
          observedCoverage,
          writeOutcomes,
        ),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(12_798),
    });
    const session = await manager.createSession(makeInput());

    const parentTurn = drain(
      manager.sendMessage(session.id, { turnId: 'parent-failing', text: 'hello' }),
    );
    await parentWriteStarted.promise;
    const parentRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'parent-failing',
    );
    if (!parentRun) throw new Error('parent run was not recorded');
    const childTurn = drain(
      manager.startChildTurn(session.id, {
        turnId: 'child-succeeding',
        parentRunId: parentRun.runId,
        spec: {
          id: LOCAL_READ_AGENT_ID,
          name: LOCAL_READ_AGENT_DEFINITION.name,
          systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
        },
        prompt: 'inspect the repo',
      }),
    );
    await childRecorderCalled.promise;
    parentWriteGate.release();
    await Promise.all([parentTurn, childTurn]);
    await drain(
      manager.startChildTurn(session.id, {
        turnId: 'child-observe',
        parentRunId: parentRun.runId,
        spec: {
          id: LOCAL_READ_AGENT_ID,
          name: LOCAL_READ_AGENT_DEFINITION.name,
          systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
        },
        prompt: 'inspect the repo',
      }),
    );

    expect(observedCoverage).toEqual([undefined, undefined, 2]);
    expect(writeOutcomes).toEqual(['parent-failing:rejected', 'child-succeeding:fulfilled']);
    expect(physicalCoverage).toEqual([1, 2]);
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

    expect(writeOutcomes).toEqual(['store-unavailable:rejected']);
  });

  test('rejects a stale checkpoint candidate while a further checkpoint is in flight', async () => {
    const store = new MemorySessionStore();
    const furthestWriteGate = makeGate();
    const furthestWriteStarted = makeGate();
    const staleRecorderCalled = makeGate();
    const writeOutcomes: string[] = [];
    const physicalCoverage: number[] = [];
    const runStore = new MemoryAgentRunStore({
      beforeAgentRunEventAppend: async (_sessionId, _runId, event) => {
        if (event.type !== 'history_compact_checkpoint_recorded') return;
        const coverage = (event.data!.checkpoint as HistoryCompactCheckpoint).coverage.eventCount;
        physicalCoverage.push(coverage);
        if (coverage === 2) {
          furthestWriteStarted.release();
          await furthestWriteGate.promise;
        }
      },
    });
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new CheckpointRecorderContractProbeBackend(
          ctx,
          async (turnId) => {
            if (turnId === 'child-stale-in-flight') staleRecorderCalled.release();
          },
          writeOutcomes,
        ),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(12_801),
    });
    const session = await manager.createSession(makeInput());

    const parentTurn = drain(
      manager.sendMessage(session.id, { turnId: 'parent-furthest-in-flight', text: 'hello' }),
    );
    await furthestWriteStarted.promise;
    const parentRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'parent-furthest-in-flight',
    );
    if (!parentRun) throw new Error('parent run was not recorded');
    const childTurn = drain(
      manager.startChildTurn(session.id, {
        turnId: 'child-stale-in-flight',
        parentRunId: parentRun.runId,
        spec: {
          id: LOCAL_READ_AGENT_ID,
          name: LOCAL_READ_AGENT_DEFINITION.name,
          systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
        },
        prompt: 'inspect the repo',
      }),
    );
    await staleRecorderCalled.promise;
    furthestWriteGate.release();
    await Promise.all([parentTurn, childTurn]);

    expect(writeOutcomes).toEqual([
      'parent-furthest-in-flight:fulfilled',
      'child-stale-in-flight:rejected',
    ]);
    expect(physicalCoverage).toEqual([2]);
  });

  test('waits for the initial durable checkpoint load before accepting a write', async () => {
    const store = new MemorySessionStore();
    const initialLoadGate = makeGate();
    const initialLoadStarted = makeGate();
    const staleRecorderCalled = makeGate();
    const observedCoverage: Array<number | undefined> = [];
    const writeOutcomes: string[] = [];
    const runStore = new MemoryAgentRunStore({
      beforeAgentRunEventRead: async (_sessionId, runId) => {
        if (runId !== 'seed-checkpoint-run') return;
        initialLoadStarted.release();
        await initialLoadGate.promise;
      },
    });
    const backends = new BackendRegistry();
    backends.register(
      'ai-sdk',
      (ctx) =>
        new InitialCheckpointLoadRaceProbeBackend(
          ctx,
          staleRecorderCalled,
          observedCoverage,
          writeOutcomes,
        ),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      childTools: [testTool('Read'), testTool('Glob'), testTool('Grep')],
      newId: nextId(),
      now: nextNow(12_802),
    });
    const session = await manager.createSession(makeInput());
    const durableCheckpoint = buildHistoryCompactCheckpoint({
      sessionId: session.id,
      coveredRuntimeEvents: Array.from(
        { length: 10 },
        (_, index): RuntimeEvent => ({
          id: `durable-source-event-${index}`,
          sessionId: session.id,
          runId: `durable-source-run-${index}`,
          turnId: `durable-source-turn-${index}`,
          invocationId: `durable-source-invocation-${index}`,
          ts: index + 1,
          partial: false,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: `source ${index}` },
        }),
      ),
      summary: 'durable checkpoint',
      summaryFormat: 'legacy_freeform',
    });
    await seedRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'seed-checkpoint-run',
        turnId: 'seed-checkpoint-turn',
        status: 'completed',
      }),
      [
        makeRunEvent({
          sessionId: session.id,
          runId: 'seed-checkpoint-run',
          turnId: 'seed-checkpoint-turn',
          type: 'history_compact_checkpoint_recorded',
          ts: 1,
          data: { checkpoint: durableCheckpoint },
        }),
      ],
    );

    const parentTurn = drain(
      manager.sendMessage(session.id, { turnId: 'parent-initial-load', text: 'hello' }),
    );
    await initialLoadStarted.promise;
    const parentRun = (await runStore.listSessionRuns(session.id)).find(
      (run) => run.turnId === 'parent-initial-load',
    );
    if (!parentRun) throw new Error('parent run was not recorded');
    const childTurn = drain(
      manager.startChildTurn(session.id, {
        turnId: 'child-stale-during-load',
        parentRunId: parentRun.runId,
        spec: {
          id: LOCAL_READ_AGENT_ID,
          name: LOCAL_READ_AGENT_DEFINITION.name,
          systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
        },
        prompt: 'inspect the repo',
      }),
    );
    await staleRecorderCalled.promise;
    initialLoadGate.release();
    await Promise.all([parentTurn, childTurn]);

    expect(observedCoverage).toEqual([10]);
    expect(writeOutcomes).toEqual(['child-stale-during-load:rejected']);
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
    expect(checkpointCoverage).toEqual([10]);
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

    expect(writeOutcomes).toEqual(['cold-stale-after-projection-loss:rejected']);
    expect(runStore.repairedProjection?.id).toBe(durableEvent.id);
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
    expect(checkpointCoverage).toEqual([10]);
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

    expect(recovered).toEqual([running.id, waiting.id, activeStuck.id, failedThenCompleted.id]);
    expect((await store.readHeader(running.id)).status).toBe('active');
    expect((await store.readHeader(waiting.id)).status).toBe('active');
    expect((await store.readHeader(activeStuck.id)).status).toBe('active');
    expect((await store.readHeader(failedThenCompleted.id)).status).toBe('active');
    expect((await store.readHeader(activeDone.id)).status).toBe('active');
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
    expect(runningTurn?.status).toBe('failed');
    expect(runningTurn?.errorClass).toBe('app_restarted');
    expect(waitingTurn?.status).toBe('failed');
    expect(waitingTurn?.errorClass).toBe('app_restarted');
    expect(activeStuckTurn?.status).toBe('failed');
    expect(activeStuckTurn?.errorClass).toBe('app_restarted');
    expect(failedThenCompletedTurn?.status).toBe('failed');
    expect(failedThenCompletedTurn?.errorClass).toBe('tool_failed');
    expect(activeTurn?.status).toBe('completed');
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

    expect((await store.readHeader(session.id)).status).toBe('active');
    const [turn] = await store.listTurns(session.id);
    expect(turn?.status).toBe('failed');
    // This turn owned the pending request, so its failure names the closure
    // rather than the bare restart.
    expect(turn?.errorClass).toBe('sandbox_boundary_closed_by_restart');
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('failed');
    expect(run?.failureClass).toBe('sandbox_boundary_closed_by_restart');
    expect(await store.listPendingSandboxBoundaryRequests(session.id)).toEqual([]);
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
    expect(turn?.errorClass).toBe('app_restarted');
  });

  test('branchFromTurn marks side conversations without changing ordinary branches', async () => {
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
      now: nextNow(15_500),
    });
    const session = await manager.createSession(makeInput({ name: 'Parent', labels: ['kept'] }));
    await drain(manager.sendMessage(session.id, { turnId: 'source', text: 'context' }));

    const ordinary = await manager.branchFromTurn(session.id, {
      sourceTurnId: 'source',
      name: 'Ordinary',
    });
    const side = await manager.branchFromTurn(session.id, {
      sourceTurnId: 'source',
      name: 'Side',
      sideConversation: true,
    });

    expect(ordinary.labels).toEqual(['kept']);
    expect(side.labels).toEqual(['kept', SIDE_CONVERSATION_SESSION_LABEL]);
  });

  test('conversation copies inherit the authoritative execution boundary', async () => {
    const store = new AtomicBoundaryMemorySessionStore();
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
      now: nextNow(15_050),
    });
    const boundaries: ExecutionBoundary[] = [
      {
        kind: 'managed',
        revision: 4,
        profile: applySandboxBoundaryExpansion(createWorkspaceWritePermissionProfile(), {
          filesystem: {
            entries: [{ path: '/approved/release.txt', access: 'write', scope: 'exact' }],
          },
        }),
      },
      { kind: 'external', revision: 3 },
    ];

    for (const [index, boundary] of boundaries.entries()) {
      const source = await manager.createSession(makeInput({ name: `Source ${index}` }));
      await drain(manager.sendMessage(source.id, { turnId: 'first', text: 'keep' }));
      await drain(manager.sendMessage(source.id, { turnId: 'second', text: 'replace' }));
      store.forceBoundary(source.id, boundary);

      const branch = await manager.branchFromTurn(source.id, { sourceTurnId: 'first' });
      const revision = await manager.reviseBeforeTurn(source.id, { sourceTurnId: 'second' });

      for (const copy of [branch, revision]) {
        expect(await store.readExecutionBoundary(copy.id)).toEqual({
          ...boundary,
          revision: 0,
        });
      }
    }
  });

  test('branch and revision sessions rewrite tool operation authority facts', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(15_100),
    });
    const session = await manager.createSession(makeInput({ name: 'Authority source' }));
    const header = await store.readHeader(session.id);
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'authority-source-run',
        turnId: 'authority-source-turn',
        status: 'completed',
        cwd: header.cwd,
        createdAt: 1,
        updatedAt: 3,
        completedAt: 3,
      }),
      [
        runtimeEvent({
          id: 'authority-source-user',
          sessionId: session.id,
          invocationId: 'authority-source-invocation',
          runId: 'authority-source-run',
          turnId: 'authority-source-turn',
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'authority-bearing history' },
        }),
        runtimeEvent({
          id: 'authority-source-dispatch',
          sessionId: session.id,
          invocationId: 'authority-source-invocation',
          runId: 'authority-source-run',
          turnId: 'authority-source-turn',
          ts: 2,
          role: 'system',
          author: 'system',
          actions: {
            toolDispatch: {
              protocol: 't1_after_preflight_v1',
              operationId: 'authority-operation',
              providerToolCallId: 'authority-call',
              toolName: 'Write',
              canonicalArgsHash: `sha256:${'a'.repeat(64)}`,
              recoveryMode: 'reconcile',
            },
          },
          refs: { toolCallId: 'authority-call', operationId: 'authority-operation' },
        }),
        runtimeEvent({
          id: 'authority-source-terminal',
          sessionId: session.id,
          invocationId: 'authority-source-invocation',
          runId: 'authority-source-run',
          turnId: 'authority-source-turn',
          ts: 3,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'authority-later-run',
        turnId: 'authority-later-turn',
        status: 'completed',
        cwd: header.cwd,
        createdAt: 4,
        updatedAt: 5,
        completedAt: 5,
      }),
      [
        runtimeEvent({
          id: 'authority-later-user',
          sessionId: session.id,
          invocationId: 'authority-later-invocation',
          runId: 'authority-later-run',
          turnId: 'authority-later-turn',
          ts: 4,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'later boundary' },
        }),
        runtimeEvent({
          id: 'authority-later-terminal',
          sessionId: session.id,
          invocationId: 'authority-later-invocation',
          runId: 'authority-later-run',
          turnId: 'authority-later-turn',
          ts: 5,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );

    const copies = [
      await manager.branchFromTurn(session.id, {
        sourceTurnId: 'authority-source-turn',
        name: 'Tool branch',
      }),
      await manager.branchBeforeTurn(session.id, {
        sourceTurnId: 'authority-later-turn',
        name: 'Tool branch before later turn',
      }),
      await manager.reviseBeforeTurn(session.id, {
        sourceTurnId: 'authority-later-turn',
      }),
    ];
    for (const copy of copies) {
      const [targetRun] = await runStore.listSessionRuns(copy.id);
      assert.ok(targetRun);
      const targetEvents = await runStore.readRuntimeEvents(copy.id, targetRun.runId);
      const dispatch = targetEvents.find((event) => event.actions?.toolDispatch);
      const targetOperationId = dispatch?.actions?.toolDispatch?.operationId;
      assert.ok(targetOperationId);
      assert.notEqual(targetOperationId, 'authority-operation');
      assert.equal(dispatch?.refs?.operationId, targetOperationId);
      assert.equal(targetRun.sessionId, copy.id);
    }
  });

  test('fails before creating branch or revision sessions for child continuation authority', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(15_150),
    });
    const session = await manager.createSession(makeInput({ name: 'Legacy continuation' }));
    const header = await store.readHeader(session.id);
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'continuation-parent-run',
        turnId: 'continuation-parent-turn',
        status: 'completed',
        cwd: header.cwd,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
      }),
      [
        runtimeEvent({
          id: 'continuation-parent-user',
          sessionId: session.id,
          invocationId: 'continuation-parent-invocation',
          runId: 'continuation-parent-run',
          turnId: 'continuation-parent-turn',
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'retain parent and child closure' },
        }),
        runtimeEvent({
          id: 'continuation-parent-terminal',
          sessionId: session.id,
          invocationId: 'continuation-parent-invocation',
          runId: 'continuation-parent-run',
          turnId: 'continuation-parent-turn',
          ts: 2,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'legacy-continuation-run',
        turnId: 'legacy-child-turn',
        parentRunId: 'continuation-parent-run',
        agentId: 'child-agent',
        status: 'completed',
        cwd: header.cwd,
        continuationSource: {
          sourceInvocationId: 'legacy-source-invocation',
          sourceRunId: 'legacy-source-run',
          sourceTurnId: 'legacy-source-turn',
          sourceRuntimeEventHighWater: 1,
        },
        createdAt: 3,
        updatedAt: 4,
        completedAt: 4,
      }),
      [
        runtimeEvent({
          id: 'legacy-continuation-user',
          sessionId: session.id,
          invocationId: 'legacy-continuation-run',
          runId: 'legacy-continuation-run',
          turnId: 'legacy-child-turn',
          ts: 3,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'legacy continuation history' },
        }),
        runtimeEvent({
          id: 'legacy-continuation-terminal',
          sessionId: session.id,
          invocationId: 'legacy-continuation-run',
          runId: 'legacy-continuation-run',
          turnId: 'legacy-child-turn',
          ts: 4,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: session.id,
        runId: 'continuation-later-run',
        turnId: 'continuation-later-turn',
        status: 'completed',
        cwd: header.cwd,
        createdAt: 5,
        updatedAt: 6,
        completedAt: 6,
      }),
      [
        runtimeEvent({
          id: 'continuation-later-user',
          sessionId: session.id,
          invocationId: 'continuation-later-invocation',
          runId: 'continuation-later-run',
          turnId: 'continuation-later-turn',
          ts: 5,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'later boundary' },
        }),
        runtimeEvent({
          id: 'continuation-later-terminal',
          sessionId: session.id,
          invocationId: 'continuation-later-invocation',
          runId: 'continuation-later-run',
          turnId: 'continuation-later-turn',
          ts: 6,
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );

    const attempts = [
      () =>
        manager.branchFromTurn(session.id, {
          sourceTurnId: 'continuation-parent-turn',
          name: 'Blocked child continuation branch',
        }),
      () =>
        manager.branchBeforeTurn(session.id, {
          sourceTurnId: 'continuation-later-turn',
          name: 'Blocked child continuation branch before',
        }),
      () =>
        manager.reviseBeforeTurn(session.id, {
          sourceTurnId: 'continuation-later-turn',
        }),
    ];
    for (const attempt of attempts) {
      await expectRejects(attempt(), /typed identity rewriting/i);
    }
    expect((await store.list()).map((candidate) => candidate.id)).toEqual([session.id]);
  });

  test('hydrates an inherited running ShellRun with its source-session owner', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    const ref = 'maka://runtime/background-tasks/pty-parent';
    const sourceSnapshot: ShellRunSnapshotResult = {
      kind: 'shell_run',
      ref,
      mode: 'pty',
      status: 'running',
      cwd: '/tmp/workspace',
      cmd: 'interactive',
      startedAt: 1,
      updatedAt: 2,
      revision: 2,
      output: {
        mode: 'pty',
        screen: 'ready',
        scrollback: '',
        cols: 80,
        rows: 24,
        cursor: { x: 5, y: 0, visible: true },
        alternateScreen: false,
        truncated: false,
        redacted: false,
      },
    };
    let ownerAvailable = true;
    const shellRuns = {
      async listSessionUpdates() {
        return [];
      },
      async getSessionUpdate() {
        return undefined;
      },
      async inspectResource(sessionId: string, candidateRef: string) {
        if (ownerAvailable && candidateRef === ref && sessionId === 'session-1')
          return sourceSnapshot;
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    } as unknown as ShellRunProcessManager;
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      shellRuns,
      newId: nextId(),
      now: nextNow(15_250),
    });
    const parent = await manager.createSession(makeInput({ name: 'Parent' }));
    await seedRuntimeRun(
      runStore,
      makeRunHeader({
        sessionId: parent.id,
        runId: 'source-run',
        turnId: 'source',
        status: 'completed',
        createdAt: 1,
        updatedAt: 4,
        completedAt: 4,
      }),
      [
        runtimeEvent({
          id: 'user-1',
          sessionId: parent.id,
          runId: 'source-run',
          turnId: 'source',
          ts: 1,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'start' },
        }),
        runtimeEvent({
          id: 'call-1',
          sessionId: parent.id,
          runId: 'source-run',
          turnId: 'source',
          ts: 2,
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'bash-1',
            name: 'Bash',
            args: { command: 'interactive', run_in_background: true, pty: true },
          },
          refs: { toolCallId: 'bash-1' },
        }),
        runtimeEvent({
          id: 'result-1',
          sessionId: parent.id,
          runId: 'source-run',
          turnId: 'source',
          ts: 3,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'bash-1',
            name: 'Bash',
            result: {
              kind: 'shell_run',
              ref,
              mode: 'pty',
              status: 'running',
              cwd: '/tmp/workspace',
              cmd: 'interactive',
              startedAt: 1,
              updatedAt: 1,
              revision: 1,
            },
            isError: false,
          },
          refs: { toolCallId: 'bash-1' },
        }),
        runtimeEvent({
          id: 'complete-1',
          sessionId: parent.id,
          runId: 'source-run',
          turnId: 'source',
          ts: 4,
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
        sessionId: parent.id,
        runId: 'later-run',
        turnId: 'later',
        status: 'completed',
        createdAt: 5,
        updatedAt: 6,
        completedAt: 6,
      }),
      [
        runtimeEvent({
          id: 'later-user',
          sessionId: parent.id,
          runId: 'later-run',
          turnId: 'later',
          ts: 5,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'later' },
        }),
        runtimeEvent({
          id: 'later-complete',
          sessionId: parent.id,
          runId: 'later-run',
          turnId: 'later',
          ts: 6,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ],
    );
    const child = await manager.branchFromTurn(parent.id, {
      sourceTurnId: 'source',
      name: 'Child',
    });
    const revision = await manager.reviseBeforeTurn(parent.id, { sourceTurnId: 'later' });

    const updates = await manager.listShellRunUpdates(child.id);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.sessionId).toBe(child.id);
    expect(updates[0]?.ownership).toEqual({
      kind: 'source_owned',
      sourceSessionId: parent.id,
      ownerSessionId: parent.id,
    });
    expect(updates[0]?.sourceToolCallId).toBe('bash-1');
    expect(updates[0]?.result).toEqual(sourceSnapshot);
    expect(await manager.getShellRunUpdate(child.id, sourceSnapshot.ref)).toEqual(updates[0]);
    expect(
      await manager.getShellRunUpdate(child.id, 'maka://runtime/background-tasks/missing-shell'),
    ).toBeNull();

    const revisionUpdates = await manager.listShellRunUpdates(revision.id);
    expect(revisionUpdates).toHaveLength(1);
    expect(revisionUpdates[0]?.ownership).toEqual({
      kind: 'source_owned',
      sourceSessionId: parent.id,
      ownerSessionId: parent.id,
    });
    expect(revisionUpdates[0]?.result).toEqual(sourceSnapshot);

    ownerAvailable = false;
    await store.remove(parent.id);
    const danglingUpdates = await manager.listShellRunUpdates(child.id);
    expect(danglingUpdates).toHaveLength(1);
    expect(danglingUpdates[0]?.sessionId).toBe(child.id);
    expect(danglingUpdates[0]?.ownership).toEqual({
      kind: 'source_unavailable',
      sourceSessionId: parent.id,
    });
    expect(danglingUpdates[0]?.result.status).toBe('running');
    expect(danglingUpdates[0]?.result.output).toBe(undefined);
    expect(await manager.getShellRunUpdate(child.id, sourceSnapshot.ref)).toEqual(
      danglingUpdates[0],
    );
  });

  test('reviseBeforeTurn creates an in-conversation version without ordinary branch lineage', async () => {
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
      now: nextNow(16_700),
    });
    const session = await manager.createSession(
      makeInput({
        name: 'Conversation',
        projectId: 'project-1',
        collaborationMode: 'plan',
        orchestrationMode: 'swarm',
      }),
    );
    await manager.setFlagged(session.id, true);
    await drain(manager.sendMessage(session.id, { turnId: 'first', text: 'keep me' }));
    await drain(manager.sendMessage(session.id, { turnId: 'second', text: 'replace me' }));

    const version2 = await manager.reviseBeforeTurn(session.id, { sourceTurnId: 'second' });

    expect(version2.name).toBe('Conversation');
    expect(version2.projectId).toBe('project-1');
    expect(version2.isFlagged).toBe(true);
    expect(version2.collaborationMode).toBe('plan');
    expect(version2.orchestrationMode).toBe('swarm');
    expect(version2.parentSessionId).toBeUndefined();
    expect(version2.branchOfTurnId).toBeUndefined();
    expect(version2.revisionRootSessionId).toBe(session.id);
    expect(version2.revisionParentSessionId).toBe(session.id);
    expect(version2.revisionOfTurnId).toBe('second');
    expect(version2.revisionIndex).toBe(2);
    expect(version2.revisionState).toBe('preparing');
    expect((await store.readHeader(version2.id)).collaborationMode).toBe('plan');
    expect((await store.readHeader(version2.id)).orchestrationMode).toBe('swarm');
    await drain(
      manager.sendMessage(
        version2.id,
        { turnId: 'edited-second', text: 'replacement' },
        {
          onRunStarted: async () => {
            await manager.commitRevisionVersion(version2.id);
          },
        },
      ),
    );
    expect((await store.readHeader(version2.id)).revisionState).toBe('committed');
    const messages = await store.readMessages(version2.id);
    expect(messages.some((message) => (message as { turnId?: string }).turnId === 'first')).toBe(
      true,
    );
    expect(messages.some((message) => (message as { turnId?: string }).turnId === 'second')).toBe(
      false,
    );

    const version3 = await manager.reviseBeforeTurn(version2.id, { sourceTurnId: 'first' });
    expect(version3.projectId).toBe('project-1');
    expect(version3.revisionRootSessionId).toBe(session.id);
    expect(version3.revisionParentSessionId).toBe(version2.id);
    expect(version3.revisionIndex).toBe(3);
    expect(version3.revisionState).toBe('preparing');
    expect(version3.parentSessionId).toBeUndefined();
  });

  test('startup recovery removes empty preparing revisions and commits admitted edits', async () => {
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
      now: nextNow(16_900),
    });
    const root = await manager.createSession(makeInput({ name: 'Recovery root' }));
    await drain(manager.sendMessage(root.id, { turnId: 'first', text: 'original' }));

    const empty = await manager.reviseBeforeTurn(root.id, { sourceTurnId: 'first' });
    expect(empty.revisionState).toBe('preparing');
    await manager.recoverInterruptedSessions();
    let removedError: unknown;
    try {
      await store.readHeader(empty.id);
    } catch (error) {
      removedError = error;
    }
    expect(removedError instanceof Error ? removedError.message : String(removedError)).toContain(
      'Unknown session',
    );

    const admitted = await manager.reviseBeforeTurn(root.id, { sourceTurnId: 'first' });
    await drain(manager.sendMessage(admitted.id, { turnId: 'edited', text: 'edited prompt' }));
    expect((await store.readHeader(admitted.id)).revisionState).toBe('preparing');
    await manager.recoverInterruptedSessions();
    expect((await store.readHeader(admitted.id)).revisionState).toBe('committed');
  });

  test('branchBeforeTurn rejects an unknown turn', async () => {
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
      now: nextNow(16_800),
    });
    const session = await manager.createSession(makeInput({ name: 'Parent' }));
    await drain(manager.sendMessage(session.id, { turnId: 'only', text: 'the one prompt' }));

    let branchError: unknown;
    try {
      await manager.branchBeforeTurn(session.id, { sourceTurnId: 'nope' });
    } catch (error) {
      branchError = error;
    }
    expect(branchError instanceof Error ? branchError.message : String(branchError)).toContain(
      'Cannot branch before unknown turn',
    );
  });
});

describe('SessionManager steering and followup queues', () => {
  function steeringManager() {
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
      now: nextNow(1_000),
    });
    return { manager, store };
  }

  // Run a turn and invoke `duringFirstDelta` synchronously the first time the
  // turn streams text — the point at which a real user would type while the
  // agent works. Returns every streamed event.
  async function runTurnWith(
    manager: SessionManager,
    sessionId: string,
    turnId: string,
    duringFirstDelta: () => void,
  ): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    let fired = false;
    for await (const event of manager.sendMessage(sessionId, { turnId, text: 'hello' })) {
      events.push(event);
      if (!fired && event.type === 'text_delta') {
        fired = true;
        duringFirstDelta();
      }
    }
    return events;
  }

  test('hosted root runs consume the Host owner and release it exactly once', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new FakeBackend(ctx));
    const identities: RuntimeMessageRunIdentity[] = [];
    const acked: string[] = [];
    const nacked: string[] = [];
    let pulled = false;
    let releases = 0;
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(1_000),
      messageAuthority: {
        bindRun: (identity) => {
          identities.push(identity);
          return {
            ...identity,
            pull: () => {
              if (pulled) return [];
              pulled = true;
              return [
                {
                  id: 'host-lease-1',
                  messageId: 'host-message-1',
                  content: { text: 'host steer', displayText: 'visible host steer' },
                },
              ];
            },
            ack: (leaseIds) => acked.push(...leaseIds),
            nack: (leaseIds) => nacked.push(...leaseIds),
            release: () => {
              releases += 1;
            },
          };
        },
      },
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    const events = await drainAll(
      manager.sendMessage(session.id, { turnId: 'turn-host-message', text: 'start' }),
    );
    const [run] = await runStore.listSessionRuns(session.id);
    expect(identities).toEqual([
      { sessionId: session.id, turnId: 'turn-host-message', runId: run?.runId },
    ]);
    expect(acked).toEqual(['host-lease-1']);
    expect(nacked).toEqual([]);
    expect(releases).toBe(1);
    expect(
      events.some(
        (event) =>
          event.type === 'steering_message' &&
          event.messageId === 'host-message-1' &&
          event.content.displayText === 'visible host steer',
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === 'queue_update')).toBe(false);
    for (const operation of [
      () => manager.steer(session.id, 'runtime mirror'),
      () => manager.queueMessage(session.id, 'runtime mirror'),
      () => manager.drainFollowup(session.id),
      () => manager.retractQueue(session.id),
    ]) {
      let error: unknown;
      try {
        operation();
      } catch (caught) {
        error = caught;
      }
      expect(error instanceof RuntimeMessageAuthorityInvariantError).toBe(true);
    }
  });

  test('hosted Interaction binds the durable Run identity and closes before release', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new FakeBackend(ctx));
    const identities: RuntimeInteractionRunIdentity[] = [];
    const lifecycle: string[] = [];
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(1_000),
      interactionAuthority: {
        bindRun: (identity) => {
          identities.push(identity);
          return {
            ...identity,
            acceptSandboxBoundaryRequest: async () => {},
            acceptUserQuestionRequest: async () => {},
            close: async (reason) => {
              lifecycle.push(`close:${reason}`);
            },
            release: () => lifecycle.push('release'),
          };
        },
      },
      canonicalPermissionOutcomes: noCanonicalPermissionOutcomes,
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    await drainAll(
      manager.sendMessage(session.id, { turnId: 'turn-host-interaction', text: 'go' }),
    );
    const [run] = await runStore.listSessionRuns(session.id);
    expect(identities).toEqual([
      { sessionId: session.id, turnId: 'turn-host-interaction', runId: run?.runId },
    ]);
    expect(lifecycle).toEqual(['close:turn_terminal', 'release']);
  });

  test('hosted stopped question abandonment preserves stop closure before release', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new FakeBackend(ctx));
    const lifecycle: string[] = [];
    let question: RuntimeUserQuestionContinuation | undefined;
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(1_000),
      interactionAuthority: {
        bindRun: (identity) => ({
          ...identity,
          acceptSandboxBoundaryRequest: async () => {},
          acceptUserQuestionRequest: async ({ continuation }) => {
            question = continuation;
          },
          close: async (reason) => {
            lifecycle.push(`close:${reason}`);
            await question?.applyClosure(reason);
            lifecycle.push('local-settled');
          },
          release: () => lifecycle.push('release'),
        }),
      },
      canonicalPermissionOutcomes: noCanonicalPermissionOutcomes,
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));
    const iterator = manager
      .sendMessage(session.id, {
        turnId: 'turn-host-question-abandoned',
        text: FAKE_ASK_USER_QUESTION_PROMPT,
      })
      [Symbol.asyncIterator]();

    let request: SessionEvent | undefined;
    while (request?.type !== 'user_question_request') {
      const next = await iterator.next();
      if (next.done) break;
      request = next.value;
    }
    expect(request?.type).toBe('user_question_request');
    await manager.stopSession(session.id, { source: 'stop_button' });
    expect(lifecycle).toEqual(['close:turn_stopped', 'local-settled']);
    await iterator.return?.(undefined);
    expect(lifecycle).toEqual(['close:turn_stopped', 'local-settled', 'release']);
  });

  test('hosted RuntimeKernel rejects a backend request without an admission receipt', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new UnadmittedQuestionBackend(ctx));
    let releases = 0;
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(1_000),
      interactionAuthority: {
        bindRun: (identity) => ({
          ...identity,
          acceptSandboxBoundaryRequest: async () => {},
          acceptUserQuestionRequest: async () => {},
          close: async () => {},
          release: () => {
            releases += 1;
          },
        }),
      },
      canonicalPermissionOutcomes: noCanonicalPermissionOutcomes,
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'ask' }));

    let failure: unknown;
    try {
      await drainAll(manager.sendMessage(session.id, { turnId: 'turn-forged', text: 'start' }));
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof RuntimeInteractionInvariantError).toBe(true);
    expect(releases).toBe(1);
  });

  test('hosted owner is released when backend execution fails', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new ThrowBeforeTerminalBackend(ctx));
    let releases = 0;
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(1_000),
      messageAuthority: {
        bindRun: (identity) => ({
          ...identity,
          pull: () => [],
          ack: () => {},
          nack: () => {},
          release: () => {
            releases += 1;
          },
        }),
      },
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    let failure: unknown;
    try {
      await drainAll(
        manager.sendMessage(session.id, { turnId: 'turn-host-failed', text: 'start' }),
      );
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).toBe('backend failed before terminal');
    expect(releases).toBe(1);
  });

  test('a failed turn begin never leaks a steering owner', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let failBuilds = 1;
    backends.register('ai-sdk', (ctx) => {
      if (failBuilds > 0) {
        failBuilds -= 1;
        throw new Error('backend build failed');
      }
      return new FakeBackend(ctx);
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(1_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    let failed: unknown;
    try {
      for await (const _event of manager.sendMessage(session.id, {
        turnId: 'turn-fail',
        text: 'hello',
      })) {
        // drain
      }
    } catch (error) {
      failed = error;
    }
    expect((failed as Error).message).toBe('backend build failed');

    // The failed begin must not have left a live owner: steering falls back
    // instead of queueing a message no run will ever consume.
    expect(manager.steer(session.id, 'orphaned')).toEqual({ kind: 'fallback' });
    expect(manager.queueMessage(session.id, 'orphaned too')).toEqual({ kind: 'fallback' });

    // A later successful turn establishes ownership normally.
    let outcome: QueueEnqueueOutcome | undefined;
    const events = await runTurnWith(manager, session.id, 'turn-2', () => {
      outcome = manager.steer(session.id, 'now consumed');
    });
    expect(outcome?.kind).toBe('queued');
    expect(
      events.some(
        (event) => event.type === 'steering_message' && event.content.text === 'now consumed',
      ),
    ).toBe(true);
  });

  test('an overlapping turn cannot drain steering queued for the current owner', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: GatedSteeringBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new GatedSteeringBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(1_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    const first = drainAll(manager.sendMessage(session.id, { turnId: 'turn-a', text: 'first' }));
    await waitUntil(() => backend?.gates.has('turn-a') === true);
    const second = drainAll(manager.sendMessage(session.id, { turnId: 'turn-b', text: 'second' }));
    await waitUntil(() => backend?.gates.has('turn-b') === true);

    // turn-b established ownership last, so the steer targets it.
    expect(manager.steer(session.id, 'for the owner').kind).toBe('queued');

    // The stale turn's pull hook fails the identity check and drains nothing.
    backend?.release('turn-a');
    const firstEvents = await first;
    expect(backend?.pulls.get('turn-a')).toEqual([[]]);
    expect(firstEvents.some((event) => event.type === 'steering_message')).toBe(false);

    // The owner drains exactly the queued message.
    backend?.release('turn-b');
    const secondEvents = await second;
    expect(backend?.pulls.get('turn-b')).toEqual([['for the owner']]);
    expect(
      secondEvents.some(
        (event) => event.type === 'steering_message' && event.content.text === 'for the owner',
      ),
    ).toBe(true);
  });

  test('a pulled lease is past the retract point: retract excludes it and it delivers exactly once', async () => {
    // Round-5 F1/D1: pull() is the single atomic commit point. Once leased,
    // the message belongs to this turn's delivery — a retract during the
    // (slow) durable append returns only still-queued text, never the
    // in-flight lease; otherwise the retracted text would ALSO be executed by
    // the provider once the append lands (refill + execute = two copies).
    const gate = makeGate();
    const parked = makeGate();
    class GatedRuntimeEventStore extends MemoryAgentRunStore {
      override async appendRuntimeEvent(
        sessionId: string,
        runId: string,
        event: RuntimeEvent,
      ): Promise<void> {
        if (
          event.content?.kind === 'text' &&
          (event.content as { steering?: boolean }).steering === true
        ) {
          parked.release();
          await gate.promise;
        }
        return super.appendRuntimeEvent(sessionId, runId, event);
      }
    }
    const runStore = new GatedRuntimeEventStore();
    const model = steeringToolThenDoneModel();
    const { manager, session } = await steeringDeliverySession(
      runStore,
      model,
      (manager, sessionId) => {
        expect(manager.steer(sessionId, 'urgent steer').kind).toBe('queued');
      },
    );

    const turnEvents: SessionEvent[] = [];
    const turn = (async () => {
      for await (const event of manager.sendMessage(session.id, { turnId: 'turn-1', text: 'go' })) {
        turnEvents.push(event);
      }
    })();
    await parked.promise;
    // The steering append has not committed: the next provider request must
    // not have started while the message is not durable.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(model.doStreamCalls.length).toBe(1);
    // Pulled means committed to this turn: retract returns nothing.
    expect(manager.retractQueue(session.id)).toBe('');
    gate.release();
    await turn;
    // The message delivered exactly once: in the next provider request…
    expect(model.doStreamCalls.length).toBe(2);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt).includes('urgent steer')).toBe(true);
    // …echoed once in the stream/ledger…
    expect(turnEvents.filter((event) => event.type === 'steering_message').length).toBe(1);
    // …and owned by no queue afterwards.
    expect(manager.drainFollowup(session.id)).toBe(null);
    expect(manager.retractQueue(session.id)).toBe('');
  });

  test('an abort never converts a durably appended steering message into a redelivery', async () => {
    // Round-5 F1/D3: abort does not settle a pushed lease — settlement is
    // decided only by the persistence fact. Here the append is parked when
    // the stop arrives; once it commits, the message belongs to the ledger
    // (history replay presents it to the next turn) and must NOT also be
    // nacked into the followup queue, which would put the same directive in
    // the account twice.
    const gate = makeGate();
    const parked = makeGate();
    class GatedRuntimeEventStore extends MemoryAgentRunStore {
      override async appendRuntimeEvent(
        sessionId: string,
        runId: string,
        event: RuntimeEvent,
      ): Promise<void> {
        if (
          event.content?.kind === 'text' &&
          (event.content as { steering?: boolean }).steering === true
        ) {
          parked.release();
          await gate.promise;
        }
        return super.appendRuntimeEvent(sessionId, runId, event);
      }
    }
    const runStore = new GatedRuntimeEventStore();
    const model = steeringToolThenDoneModel();
    const { manager, session } = await steeringDeliverySession(
      runStore,
      model,
      (manager, sessionId) => {
        expect(manager.steer(sessionId, 'urgent steer').kind).toBe('queued');
      },
    );

    const turn = (async () => {
      try {
        for await (const _event of manager.sendMessage(session.id, {
          turnId: 'turn-1',
          text: 'go',
        })) {
          // drain
        }
      } catch {
        // the abort may end the stream abruptly
      }
    })();
    await parked.promise;
    void manager.stopSession(session.id, { source: 'stop_button' });
    // Let the abort reach the backend's durability wait while the append is
    // still parked — the exact window where an abort-settles-the-lease bug
    // nacks a message that then also commits to the ledger.
    await new Promise((resolve) => setTimeout(resolve, 25));
    gate.release();
    // Teardown converges: the parked append commits, the lease settles, and
    // the aborted send terminates without hanging.
    await turn;

    // The dying request was never sent…
    expect(model.doStreamCalls.length).toBe(1);
    // …the ledger owns the message (exactly one durable steering event)…
    const runs = await runStore.listSessionRuns(session.id);
    const steeringEvents: RuntimeEvent[] = [];
    for (const run of runs) {
      const events = await runStore.readRuntimeEvents(session.id, run.runId);
      steeringEvents.push(
        ...events.filter(
          (event) =>
            event.content?.kind === 'text' &&
            (event.content as { steering?: boolean }).steering === true,
        ),
      );
    }
    expect(steeringEvents.length).toBe(1);
    // …and no queue redelivers it.
    expect(manager.drainFollowup(session.id)).toBe(null);
    expect(manager.retractQueue(session.id)).toBe('');
  });

  test('a nack that lands after the owner released folds into the followup queue, not an ownerless steering queue', async () => {
    // Round-5 F3: turn A's append fails only after turn B took over and
    // released. A's nack can no longer target A (it will never pull again) —
    // the text's only safe home is the followup queue, exactly where a
    // release-time fold would have put it.
    const gate = makeGate();
    const parked = makeGate();
    class ParkThenFailStore extends MemoryAgentRunStore {
      override async appendRuntimeEvent(
        sessionId: string,
        runId: string,
        event: RuntimeEvent,
      ): Promise<void> {
        if (
          event.content?.kind === 'text' &&
          (event.content as { steering?: boolean }).steering === true
        ) {
          parked.release();
          await gate.promise;
          throw new Error('steering append failed');
        }
        return super.appendRuntimeEvent(sessionId, runId, event);
      }
    }
    const runStore = new ParkThenFailStore();
    const model = steeringToolThenDoneModel();
    const { manager, session } = await steeringDeliverySession(
      runStore,
      model,
      (manager, sessionId) => {
        manager.steer(sessionId, 'urgent steer');
      },
    );

    const turnA = (async () => {
      try {
        for await (const _event of manager.sendMessage(session.id, {
          turnId: 'turn-1',
          text: 'go',
        })) {
          // drain
        }
      } catch {
        // the failed append ends the stream abruptly
      }
    })();
    await parked.promise;
    // Turn B takes ownership and releases it while A is parked.
    for await (const _event of manager.sendMessage(session.id, {
      turnId: 'turn-2',
      text: 'second',
    })) {
      // drain
    }
    gate.release();
    await turnA;

    // The failed message is redeliverable exactly once, via followup.
    expect(manager.drainFollowup(session.id)).toBe('urgent steer');
    expect(manager.retractQueue(session.id)).toBe('');
  });

  test('steer falls back when no RuntimeEventStore is configured', async () => {
    // Round-5 F4: without a runtime event ledger, the steering durability ack
    // has nothing to anchor to — the fail-closed persist contract cannot be
    // honored. The fallback path opens a fresh turn whose user message is
    // persisted by the SessionStore, keeping the same durability guarantee.
    const store = new MemorySessionStore();
    const backends = new BackendRegistry();
    let backend: GatedSteeringBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new GatedSteeringBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      backends,
      newId: nextId(),
      now: nextNow(1_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    const turn = drainAll(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'go' }));
    await waitUntil(() => backend?.gates.has('turn-1') === true);
    // A live turn exists, but steering cannot be made durable: fall back.
    expect(manager.steer(session.id, 'no ledger')).toEqual({ kind: 'fallback' });
    // Followups are unaffected — they open a normal turn anyway.
    expect(manager.queueMessage(session.id, 'later').kind).toBe('queued');
    backend?.gates.get('turn-1')?.release();
    backend?.pullDone.get('turn-1')?.release();
    await turn;
  });

  test('a failed steering append nacks the lease back to the queue and the request never carries it', async () => {
    // Fail-CLOSED persistence: the steering append throws, the ack judgment
    // propagates the failure (no fail-open swallow), the lease is nacked back
    // to the queue (folded into followup at release), and neither the ledger
    // nor the projection carries the undelivered message.
    class FailingSteeringStore extends MemoryAgentRunStore {
      override async appendRuntimeEvent(
        sessionId: string,
        runId: string,
        event: RuntimeEvent,
      ): Promise<void> {
        if (
          event.content?.kind === 'text' &&
          (event.content as { steering?: boolean }).steering === true
        ) {
          throw new Error('steering append failed');
        }
        return super.appendRuntimeEvent(sessionId, runId, event);
      }
    }
    const runStore = new FailingSteeringStore();
    const model = steeringToolThenDoneModel();
    const { manager, session } = await steeringDeliverySession(
      runStore,
      model,
      (manager, sessionId) => {
        expect(manager.steer(sessionId, 'urgent steer').kind).toBe('queued');
      },
    );

    let failed: unknown;
    try {
      for await (const _event of manager.sendMessage(session.id, {
        turnId: 'turn-1',
        text: 'go',
      })) {
        // drain
      }
    } catch (error) {
      failed = error;
    }
    expect(failed instanceof Error).toBe(true);
    // The dying request never carried the steering: no second provider call.
    expect(model.doStreamCalls.length).toBe(1);
    // Nacked back to the queue and folded into followup at release — the
    // text is redeliverable, not lost.
    expect(manager.drainFollowup(session.id)).toBe('urgent steer');
    // Ledger and projection agree: the message was never persisted.
    const messages = await manager.getMessages(session.id);
    expect(
      messages.some((message) => message.type === 'user' && message.text === 'urgent steer'),
    ).toBe(false);
  });

  test('an overlapping turn cannot turn a delivered lease into a followup redelivery', async () => {
    // Round-4 V1: turn A leases the steer and parks in the (gated) durable
    // append; turn B starts meanwhile and takes the owner slot. A's append
    // then commits and A's provider request carries the message — so A's ack
    // MUST still settle the lease (it is keyed by issuer, not by the current
    // owner), and B's teardown must not fold A's in-flight lease into the
    // followup queue, which would redeliver an already-executed directive.
    const gate = makeGate();
    const parked = makeGate();
    class GatedRuntimeEventStore extends MemoryAgentRunStore {
      override async appendRuntimeEvent(
        sessionId: string,
        runId: string,
        event: RuntimeEvent,
      ): Promise<void> {
        if (
          event.content?.kind === 'text' &&
          (event.content as { steering?: boolean }).steering === true
        ) {
          parked.release();
          await gate.promise;
        }
        return super.appendRuntimeEvent(sessionId, runId, event);
      }
    }
    const runStore = new GatedRuntimeEventStore();
    const model = steeringToolThenDoneModel();
    const { manager, session } = await steeringDeliverySession(
      runStore,
      model,
      (manager, sessionId) => {
        manager.steer(sessionId, 'urgent steer');
      },
    );

    const turnAEvents: SessionEvent[] = [];
    const turnA = (async () => {
      try {
        for await (const event of manager.sendMessage(session.id, {
          turnId: 'turn-1',
          text: 'go',
        })) {
          turnAEvents.push(event);
        }
      } catch {
        // A gated teardown may end the stream abruptly.
      }
    })();
    await parked.promise;

    // Turn B runs to completion while A is parked mid-lease.
    for await (const _event of manager.sendMessage(session.id, {
      turnId: 'turn-2',
      text: 'second',
    })) {
      // drain
    }
    expect(model.doStreamCalls.length).toBe(2);

    gate.release();
    await turnA;

    // A's post-steer request went out carrying the directive exactly once…
    expect(model.doStreamCalls.length).toBe(3);
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt).includes('urgent steer')).toBe(true);
    // …B's request never did…
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt).includes('urgent steer')).toBe(false);
    // …the ledger echoes it exactly once…
    expect(turnAEvents.filter((event) => event.type === 'steering_message').length).toBe(1);
    // …and NOTHING redelivers it: the delivered lease was acked by its
    // issuer, so no queue still holds the text.
    expect(manager.drainFollowup(session.id)).toBe(null);
    expect(manager.retractQueue(session.id)).toBe('');
  });

  test('a backend-forged queue_update never reaches the ledger or observers', async () => {
    // Round-6 R3: the kernel is the only legal producer of queue_update (it
    // pushes them directly into the turn stream). A backend that yields one
    // is forging authoritative queue state; the flow drops it at the ingress
    // — not mapped, not forwarded, not persisted.
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new ForgingQueueBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(1_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    const events = await drainAll(
      manager.sendMessage(session.id, { turnId: 'turn-1', text: 'go' }),
    );
    // Nothing was enqueued in this turn, so ANY queue_update in the stream
    // is the forged one leaking through.
    expect(events.some((event) => event.type === 'queue_update')).toBe(false);
    const runs = await runStore.listSessionRuns(session.id);
    const runtimeEvents = (
      await Promise.all(runs.map((run) => runStore.readRuntimeEvents(session.id, run.runId)))
    ).flat();
    expect(
      runtimeEvents.some(
        (event) =>
          (event.actions?.stateDelta as { queueUpdate?: unknown } | undefined)?.queueUpdate !==
          undefined,
      ),
    ).toBe(false);
  });

  test('provider retry progress reaches observers without becoming a durable runtime fact', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => new ProviderRetryProgressBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(1_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    const events = await drainAll(
      manager.sendMessage(session.id, { turnId: 'turn-1', text: 'go' }),
    );
    expect(
      events.filter((event) => event.type === 'provider_retry').map((event) => event.phase),
    ).toEqual(['scheduled', 'started']);

    const runs = await runStore.listSessionRuns(session.id);
    const runtimeEvents = (
      await Promise.all(runs.map((run) => runStore.readRuntimeEvents(session.id, run.runId)))
    ).flat();
    expect(
      runtimeEvents.some(
        (event) =>
          (event.actions?.stateDelta as { providerRetry?: unknown } | undefined)?.providerRetry !==
          undefined,
      ),
    ).toBe(false);
  });

  test('an append error after the write landed settles by the ledger read-back, not a duplicate nack', async () => {
    // Round-6 R5: appendRuntimeEvent can fail AFTER the bytes landed (e.g. a
    // close error). Treating every append error as not-durable would nack a
    // message the ledger already owns — history replay plus the followup
    // redelivery equals a double. The ambiguous failure is settled by reading
    // the ledger back: present ⇒ durable ⇒ ack path.
    class WriteThenThrowStore extends MemoryAgentRunStore {
      override async appendRuntimeEvent(
        sessionId: string,
        runId: string,
        event: RuntimeEvent,
      ): Promise<void> {
        if (
          event.content?.kind === 'text' &&
          (event.content as { steering?: boolean }).steering === true
        ) {
          await super.appendRuntimeEvent(sessionId, runId, event);
          throw new Error('close failed after the write landed');
        }
        return super.appendRuntimeEvent(sessionId, runId, event);
      }
    }
    const runStore = new WriteThenThrowStore();
    const model = steeringToolThenDoneModel();
    const { manager, session } = await steeringDeliverySession(
      runStore,
      model,
      (manager, sessionId) => {
        manager.steer(sessionId, 'urgent steer');
      },
    );

    const turnEvents: SessionEvent[] = [];
    for await (const event of manager.sendMessage(session.id, { turnId: 'turn-1', text: 'go' })) {
      turnEvents.push(event);
    }

    // Delivered exactly once: the next request carries it…
    expect(model.doStreamCalls.length).toBe(2);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt).includes('urgent steer')).toBe(true);
    // …the ledger owns exactly one copy…
    const runs = await runStore.listSessionRuns(session.id);
    const steeringEvents: RuntimeEvent[] = [];
    for (const run of runs) {
      const events = await runStore.readRuntimeEvents(session.id, run.runId);
      steeringEvents.push(
        ...events.filter(
          (event) =>
            event.content?.kind === 'text' &&
            (event.content as { steering?: boolean }).steering === true,
        ),
      );
    }
    expect(steeringEvents.length).toBe(1);
    // …and no queue redelivers it.
    expect(manager.drainFollowup(session.id)).toBe(null);
    expect(manager.retractQueue(session.id)).toBe('');
  });

  test('stranded steering emits a final queue snapshot when it folds into the followup queue', async () => {
    const store = new MemorySessionStore();
    const runStore = new MemoryAgentRunStore();
    const backends = new BackendRegistry();
    let backend: GatedSteeringBackend | undefined;
    backends.register('ai-sdk', (ctx) => {
      backend = new GatedSteeringBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(1_000),
    });
    const session = await manager.createSession(makeInput({ permissionMode: 'bypass' }));

    const turn = drainAll(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'go' }));
    await waitUntil(() => backend?.gates.has('turn-1') === true);
    backend?.gates.get('turn-1')?.release();
    // The turn's only step boundary has already pulled (empty)…
    await waitUntil(() => backend?.pulls.has('turn-1') === true);
    // …so this steer is stranded: no step is left to consume it.
    expect(manager.steer(session.id, 'late').kind).toBe('queued');
    backend?.pullDone.get('turn-1')?.release();
    const events = await turn;

    // The stranded → followup migration is a queue change; the LAST snapshot
    // in the stream reflects it, not the stale pre-fold state.
    const updates = events.filter(
      (event): event is Extract<SessionEvent, { type: 'queue_update' }> =>
        event.type === 'queue_update',
    );
    expect(updates.at(-1)?.steering).toEqual([]);
    expect(updates.at(-1)?.followup).toEqual(['late']);
    // And the followup queue is the authoritative owner of the text.
    expect(manager.drainFollowup(session.id)).toBe('late');
  });
});

async function drainAll(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500 && !(await predicate()); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(await predicate()).toBe(true);
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

  async *startChildTurn(
    sessionId: string,
    input: Parameters<RuntimeKernelLike['startChildTurn']>[1],
  ): AsyncIterable<SessionEvent> {
    this.starts.push({
      sessionId,
      input: {
        turnId: input.turnId,
        text: input.prompt,
        parentRunId: input.parentRunId,
        agentName: input.spec.name,
      },
    });
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

  steer(): QueueEnqueueOutcome {
    return { kind: 'fallback' };
  }

  queueMessage(): QueueEnqueueOutcome {
    return { kind: 'fallback' };
  }

  drainFollowup(): string | null {
    return null;
  }

  retractQueue(): string {
    return '';
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

class RetryStopBackend extends TestBackend {
  constructor(
    ctx: BackendFactoryContext,
    private readonly stopGate: Gate,
  ) {
    super(ctx, stopGate);
  }

  override async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopCalls === 1) throw new Error('first stop failed');
    this.stopGate.release();
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
    private readonly compactCalls: Array<{ turnId: string; runtimeContextCount: number }>,
  ) {
    super(ctx);
  }

  async compactHistory(input: { turnId: string; runtimeContext: readonly RuntimeEvent[] }) {
    this.compactCalls.push({
      turnId: input.turnId,
      runtimeContextCount: input.runtimeContext.length,
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
    contextBudget: {
      enabled: true,
      policyName: 'unit-budget',
      estimatedTokensBefore: 1000,
      estimatedTokensAfter: 400,
      keptTurns: 1,
      droppedTurns: 1,
      keptEvents: 1,
      droppedEvents: 1,
      historyCompactWriteFailures: 1,
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

class HighVolumeDeltaBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(
    ctx: BackendFactoryContext,
    private readonly chunkCount: number,
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const messageId = `${input.turnId}-m`;
    for (let index = 0; index < this.chunkCount; index += 1) {
      yield {
        type: 'text_delta',
        id: `${input.turnId}-delta-${index}`,
        turnId: input.turnId,
        ts: index + 1,
        messageId,
        text: `chunk-${String(index).padStart(3, '0')}:${'x'.repeat(32)}\n`,
      };
    }
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: this.chunkCount + 1,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
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
 * looks like from the read model's side: AiSdkFlow's exhaustiveness guard turns
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

class ProviderRequestTraceBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(private readonly ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    await this.ctx.recordProviderRequestCapture?.({
      schemaVersion: 2,
      traceId: 'provider-trace-1',
      captureId: 'capture-1',
      turnId: input.turnId,
      step: 0,
      providerId: 'fake',
      modelId: 'fake-model',
      requestHash: 'sha256:request',
      requestPayloadWithoutProviderOptionsHash: 'sha256:shared-request',
      requestBytes: 100,
      segments: [],
      artifactId: 'artifact-capture',
    });
    await this.ctx.recordProviderRequestAttempt?.({
      traceId: 'provider-trace-1',
      attemptId: 'attempt-1',
      turnId: input.turnId,
      step: 0,
      attempt: 1,
      captureId: 'capture-1',
      captureArtifactId: 'artifact-capture',
      providerId: 'fake',
      modelId: 'fake-model',
      requestHash: 'sha256:request',
      requestBytes: 100,
      segments: Array.from({ length: 75 }, (_, index) => ({
        kind: 'message' as const,
        index,
        cacheable: true,
        hash: `sha256:${index}`,
        bytes: 1,
      })),
      startedAt: 1,
      completedAt: 2,
      status: 'completed',
      finishReason: 'stop',
      latencyMs: 1,
    });
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

class ProviderCaptureGateBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly dispatch: () => void,
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    await this.ctx.recordProviderRequestCapture?.({
      schemaVersion: 2,
      traceId: 'provider-trace-gated',
      captureId: 'capture-gated',
      turnId: input.turnId,
      step: 0,
      providerId: 'fake',
      modelId: 'fake-model',
      requestHash: 'sha256:gated',
      requestPayloadWithoutProviderOptionsHash: 'sha256:shared-gated',
      requestBytes: 100,
      segments: [],
      artifactId: 'artifact-gated',
    });
    this.dispatch();
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

class ProviderCaptureAfterAttemptFailureBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly attemptFailureRecorded: Promise<void>,
    private readonly captureOutcomes: string[],
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    await this.ctx.recordProviderRequestAttempt?.({
      traceId: 'provider-trace-1',
      attemptId: 'attempt-1',
      turnId: input.turnId,
      step: 0,
      attempt: 1,
      captureId: 'capture-1',
      captureArtifactId: 'artifact-capture-1',
      providerId: 'fake',
      modelId: 'fake-model',
      requestHash: 'sha256:request-1',
      requestBytes: 100,
      segments: [],
      startedAt: 1,
      completedAt: 2,
      status: 'completed',
      latencyMs: 1,
    });
    await this.attemptFailureRecorded;
    try {
      await this.ctx.recordProviderRequestCapture?.({
        schemaVersion: 2,
        traceId: 'provider-trace-1',
        captureId: 'capture-2',
        turnId: input.turnId,
        step: 1,
        providerId: 'fake',
        modelId: 'fake-model',
        requestHash: 'sha256:request-2',
        requestPayloadWithoutProviderOptionsHash: 'sha256:shared-request-2',
        requestBytes: 120,
        segments: [],
        artifactId: 'artifact-capture-2',
      });
      this.captureOutcomes.push('fulfilled');
    } catch {
      this.captureOutcomes.push('rejected');
    }
    await this.ctx.recordProviderRequestAttempt?.({
      traceId: 'provider-trace-1',
      attemptId: 'attempt-2',
      turnId: input.turnId,
      step: 1,
      attempt: 1,
      captureId: 'capture-2',
      captureArtifactId: 'artifact-capture-2',
      providerId: 'fake',
      modelId: 'fake-model',
      requestHash: 'sha256:request-2',
      requestBytes: 120,
      segments: [],
      startedAt: 2,
      completedAt: 3,
      status: 'completed',
      latencyMs: 1,
    });
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

class HistoryCompactCheckpointCacheProbeBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly observedCheckpointIds: Array<string | undefined>,
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const loaded = await this.ctx.loadHistoryCompactCheckpoint?.();
    this.observedCheckpointIds.push(loaded?.checkpointId);
    if (input.turnId === 'parent-turn') {
      const checkpoint = buildHistoryCompactCheckpoint({
        sessionId: this.sessionId,
        coveredRuntimeEvents: [
          {
            id: 'shared-source-event',
            sessionId: this.sessionId,
            runId: 'shared-source-run',
            turnId: 'shared-source-turn',
            invocationId: 'shared-source-invocation',
            ts: 1,
            partial: false,
            role: 'user',
            author: 'user',
            content: { kind: 'text', text: 'source' },
          },
        ],
        summary: 'share this checkpoint across session backends',
        summaryFormat: 'legacy_freeform',
      });
      this.ctx.recordHistoryCompactCheckpoint?.(
        { ...checkpoint, checkpointId: 'hcheckpoint-shared' },
        input.turnId,
      );
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

class HistoryCompactCheckpointMonotonicProbeBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly observedCoverage: Array<number | undefined>,
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const loaded = await this.ctx.loadHistoryCompactCheckpoint?.();
    this.observedCoverage.push(loaded?.coverage.eventCount);
    const coverage =
      input.turnId === 'parent-furthest' ? 2 : input.turnId === 'child-stale' ? 1 : 0;
    if (coverage > 0) {
      const coveredRuntimeEvents = Array.from(
        { length: coverage },
        (_, index): RuntimeEvent => ({
          id: `monotonic-source-event-${index}`,
          sessionId: this.sessionId,
          runId: `monotonic-source-run-${index}`,
          turnId: `monotonic-source-turn-${index}`,
          invocationId: `monotonic-source-invocation-${index}`,
          ts: index + 1,
          partial: false,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: `source ${index}` },
        }),
      );
      await this.ctx
        .recordHistoryCompactCheckpoint?.(
          buildHistoryCompactCheckpoint({
            sessionId: this.sessionId,
            coveredRuntimeEvents,
            summary: `${input.turnId} checkpoint`,
            summaryFormat: 'legacy_freeform',
          }),
          input.turnId,
        )
        .catch(() => {});
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

class SerializedCheckpointProbeBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly childRecorderCalled: Gate,
    private readonly recorderReturnedPromises: boolean[],
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const coverage = input.turnId === 'parent-delayed' ? 1 : 2;
    const coveredRuntimeEvents = Array.from(
      { length: coverage },
      (_, index): RuntimeEvent => ({
        id: `serialized-source-event-${index}`,
        sessionId: this.sessionId,
        runId: `serialized-source-run-${index}`,
        turnId: `serialized-source-turn-${index}`,
        invocationId: `serialized-source-invocation-${index}`,
        ts: index + 1,
        partial: false,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: `source ${index}` },
      }),
    );
    const write = this.ctx.recordHistoryCompactCheckpoint?.(
      buildHistoryCompactCheckpoint({
        sessionId: this.sessionId,
        coveredRuntimeEvents,
        summary: `${input.turnId} checkpoint`,
        summaryFormat: 'legacy_freeform',
      }),
      input.turnId,
    );
    if (input.turnId === 'child-furthest') {
      this.recorderReturnedPromises.push(
        Boolean(write && typeof (write as PromiseLike<void>).then === 'function'),
      );
      this.childRecorderCalled.release();
    }
    await write;
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

class RecoveringCheckpointWriteProbeBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly childRecorderCalled: Gate,
    private readonly observedCoverage: Array<number | undefined>,
    private readonly writeOutcomes: string[],
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const loaded = await this.ctx.loadHistoryCompactCheckpoint?.();
    this.observedCoverage.push(loaded?.coverage.eventCount);
    if (input.turnId !== 'child-observe') {
      const coverage = input.turnId === 'parent-failing' ? 1 : 2;
      const coveredRuntimeEvents = Array.from(
        { length: coverage },
        (_, index): RuntimeEvent => ({
          id: `recovering-source-event-${index}`,
          sessionId: this.sessionId,
          runId: `recovering-source-run-${index}`,
          turnId: `recovering-source-turn-${index}`,
          invocationId: `recovering-source-invocation-${index}`,
          ts: index + 1,
          partial: false,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: `source ${index}` },
        }),
      );
      const write = this.ctx.recordHistoryCompactCheckpoint?.(
        buildHistoryCompactCheckpoint({
          sessionId: this.sessionId,
          coveredRuntimeEvents,
          summary: `${input.turnId} checkpoint`,
          summaryFormat: 'legacy_freeform',
        }),
        input.turnId,
      );
      if (input.turnId === 'child-succeeding') this.childRecorderCalled.release();
      try {
        await write;
        this.writeOutcomes.push(`${input.turnId}:fulfilled`);
      } catch {
        this.writeOutcomes.push(`${input.turnId}:rejected`);
      }
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

class InitialCheckpointLoadRaceProbeBackend implements AgentBackend {
  readonly kind = 'ai-sdk' as const;
  readonly sessionId: string;

  constructor(
    private readonly ctx: BackendFactoryContext,
    private readonly staleRecorderCalled: Gate,
    private readonly observedCoverage: Array<number | undefined>,
    private readonly writeOutcomes: string[],
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (input.turnId === 'parent-initial-load') {
      const loaded = await this.ctx.loadHistoryCompactCheckpoint?.();
      this.observedCoverage.push(loaded?.coverage.eventCount);
    } else {
      const coveredRuntimeEvents = Array.from(
        { length: 5 },
        (_, index): RuntimeEvent => ({
          id: `stale-load-race-event-${index}`,
          sessionId: this.sessionId,
          runId: `stale-load-race-run-${index}`,
          turnId: `stale-load-race-turn-${index}`,
          invocationId: `stale-load-race-invocation-${index}`,
          ts: index + 1,
          partial: false,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: `source ${index}` },
        }),
      );
      const write = this.ctx.recordHistoryCompactCheckpoint?.(
        buildHistoryCompactCheckpoint({
          sessionId: this.sessionId,
          coveredRuntimeEvents,
          summary: 'stale checkpoint during initial load',
          summaryFormat: 'legacy_freeform',
        }),
        input.turnId,
      );
      this.staleRecorderCalled.release();
      try {
        await write;
        this.writeOutcomes.push(`${input.turnId}:fulfilled`);
      } catch {
        this.writeOutcomes.push(`${input.turnId}:rejected`);
      }
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
  generatedTitleAttempted: Gate | undefined;

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
      lastUsedAt: 1,
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
      llmConnectionSlug: input.llmConnectionSlug,
      connectionLocked: false,
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

  async setGeneratedTitleIfAbsent(sessionId: string, title: string): Promise<SessionHeader | null> {
    const current = await this.readHeader(sessionId);
    this.generatedTitleAttempted?.release();
    if (current.titleIsManual || current.name !== 'New Chat') return null;
    return this.updateHeader(sessionId, { name: title });
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

  async repairEventProjection(
    _sessionId: string,
    _type: AgentRunEvent['type'],
    event: AgentRunEvent | null,
  ): Promise<void> {
    this.repairedProjection = event;
  }
}

class MemoryRuntimeEventStore implements RuntimeEventStore {
  private runtimeEvents = new Map<string, RuntimeEvent[]>();

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
        permissionCeiling: 'ask',
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

function nextId(): () => string {
  let id = 0;
  return () => `id-${++id}`;
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
    expect(err instanceof Error ? err.message : String(err)).toMatch(pattern);
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
