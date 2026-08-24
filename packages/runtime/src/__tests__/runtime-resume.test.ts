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
import { describe, test } from 'node:test';

import {
  buildImmutableRuntimePrefix,
  type ImmutableRuntimePrefixV1,
} from '@maka/core/runtime-boundary';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { AgentRunHeader } from '@maka/core/agent-run';

import { buildContinuationReplayPlan } from '../continuation-replay.js';
import { PROVIDER_REPLAY_PROJECTION_VERSION } from '../model-history.js';
import {
  RUNTIME_RESUME_FAILPOINTS,
  RuntimeContinuationPlanner,
  buildSafeBoundaryContinuationPlan,
  buildResumePlanFromRuntimeEvents,
  buildResumeReplayRuntimeEvents,
  projectToolOperationsFromRuntimeEvents,
} from '../runtime-resume.js';

describe('runtime resume phase 0 projection', () => {
  test('publishes the stable P0-P11 crash failpoint catalog', () => {
    assert.deepEqual(
      RUNTIME_RESUME_FAILPOINTS.map((failpoint) => failpoint.id),
      ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11'],
    );
    assert.deepEqual(
      [...new Set(RUNTIME_RESUME_FAILPOINTS.map((failpoint) => failpoint.committedPrefix))],
      [
        'before_function_call',
        'after_function_call',
        'after_function_response',
        'after_terminal_event',
      ],
    );
  });

  test('projects deterministic tool operations from legal RuntimeEvent prefixes', () => {
    const events = [
      callEvent('call-1', 'tool-1', 'Bash', { command: 'npm test' }),
      responseEvent('result-1', 'tool-1', 'Bash', { ok: false }, true),
      callEvent('call-2', 'tool-2', 'Read', { file_path: 'README.md' }),
    ];

    const first = projectToolOperationsFromRuntimeEvents(events);
    const second = projectToolOperationsFromRuntimeEvents(events);

    assert.deepEqual(first, second);
    assert.deepEqual(
      first.map((operation) => ({
        toolCallId: operation.toolCallId,
        toolName: operation.toolName,
        status: operation.status,
        callRuntimeEventId: operation.callRuntimeEventId,
        responseRuntimeEventId: operation.responseRuntimeEventId,
      })),
      [
        {
          toolCallId: 'tool-1',
          toolName: 'Bash',
          status: 'failed',
          callRuntimeEventId: 'call-1',
          responseRuntimeEventId: 'result-1',
        },
        {
          toolCallId: 'tool-2',
          toolName: 'Read',
          status: 'indeterminate',
          callRuntimeEventId: 'call-2',
          responseRuntimeEventId: undefined,
        },
      ],
    );
  });

  test('distinguishes committed failed results from indeterminate missing results', () => {
    const failed = buildResumePlanFromRuntimeEvents([
      callEvent('call-1', 'tool-1', 'Bash', { command: 'exit 1' }),
      responseEvent('result-1', 'tool-1', 'Bash', { exitCode: 1 }, true),
    ]);
    const indeterminate = buildResumePlanFromRuntimeEvents([
      callEvent('call-2', 'tool-2', 'Bash', { command: 'touch marker' }),
    ]);

    assert.equal(failed.disposition, 'safe_replay');
    assert.equal(failed.operations[0]?.status, 'failed');
    assert.equal(indeterminate.disposition, 'blocked');
    assert.equal(indeterminate.operations[0]?.status, 'indeterminate');
    assert.equal(indeterminate.requiresVerification, true);
    assert.deepEqual(indeterminate.rejectionReasons, ['dangling_tool_state']);
    assert.equal(indeterminate.sourceRuntimeEventHighWater, 1);
    assert.ok(indeterminate.directive);
    assert.match(indeterminate.directive, /Do not retry/i);
    assert.match(indeterminate.directive, /read-only/i);
  });

  test('excludes unresolved tool calls from provider replay history', () => {
    const events = [
      textEvent('user-1', 'user', 'hello'),
      callEvent('call-1', 'tool-1', 'Bash', { command: 'touch marker' }),
      textEvent('system-1', 'system', 'diagnostic'),
    ];

    const replayEvents = buildResumeReplayRuntimeEvents(events);

    assert.deepEqual(
      replayEvents.map((event) => event.id),
      ['user-1', 'system-1'],
    );
  });

  test('never replays hidden nested CodeMode operations on resume', () => {
    const nestedCall = {
      ...callEvent('nested-call', 'nested-1', 'Read', {}),
      origin: 'code_mode' as const,
      modelVisibility: 'hidden' as const,
    };
    const nestedResult = {
      ...responseEvent('nested-result', 'nested-1', 'Read', { ok: true }, false),
      origin: 'code_mode' as const,
      modelVisibility: 'hidden' as const,
    };
    const events = [textEvent('user-1', 'user', 'inspect'), nestedCall, nestedResult];

    assert.deepEqual(projectToolOperationsFromRuntimeEvents(events), []);
    assert.deepEqual(
      buildResumeReplayRuntimeEvents(events).map((event) => event.id),
      ['user-1'],
    );
    assert.equal(buildResumePlanFromRuntimeEvents(events).disposition, 'safe_replay');
  });

  test('blocks resume when a hidden nested CodeMode operation is still indeterminate', () => {
    const initial = textEvent('user-1', 'user', 'run the workflow');
    initial.actions = { runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' } };
    const outerCall = {
      ...callEvent('outer-call', 'exec-1', 'exec', { code: 'await tools.Read({})' }),
      refs: { operationId: 'outer-op', toolCallId: 'exec-1' },
    };
    const outerDispatch = dispatchEvent({
      id: 'outer-dispatch',
      operationId: 'outer-op',
      toolCallId: 'exec-1',
      toolName: 'exec',
      args: { code: 'await tools.Read({})' },
    });
    const outerResponse = {
      ...responseEvent('outer-response', 'exec-1', 'exec', { status: 'interrupted' }, true),
      refs: { operationId: 'outer-op', toolCallId: 'exec-1' },
    };
    const nestedCall = {
      ...callEvent('nested-call', 'nested-1', 'Read', {}),
      origin: 'code_mode' as const,
      modelVisibility: 'hidden' as const,
      refs: {
        operationId: 'nested-op',
        toolCallId: 'nested-1',
        parentOperationId: 'outer-op',
        parentToolCallId: 'exec-1',
      },
    };
    const nestedDispatch = dispatchEvent({
      id: 'nested-dispatch',
      operationId: 'nested-op',
      toolCallId: 'nested-1',
      toolName: 'Read',
      args: {},
      origin: 'code_mode',
      modelVisibility: 'hidden',
      parentOperationId: 'outer-op',
      parentToolCallId: 'exec-1',
    });

    const plan = buildResumePlanFromRuntimeEvents([
      initial,
      outerCall,
      outerDispatch,
      outerResponse,
      nestedCall,
      nestedDispatch,
    ]);

    assert.equal(plan.disposition, 'blocked');
    assert.equal(plan.requiresVerification, true);
    assert.ok(plan.directive);
    assert.ok(plan.diagnostics.some((diagnostic) => diagnostic.code === 'pending_tool_result'));
    assert.deepEqual(plan.rejectionReasons, ['dangling_tool_state']);
  });

  test('blocks replay on unmatched tool results rather than inventing provider history', () => {
    const plan = buildResumePlanFromRuntimeEvents([
      responseEvent('result-1', 'tool-1', 'Bash', { ok: true }, false),
    ]);

    assert.equal(plan.disposition, 'blocked');
    assert.equal(plan.requiresVerification, false);
    assert.deepEqual(plan.rejectionReasons, ['dangling_tool_state']);
    assert.deepEqual(
      plan.diagnostics.map((diagnostic) => diagnostic.code),
      ['tool_ledger_corruption', 'unmatched_tool_result'],
    );
    assert.deepEqual(
      buildResumeReplayRuntimeEvents(plan.runtimeEvents).map((event) => event.id),
      [],
    );
  });

  test('rejects runtime high-water mismatches with a stable fallback reason', () => {
    const plan = buildResumePlanFromRuntimeEvents([textEvent('user-1', 'user', 'hello')], {
      expectedRuntimeEventHighWater: 2,
    });

    assert.equal(plan.disposition, 'blocked');
    assert.deepEqual(plan.rejectionReasons, ['runtime_offset_mismatch']);
    assert.deepEqual(
      plan.diagnostics.map((diagnostic) => diagnostic.code),
      ['runtime_offset_mismatch'],
    );
  });
});

describe('runtime resume phase 1 safe-boundary continuation', () => {
  test('replays the user-anchored ancestor prefix when continuing a continuation run', async () => {
    const rootEvents = [
      textEvent('root-user', 'user', 'finish the task'),
      base({
        id: 'root-interrupted-thinking',
        role: 'model',
        author: 'agent',
        content: {
          kind: 'thinking',
          text: 'unfinished',
          signature: 'signed-root',
        },
      }),
      base({
        id: 'root-interrupted-text',
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'I was interrupted' },
      }),
      base({ id: 'root-terminal', status: 'failed', actions: { endInvocation: true } }),
    ];
    const continuationIdentity = {
      sessionId: 'session-1',
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
    };
    const childEvents = [
      {
        ...base({
          id: 'continuation-start',
          role: 'system',
          author: 'system',
          actions: { stateDelta: { continuationStart: true } },
        }),
        ...continuationIdentity,
      },
      {
        ...callEvent('child-call', 'tool-2', 'Bash', { command: 'npm test' }),
        ...continuationIdentity,
      },
      {
        ...responseEvent('child-result', 'tool-2', 'Bash', { exitCode: 0 }, false),
        ...continuationIdentity,
      },
      {
        ...base({ id: 'child-terminal', status: 'failed', actions: { endInvocation: true } }),
        ...continuationIdentity,
      },
    ];
    const planner = new RuntimeContinuationPlanner({
      readSourceRun: async (_sessionId, runId) =>
        runId === 'run-2'
          ? runHeader('run-2', {
              continuationSource: {
                sourceInvocationId: 'invocation-1',
                sourceRunId: 'run-1',
                sourceTurnId: 'turn-1',
                sourceRuntimeEventHighWater: rootEvents.length,
              },
            })
          : runHeader('run-1'),
      readImmutableRuntimePrefix: async ({ runId, upToEventSeq }) => {
        const events = runId === 'run-2' ? childEvents : rootEvents;
        return immutablePrefix(upToEventSeq === undefined ? events : events.slice(0, upToEventSeq));
      },
      newId: (() => {
        let next = 2;
        return () => `generated-${++next}`;
      })(),
    });

    const plan = await planner.plan({
      sessionId: 'session-1',
      sourceRunId: 'run-2',
      currentCwd: '/workspace/repo',
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: ['Bash'],
    });

    assert.equal(plan.disposition, 'continue');
    assert.deepEqual(
      plan.continuation?.runtimeContext.map((event) => event.id),
      [
        'root-user',
        'root-terminal',
        'continuation-start',
        'child-call',
        'child-result',
        'child-terminal',
      ],
    );
    assert.deepEqual(
      plan.continuation?.sourceRuntimeContext?.map((event) => event.id),
      ['continuation-start', 'child-call', 'child-result', 'child-terminal'],
    );
  });

  test('uses RecoveryResolver to distinguish a new-protocol call that never crossed T1', () => {
    const initial = textEvent('user-1', 'user', 'run it');
    initial.actions = {
      runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' },
    };
    const plan = buildResumePlanFromRuntimeEvents([
      initial,
      callEvent('call-1', 'tool-1', 'Bash', { command: 'touch marker' }),
    ]);

    assert.equal(plan.disposition, 'blocked');
    assert.equal(plan.operations[0]?.status, 'not_dispatched');
    assert.equal(plan.requiresVerification, false);
    assert.deepEqual(
      plan.diagnostics.map((diagnostic) => diagnostic.code),
      ['tool_not_dispatched'],
    );
    assert.deepEqual(plan.rejectionReasons, ['dangling_tool_state']);
  });

  test('lets composite replay trim a new-protocol call that never crossed T1', () => {
    const initial = textEvent('user-1', 'user', 'run it');
    initial.actions = {
      runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' },
    };
    const events = [
      initial,
      callEvent('call-1', 'tool-1', 'Bash', { command: 'touch marker' }),
      base({
        id: 'terminal-1',
        role: 'system',
        author: 'system',
        status: 'failed',
        actions: { endInvocation: true },
      }),
    ];
    const replay = buildContinuationReplayPlan({
      prefixes: [immutablePrefix(events)],
      providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
    });
    assert.equal(replay.kind, 'replayable');
    if (replay.kind !== 'replayable') return;

    const plan = buildSafeBoundaryContinuationPlan(events, {
      ...safeBoundaryFacts(),
      continuationReplayPlan: replay.plan,
    });

    assert.equal(plan.disposition, 'continue');
    assert.deepEqual(plan.rejectionReasons, []);
    assert.deepEqual(
      plan.continuation?.runtimeContext.map((event) => event.id),
      ['user-1', 'terminal-1'],
    );
  });

  test('creates a new execution identity from a fully committed safe boundary', () => {
    const events = [
      textEvent('user-1', 'user', 'run the tests'),
      callEvent('call-1', 'tool-1', 'Bash', { command: 'npm test' }),
      responseEvent('result-1', 'tool-1', 'Bash', { exitCode: 0 }, false),
    ];

    const plan = buildSafeBoundaryContinuationPlan(events, {
      ledgerReadable: true,
      terminalRepairSucceeded: true,
      sourceCwd: '/workspace/repo',
      currentCwd: '/workspace/repo',
      sourceWorkspaceIdentity: 'workspace-1',
      currentWorkspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: ['Bash'],
      continuationIdentity: {
        invocationId: 'invocation-2',
        runId: 'run-2',
        turnId: 'turn-2',
      },
    });

    assert.equal(plan.disposition, 'continue');
    assert.deepEqual(plan.rejectionReasons, []);
    assert.deepEqual(plan.continuation, {
      sessionId: 'session-1',
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
      sourceInvocationId: 'invocation-1',
      sourceRunId: 'run-1',
      sourceTurnId: 'turn-1',
      sourceRuntimeEventHighWater: 3,
      runtimeContext: events,
      safetySnapshot: {
        workspaceIdentity: 'workspace-1',
        backgroundOperationsSettled: true,
        availableToolNames: ['Bash'],
      },
    });
  });

  test('parks when a permission request has no committed decision', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'edit the file'),
        permissionRequestEvent('permission-1', 'tool-1'),
      ],
      safeBoundaryFacts(),
    );

    assert.equal(plan.disposition, 'park');
    assert.deepEqual(plan.rejectionReasons, ['pending_permission']);
    assert.equal(plan.continuation, undefined);
  });

  test('clears a pending permission with an identity-only accepted answer', () => {
    const request = permissionRequestEvent('permission-1', 'tool-1');
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'edit the file'),
        request,
        base({
          id: 'permission-answer-1',
          role: 'system',
          author: 'user',
          actions: {
            permissionAnswerAccepted: {
              requestId: request.actions!.permissionRequest!.requestId,
            },
          },
          refs: { toolCallId: 'tool-1' },
        }),
      ],
      safeBoundaryFacts(),
    );

    assert.equal(
      plan.diagnostics.some((diagnostic) => diagnostic.code === 'pending_permission'),
      false,
    );
  });

  test('continues after a hosted timeout durably closes the pending permission', () => {
    const request = permissionRequestEvent('permission-1', 'tool-1');
    const closure = base({
      id: 'permission-closure-1',
      role: 'system',
      author: 'system',
      actions: {
        permissionClosureAccepted: {
          requestId: request.actions!.permissionRequest!.requestId,
          reason: 'timed_out',
        },
      },
      refs: { toolCallId: 'tool-1' },
    });
    const events = [textEvent('user-1', 'user', 'edit the file'), request, closure];

    const plan = buildSafeBoundaryContinuationPlan(events, safeBoundaryFacts());

    assert.equal(plan.disposition, 'continue');
    assert.deepEqual(plan.rejectionReasons, []);
    assert.deepEqual(plan.continuation?.runtimeContext, events);
  });

  test('parks when the current workspace identity differs from the source boundary', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [textEvent('user-1', 'user', 'inspect the repository')],
      {
        ...safeBoundaryFacts(),
        currentWorkspaceIdentity: 'workspace-2',
      },
    );

    assert.equal(plan.disposition, 'park');
    assert.deepEqual(plan.rejectionReasons, ['workspace_identity_mismatch']);
  });

  test('continues after a workspace path change when the UUID marker is unchanged', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [textEvent('user-1', 'user', 'inspect the repository')],
      {
        ...safeBoundaryFacts(),
        currentCwd: '/fresh-sandbox/repo',
      },
    );

    assert.equal(plan.disposition, 'continue');
    assert.deepEqual(plan.rejectionReasons, []);
    assert.deepEqual(plan.diagnostics, [
      {
        code: 'workspace_location_changed',
        message: 'workspace location differs from the source resume boundary',
        detail: {
          sourceCwd: '/workspace/repo',
          currentCwd: '/fresh-sandbox/repo',
        },
      },
    ]);
  });

  test('parks while a background operation is still unsettled', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'start the service'),
        callEvent('call-1', 'tool-1', 'Bash', { command: 'npm start', background: true }),
        responseEvent(
          'result-1',
          'tool-1',
          'Bash',
          {
            kind: 'shell_run',
            ref: 'maka://runtime/background-tasks/run-1',
            status: 'running',
          },
          false,
        ),
      ],
      {
        ...safeBoundaryFacts(),
        backgroundOperationsSettled: false,
      },
    );

    assert.equal(plan.disposition, 'park');
    assert.deepEqual(plan.rejectionReasons, ['background_operation_pending']);
  });

  test('parks when a historical tool is unavailable in the current catalog', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'fetch the page'),
        callEvent('call-1', 'tool-1', 'Fetch', { url: 'https://example.test' }),
        responseEvent('result-1', 'tool-1', 'Fetch', { status: 200 }, false),
      ],
      safeBoundaryFacts(),
    );

    assert.equal(plan.disposition, 'park');
    assert.deepEqual(plan.rejectionReasons, ['tool_catalog_mismatch']);
    assert.deepEqual(plan.diagnostics[0]?.detail, { unavailableToolNames: ['Fetch'] });
  });

  test('parks when any required external safety fact is absent', () => {
    const events = [textEvent('user-1', 'user', 'continue the task')];
    const cases = [
      {
        facts: { ...safeBoundaryFacts(), ledgerReadable: false },
        reason: 'runtime_ledger_unreadable',
      },
      {
        facts: { ...safeBoundaryFacts(), terminalRepairSucceeded: false },
        reason: 'terminal_repair_failed',
      },
    ] as const;

    for (const candidate of cases) {
      const plan = buildSafeBoundaryContinuationPlan(events, candidate.facts);
      assert.equal(plan.disposition, 'park');
      assert.deepEqual(plan.rejectionReasons, [candidate.reason]);
    }
  });

  test('requires a non-empty single-source ledger and fresh continuation identity', () => {
    const empty = buildSafeBoundaryContinuationPlan([], safeBoundaryFacts());
    assert.deepEqual(empty.rejectionReasons, ['runtime_ledger_empty']);

    const mixed = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'continue'),
        base({ id: 'other-run', runId: 'run-other', content: { kind: 'text', text: 'other' } }),
      ],
      safeBoundaryFacts(),
    );
    assert.deepEqual(mixed.rejectionReasons, ['dangling_tool_state', 'runtime_identity_mismatch']);

    const reused = buildSafeBoundaryContinuationPlan([textEvent('user-1', 'user', 'continue')], {
      ...safeBoundaryFacts(),
      continuationIdentity: {
        invocationId: 'invocation-1',
        runId: 'run-1',
        turnId: 'turn-1',
      },
    });
    assert.deepEqual(reused.rejectionReasons, ['continuation_identity_reused']);
  });

  test('parks when committed provider history ends with a model message', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'write a summary'),
        base({
          id: 'assistant-1',
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'partial but committed answer' },
        }),
      ],
      safeBoundaryFacts(),
    );

    assert.equal(plan.disposition, 'park');
    assert.deepEqual(plan.rejectionReasons, ['provider_resume_boundary_unsupported']);
  });

  test('parks when committed provider history does not start at a user boundary', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        base({
          id: 'continuation-start',
          role: 'system',
          author: 'system',
          actions: { stateDelta: { continuationStart: true } },
        }),
        callEvent('call-1', 'tool-1', 'Bash', { command: 'npm test' }),
        responseEvent('result-1', 'tool-1', 'Bash', { exitCode: 0 }, false),
      ],
      safeBoundaryFacts(),
    );

    assert.equal(plan.disposition, 'park');
    assert.deepEqual(plan.rejectionReasons, ['provider_resume_head_unsupported']);
    assert.equal(plan.diagnostics[0]?.code, 'provider_resume_head_unsupported');
  });

  test('requires a restored workspace checkpoint with the same runtime high-water when supplied', () => {
    const events = [textEvent('user-1', 'user', 'continue')];
    const missingRef = buildSafeBoundaryContinuationPlan(events, {
      ...safeBoundaryFacts(),
      workspaceCheckpoint: { restored: true, runtimeEventHighWater: 1 },
    });
    assert.deepEqual(missingRef.rejectionReasons, ['workspace_ref_missing']);

    const restoreFailed = buildSafeBoundaryContinuationPlan(events, {
      ...safeBoundaryFacts(),
      workspaceCheckpoint: { ref: 'checkpoint-1', restored: false, runtimeEventHighWater: 1 },
    });
    assert.deepEqual(restoreFailed.rejectionReasons, ['checkpoint_restore_failed']);

    const offsetMismatch = buildSafeBoundaryContinuationPlan(events, {
      ...safeBoundaryFacts(),
      workspaceCheckpoint: { ref: 'checkpoint-1', restored: true, runtimeEventHighWater: 2 },
    });
    assert.deepEqual(offsetMismatch.rejectionReasons, ['runtime_offset_mismatch']);
  });

  test('keeps the durable high-water even when partial events are excluded from replay context', () => {
    const plan = buildSafeBoundaryContinuationPlan(
      [
        textEvent('user-1', 'user', 'continue'),
        base({
          id: 'partial-1',
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'streaming' },
        }),
      ],
      safeBoundaryFacts(),
    );

    assert.equal(plan.disposition, 'continue');
    assert.equal(plan.continuation?.sourceRuntimeEventHighWater, 2);
    assert.deepEqual(
      plan.continuation?.runtimeContext.map((event) => event.id),
      ['user-1'],
    );
  });
});

function safeBoundaryFacts() {
  return {
    ledgerReadable: true,
    terminalRepairSucceeded: true,
    sourceCwd: '/workspace/repo',
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: ['Bash', 'Write'],
    continuationIdentity: {
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
    },
  };
}

function runHeader(runId: string, overrides: Partial<AgentRunHeader> = {}): AgentRunHeader {
  const ordinal = runId.match(/(\d+)$/)?.[1] ?? '1';
  const status = overrides.status ?? 'failed';
  return {
    runId,
    invocationId: `invocation-${ordinal}`,
    sessionId: 'session-1',
    turnId: `turn-${ordinal}`,
    status,
    backendKind: 'fake',
    llmConnectionSlug: 'test',
    modelId: 'test-model',
    cwd: '/workspace/repo',
    permissionMode: 'ask',
    ...(status === 'failed' ? { failureClass: 'test_failure' } : {}),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function base(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    author: 'agent',
    role: 'system',
    ...overrides,
  };
}

function immutablePrefix(events: readonly RuntimeEvent[]): ImmutableRuntimePrefixV1 {
  const first = events[0];
  if (!first) throw new Error('test immutable prefix requires at least one event');
  return buildImmutableRuntimePrefix(
    {
      sessionId: first.sessionId,
      invocationId: first.invocationId,
      runId: first.runId,
      turnId: first.turnId,
    },
    events.map((runtimeEvent, index) => ({
      eventSeq: index + 1,
      event: runtimeEvent,
    })),
  );
}

function callEvent(id: string, toolCallId: string, name: string, args: unknown): RuntimeEvent {
  return base({
    id,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: toolCallId, name, args },
    refs: { toolCallId },
  });
}

function responseEvent(
  id: string,
  toolCallId: string,
  name: string,
  result: unknown,
  isError: boolean,
): RuntimeEvent {
  return base({
    id,
    role: 'tool',
    content: { kind: 'function_response', id: toolCallId, name, result, isError },
    author: 'tool',
    refs: { toolCallId },
  });
}

function dispatchEvent(input: {
  id: string;
  operationId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  origin?: 'provider' | 'code_mode';
  modelVisibility?: 'visible' | 'hidden';
  parentOperationId?: string;
  parentToolCallId?: string;
}): RuntimeEvent {
  return base({
    id: input.id,
    author: 'system',
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.modelVisibility ? { modelVisibility: input.modelVisibility } : {}),
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: input.operationId,
        providerToolCallId: input.toolCallId,
        toolName: input.toolName,
        canonicalArgsHash: canonicalToolArgsHash(input.toolName, input.args),
        recoveryMode: 'never_auto_retry',
      },
    },
    refs: {
      operationId: input.operationId,
      toolCallId: input.toolCallId,
      ...(input.parentOperationId ? { parentOperationId: input.parentOperationId } : {}),
      ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
    },
  });
}

function textEvent(id: string, role: 'user' | 'system', text: string): RuntimeEvent {
  return base({
    id,
    role,
    author: role === 'user' ? 'user' : 'system',
    content: { kind: 'text', text },
  });
}

function permissionRequestEvent(id: string, toolCallId: string): RuntimeEvent {
  return base({
    id,
    role: 'system',
    author: 'system',
    actions: {
      permissionRequest: {
        kind: 'tool_permission',
        requestId: id,
        toolUseId: toolCallId,
        toolName: 'Write',
        category: 'file_write',
        reason: 'file_write',
        args: { path: 'README.md' },
        rememberForTurnAllowed: true,
      },
    },
  });
}
