import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RuntimeEvent } from '@maka/core/runtime-event';

import type { FlowInput } from '../agent-flow.js';
import type { InvocationContext } from '../invocation-context.js';
import { createLocalContinuationSafetyInspector } from '../continuation-safety.js';
import {
  RuntimeContinuationPlanner,
  buildSafeBoundaryContinuationPlan,
} from '../runtime-resume.js';
import { RuntimeRunner } from '../runtime-runner.js';

test('local continuation safety inspector returns current authoritative workspace facts', async () => {
  const inspect = createLocalContinuationSafetyInspector({
    readSessionCwd: async () => '/workspace/repo-link',
    resolveWorkspaceIdentity: async () => ({
      workspaceIdentity: 'workspace:v1:123e4567-e89b-42d3-a456-426614174000',
      canonicalPath: '/workspace/repo',
    }),
    listAvailableToolNames: async () => ['Write', 'Read', 'Read'],
    hasPendingBackgroundOperations: async () => false,
  });

  assert.deepEqual(await inspect('session-1'), {
    workspaceIdentity: 'workspace:v1:123e4567-e89b-42d3-a456-426614174000',
    workspacePath: '/workspace/repo',
    backgroundOperationsSettled: true,
    availableToolNames: ['Read', 'Write'],
  });
});

test('RuntimeRunner continues from replay context without synthesizing another user event', async () => {
  const sourceEvents = [
    event({
      id: 'source-user',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'run tests' },
    }),
    event({
      id: 'source-call',
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: 'tool-1', name: 'Bash', args: { command: 'npm test' } },
    }),
    event({
      id: 'source-result',
      role: 'tool',
      author: 'tool',
      content: { kind: 'function_response', id: 'tool-1', name: 'Bash', result: { exitCode: 0 } },
    }),
  ];
  const plan = buildSafeBoundaryContinuationPlan(sourceEvents, {
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
  assert.ok(plan.continuation);

  let capturedContext: InvocationContext | undefined;
  let capturedInput: FlowInput | undefined;
  const committedStartEvents: RuntimeEvent[] = [];
  const runner = new RuntimeRunner({
    commitContinuationStart: async (candidate) => {
      committedStartEvents.push(candidate);
    },
    flow: {
      async *run(context, input) {
        assert.deepEqual(
          committedStartEvents.map((candidate) => candidate.id),
          ['continuation-start'],
        );
        capturedContext = context;
        capturedInput = input;
        yield event({
          id: 'continued-complete',
          invocationId: context.invocationId,
          runId: context.runId,
          turnId: context.turnId,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        });
      },
    },
    providers: { newId: () => 'continuation-start', now: () => 20 },
  });

  const result = await runner.resume(plan.continuation, { source: 'test' });

  assert.equal(result.invocationId, 'invocation-2');
  assert.equal(result.runId, 'run-2');
  assert.equal(result.turnId, 'turn-2');
  assert.deepEqual(
    result.events.map((candidate) => candidate.id),
    ['continuation-start', 'continued-complete'],
  );
  assert.deepEqual(result.events[0]?.refs, {
    sourceInvocationId: 'invocation-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceRuntimeEventHighWater: 3,
  });
  assert.deepEqual(committedStartEvents, [result.events[0]]);
  assert.equal(capturedContext?.request.continuation?.sourceRunId, 'run-1');
  assert.deepEqual(capturedInput?.runtimeContext, sourceEvents);
  assert.equal(capturedInput?.continuation?.sourceRuntimeEventHighWater, 3);
});

test('RuntimeRunner preserves the immediate source segment when replay includes continuation ancestors', async () => {
  const ancestorEvents = [
    event({
      id: 'ancestor-user',
      invocationId: 'ancestor-invocation',
      runId: 'ancestor-run',
      turnId: 'ancestor-turn',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'original request' },
    }),
    event({
      id: 'ancestor-terminal',
      invocationId: 'ancestor-invocation',
      runId: 'ancestor-run',
      turnId: 'ancestor-turn',
      role: 'system',
      author: 'system',
      status: 'failed',
      actions: { endInvocation: true },
    }),
  ];
  const sourceRuntimeContext = [
    event({
      id: 'source-continuation-start',
      role: 'system',
      author: 'system',
      actions: { stateDelta: { continuation: true } },
    }),
    event({
      id: 'source-terminal',
      role: 'system',
      author: 'system',
      status: 'failed',
      actions: { endInvocation: true },
    }),
  ];
  const runtimeContext = [...ancestorEvents, ...sourceRuntimeContext];
  let capturedInput: FlowInput | undefined;
  const runner = new RuntimeRunner({
    commitContinuationStart: async () => {},
    flow: {
      async *run(context, input) {
        capturedInput = input;
        yield event({
          id: 'continued-text',
          invocationId: context.invocationId,
          runId: context.runId,
          turnId: context.turnId,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'continued' },
        });
        yield event({
          id: 'continued-terminal',
          invocationId: context.invocationId,
          runId: context.runId,
          turnId: context.turnId,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        });
      },
    },
    providers: { newId: () => 'new-event', now: () => 20 },
  });

  const result = await runner.resume(
    {
      sessionId: 'session-1',
      invocationId: 'invocation-2',
      runId: 'run-2',
      turnId: 'turn-2',
      sourceInvocationId: 'invocation-1',
      sourceRunId: 'run-1',
      sourceTurnId: 'turn-1',
      sourceRuntimeEventHighWater: sourceRuntimeContext.length,
      sourceRuntimeContext,
      runtimeContext,
      safetySnapshot: {
        workspaceIdentity: 'workspace-1',
        backgroundOperationsSettled: true,
        availableToolNames: [],
      },
    },
    { source: 'test' },
  );

  assert.equal(result.status, 'completed');
  assert.deepEqual(capturedInput?.runtimeContext, runtimeContext);
  assert.equal('sourceRuntimeContext' in (capturedInput?.continuation ?? {}), false);
});

test('RuntimeContinuationPlanner reads the durable source boundary and allocates fresh identities', async () => {
  const sourceEvents = [
    event({
      id: 'source-user',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'continue' },
    }),
    event({
      id: 'source-terminal',
      role: 'system',
      author: 'system',
      status: 'failed',
      actions: { endInvocation: true },
    }),
  ];
  const ids = ['invocation-2', 'run-2', 'turn-2'];
  const planner = new RuntimeContinuationPlanner({
    readSourceRun: async () => ({ cwd: '/workspace/repo', status: 'failed' }),
    readRuntimeEvents: async () => sourceEvents,
    newId: () => ids.shift() ?? 'unexpected-id',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'continue');
  assert.deepEqual(plan.continuation, {
    sessionId: 'session-1',
    invocationId: 'invocation-2',
    runId: 'run-2',
    turnId: 'turn-2',
    sourceInvocationId: 'invocation-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceRuntimeEventHighWater: 2,
    runtimeContext: sourceEvents,
    safetySnapshot: {
      workspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    },
  });
});

test('RuntimeRunner rejects a continuation envelope whose high-water is behind its replay context', async () => {
  const runner = new RuntimeRunner({
    flow: {
      async *run() {
        throw new Error('flow must not start');
      },
    },
  });

  await assert.rejects(
    runner.resume(
      {
        sessionId: 'session-1',
        invocationId: 'invocation-2',
        runId: 'run-2',
        turnId: 'turn-2',
        sourceInvocationId: 'invocation-1',
        sourceRunId: 'run-1',
        sourceTurnId: 'turn-1',
        sourceRuntimeEventHighWater: 0,
        runtimeContext: [
          event({
            id: 'source-user',
            role: 'user',
            author: 'user',
            content: { kind: 'text', text: 'continue' },
          }),
        ],
        safetySnapshot: {
          workspaceIdentity: 'workspace-1',
          backgroundOperationsSettled: true,
          availableToolNames: [],
        },
      },
      { source: 'test' },
    ),
    /high-water/i,
  );
});

test('RuntimeContinuationPlanner parks with a stable reason when the ledger cannot be read', async () => {
  const planner = new RuntimeContinuationPlanner({
    readSourceRun: async () => ({ cwd: '/workspace/repo', status: 'failed' }),
    readRuntimeEvents: async () => {
      throw new Error('corrupt ledger');
    },
    newId: () => 'unused',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['runtime_ledger_unreadable']);
});

test('RuntimeContinuationPlanner derives terminal repair from durable run and event facts', async () => {
  const planner = new RuntimeContinuationPlanner({
    readSourceRun: async () => ({ cwd: '/workspace/repo', status: 'running' }),
    readRuntimeEvents: async () => [
      event({
        id: 'source-user',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'continue' },
      }),
    ],
    newId: () => 'fresh-id',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['terminal_repair_failed']);
});

test('RuntimeContinuationPlanner parks when the terminal run header disagrees with the ledger fact', async () => {
  const planner = new RuntimeContinuationPlanner({
    readSourceRun: async () => ({ cwd: '/workspace/repo', status: 'completed' }),
    readRuntimeEvents: async () => [
      event({
        id: 'source-user',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'continue' },
      }),
      event({
        id: 'source-terminal',
        role: 'system',
        author: 'system',
        status: 'failed',
        actions: { endInvocation: true },
      }),
    ],
    newId: () => 'fresh-id',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['terminal_repair_failed']);
});

test('RuntimeContinuationPlanner rejects a ledger returned for another source run', async () => {
  const planner = new RuntimeContinuationPlanner({
    readSourceRun: async () => ({ cwd: '/workspace/repo', status: 'failed' }),
    readRuntimeEvents: async () => [
      event({
        id: 'wrong-user',
        runId: 'run-other',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'continue' },
      }),
      event({
        id: 'wrong-terminal',
        runId: 'run-other',
        role: 'system',
        author: 'system',
        status: 'failed',
        actions: { endInvocation: true },
      }),
    ],
    newId: () => 'fresh-id',
  });

  const plan = await planner.plan({
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    currentCwd: '/workspace/repo',
    sourceWorkspaceIdentity: 'workspace-1',
    currentWorkspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [],
  });

  assert.equal(plan.disposition, 'park');
  assert.deepEqual(plan.rejectionReasons, ['runtime_identity_mismatch']);
});

function event(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    ...overrides,
  };
}
