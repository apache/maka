import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { AgentRunEvent, AgentRunHeader, RuntimeEvent } from '@maka/core';
import { buildHistoryCompactCheckpoint } from '@maka/runtime';
import { createSqliteAgentRunStore, createWorkspaceRuntimeStore } from '@maka/storage';
import type { HeavyTaskSemanticSelfCheckState, TaskEvent } from '../task-contracts.js';
import { taskAttemptExecutionEvidence } from '../task-execution-lineage.js';
import { createInMemoryTaskRunStore } from '../task-run-store.js';
import {
  TASK_RUN_INSPECT_SCHEMA_VERSION,
  inspectTaskRun,
  renderTaskRunInspectTree,
} from '../task-run-inspect.js';

describe('TaskRun inspection', () => {
  test('joins Task, AgentRun, Runtime, tool, Self-check, and Compaction facts', async () => {
    await withStores(async ({ taskRunStore, agentRunStore, runtimeEventStore }) => {
      const runtimeEvents = [
        runtimeEvent('runtime-user', {
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'go' },
        }),
        runtimeEvent('runtime-call', {
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-1',
            name: 'Bash',
            args: { command: 'npm test' },
          },
        }),
        runtimeEvent('runtime-response', {
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-1',
            name: 'Bash',
            result: { exitCode: 0 },
          },
        }),
        runtimeEvent('runtime-complete', {
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        }),
      ];
      await agentRunStore.createRun(runHeader());
      await agentRunStore.appendEvent(SESSION_ID, RUN_ID, runEvent('run-started', 'run_started'));
      for (const event of runtimeEvents)
        await runtimeEventStore.appendRuntimeEvent(SESSION_ID, RUN_ID, event);
      const checkpoint = buildHistoryCompactCheckpoint({
        sessionId: SESSION_ID,
        coveredRuntimeEvents: runtimeEvents.slice(0, 2),
        summary: 'User requested a public test run.',
      });
      await agentRunStore.appendEvent(SESSION_ID, RUN_ID, {
        ...runEvent('checkpoint-recorded', 'history_compact_checkpoint_recorded'),
        data: { checkpoint },
      });
      await agentRunStore.appendEvent(
        SESSION_ID,
        RUN_ID,
        runEvent('run-completed', 'run_completed'),
      );

      const events: TaskEvent[] = [
        {
          type: 'task_run_created',
          id: 'task-created',
          taskRunId: TASK_RUN_ID,
          ts: 1,
          taskId: 'task-1',
          configId: 'config-1',
        },
        {
          type: 'task_attempt_started',
          id: 'attempt-started',
          taskRunId: TASK_RUN_ID,
          ts: 2,
          attemptId: ATTEMPT_ID,
        },
        {
          type: 'task_attempt_execution_linked',
          id: 'execution-linked',
          taskRunId: TASK_RUN_ID,
          ts: 3,
          attemptId: ATTEMPT_ID,
          evidence: taskAttemptExecutionEvidence({
            taskRunId: TASK_RUN_ID,
            attemptId: ATTEMPT_ID,
            sessionId: SESSION_ID,
            agentRunId: RUN_ID,
            invocationId: INVOCATION_ID,
            turnId: TURN_ID,
            runtimeEvents,
          }),
        },
        {
          type: 'heavy_task_self_check_recorded',
          id: 'self-check-recorded',
          taskRunId: TASK_RUN_ID,
          ts: 4,
          selfCheck: acceptedSelfCheck(),
        },
        {
          type: 'task_attempt_completed',
          id: 'attempt-completed',
          taskRunId: TASK_RUN_ID,
          ts: 5,
          attemptId: ATTEMPT_ID,
          status: 'completed',
        },
        {
          type: 'task_run_completed',
          id: 'task-completed',
          taskRunId: TASK_RUN_ID,
          ts: 6,
          result: { passed: true, taxonomy: 'passed' },
        },
      ];
      for (const event of events) await taskRunStore.appendEvent(TASK_RUN_ID, event);

      const inspected = await inspectTaskRun(
        { taskRunStore, agentRunStore, runtimeEventStore },
        TASK_RUN_ID,
      );

      assert.equal(inspected.schemaVersion, TASK_RUN_INSPECT_SCHEMA_VERSION);
      assert.deepEqual(inspected.taskEventSource.coverage, {
        lowWater: {
          ledger: 'task_event',
          streamId: TASK_RUN_ID,
          sequence: 0,
          eventId: 'task-created',
        },
        highWater: {
          ledger: 'task_event',
          streamId: TASK_RUN_ID,
          sequence: 5,
          eventId: 'task-completed',
        },
        eventCount: 6,
      });
      assert.equal(inspected.taskRun.result?.taxonomy, 'passed');
      assert.equal(inspected.attempts[0]?.agentRuns[0]?.coverageStatus, 'matched');
      assert.equal(inspected.attempts[0]?.agentRuns[0]?.runtimeEventCount, 4);
      assert.deepEqual(inspected.attempts[0]?.agentRuns[0]?.tools, {
        callCount: 1,
        responseCount: 1,
        errorResponseCount: 0,
        callsWithoutResponse: [],
        responsesWithoutCall: [],
      });
      assert.equal(
        inspected.attempts[0]?.agentRuns[0]?.compactionCheckpoints[0]?.checkpointId,
        checkpoint.checkpointId,
      );
      assert.equal(inspected.attempts[0]?.selfChecks[0]?.freshness, 'unknown');
      assert.equal(
        inspected.diagnostics.some((item) => item.code === 'self_check_source_unknown'),
        true,
      );
      const tree = renderTaskRunInspectTree(inspected);
      assert.match(tree, /TaskRun task-run-1 \[completed\]/);
      assert.match(tree, /AgentRun run-1 \[completed\]/);
      assert.match(tree, /Runtime Events runtime_event:run-1 0–3 \[matched\]/);
      assert.match(tree, /Compaction hcheckpoint-/);
      assert.match(tree, /Self-check self-check-1 \[pass; unknown\]/);
    });
  });

  test('fails coverage closed and reports unknown tool outcomes without copying payloads', async () => {
    await withStores(async ({ taskRunStore, agentRunStore, runtimeEventStore }) => {
      const runtimeEvents = [
        runtimeEvent('runtime-call', {
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-pending',
            name: 'Write',
            args: { path: 'secret.txt', content: 'secret' },
          },
        }),
        runtimeEvent('runtime-complete', {
          role: 'system',
          author: 'system',
          status: 'failed',
          actions: { endInvocation: true },
        }),
      ];
      await agentRunStore.createRun(runHeader({ status: 'failed', failureClass: 'tool_failed' }));
      await agentRunStore.appendEvent(SESSION_ID, RUN_ID, {
        ...runEvent('invalid-checkpoint', 'history_compact_checkpoint_recorded'),
        data: { checkpoint: { kind: 'maka.history_compact_checkpoint', version: 2 } },
      });
      await agentRunStore.appendEvent(SESSION_ID, RUN_ID, runEvent('run-failed', 'run_failed'));
      for (const event of runtimeEvents)
        await runtimeEventStore.appendRuntimeEvent(SESSION_ID, RUN_ID, event);
      const evidence = taskAttemptExecutionEvidence({
        taskRunId: TASK_RUN_ID,
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        agentRunId: RUN_ID,
        runtimeEvents,
      });
      evidence.runtimeCoverage!.highWater.eventId = 'not-the-terminal-event';
      const events: TaskEvent[] = [
        {
          type: 'task_run_created',
          id: 'task-created',
          taskRunId: TASK_RUN_ID,
          ts: 1,
          taskId: 'task-1',
          configId: 'config-1',
        },
        {
          type: 'task_attempt_started',
          id: 'attempt-started',
          taskRunId: TASK_RUN_ID,
          ts: 2,
          attemptId: ATTEMPT_ID,
        },
        {
          type: 'task_attempt_execution_linked',
          id: 'execution-linked',
          taskRunId: TASK_RUN_ID,
          ts: 3,
          attemptId: ATTEMPT_ID,
          evidence,
        },
      ];
      for (const event of events) await taskRunStore.appendEvent(TASK_RUN_ID, event);

      const inspected = await inspectTaskRun(
        { taskRunStore, agentRunStore, runtimeEventStore },
        TASK_RUN_ID,
      );

      assert.equal(inspected.attempts[0]?.agentRuns[0]?.coverageStatus, 'mismatch');
      assert.deepEqual(inspected.attempts[0]?.agentRuns[0]?.tools.callsWithoutResponse, [
        {
          toolCallId: 'tool-pending',
          toolName: 'Write',
          eventId: 'runtime-call',
        },
      ]);
      assert.equal(
        inspected.diagnostics.some((item) => item.code === 'runtime_coverage_mismatch'),
        true,
      );
      assert.equal(
        inspected.diagnostics.some((item) => item.code === 'tool_response_missing'),
        true,
      );
      assert.equal(
        inspected.diagnostics.some((item) => item.code === 'compaction_checkpoint_invalid'),
        true,
      );
      assert.equal(
        inspected.attempts[0]?.agentRuns[0]?.compactionCheckpoints[0]?.validation,
        'invalid',
      );
      assert.equal(JSON.stringify(inspected).includes('secret.txt'), false);
      assert.match(
        inspected.diagnostics.find((item) => item.code === 'tool_response_missing')?.message ?? '',
        /side effects are unknown/,
      );
    });
  });

  test('keeps legacy unknowns visible when AgentRun source facts or Self-check scope are absent', async () => {
    await withStores(async ({ taskRunStore, agentRunStore, runtimeEventStore }) => {
      const events: TaskEvent[] = [
        {
          type: 'task_run_created',
          id: 'task-created',
          taskRunId: TASK_RUN_ID,
          ts: 1,
          taskId: 'task-1',
          configId: 'config-1',
        },
        {
          type: 'task_attempt_started',
          id: 'attempt-started',
          taskRunId: TASK_RUN_ID,
          ts: 2,
          attemptId: ATTEMPT_ID,
        },
        {
          type: 'task_attempt_execution_linked',
          id: 'legacy-link',
          taskRunId: TASK_RUN_ID,
          ts: 3,
          attemptId: ATTEMPT_ID,
          evidence: {
            schemaVersion: 'maka.execution_evidence_ref.v1',
            execution: { sessionId: SESSION_ID, agentRunId: 'missing-run' },
            task: { taskRunId: TASK_RUN_ID, attemptId: ATTEMPT_ID },
          },
        },
        {
          type: 'heavy_task_self_check_recorded',
          id: 'legacy-self-check',
          taskRunId: TASK_RUN_ID,
          ts: 4,
          selfCheck: acceptedSelfCheck(null),
        },
      ];
      for (const event of events) await taskRunStore.appendEvent(TASK_RUN_ID, event);

      const inspected = await inspectTaskRun(
        { taskRunStore, agentRunStore, runtimeEventStore },
        TASK_RUN_ID,
      );

      assert.equal(inspected.attempts[0]?.agentRuns[0]?.identity?.agentRunId, 'missing-run');
      assert.equal(inspected.attempts[0]?.agentRuns[0]?.coverageStatus, 'source_missing');
      assert.equal(inspected.unscopedSelfChecks[0]?.selfCheckId, 'self-check-1');
      assert.equal(
        inspected.diagnostics.some((item) => item.code === 'agent_run_unavailable'),
        true,
      );
      assert.equal(
        inspected.diagnostics.some((item) => item.code === 'self_check_source_unknown'),
        true,
      );
      assert.match(
        renderTaskRunInspectTree(inspected),
        /Self-check self-check-1 \[pass; unknown\] \(unscoped\)/,
      );
    });
  });
});

const TASK_RUN_ID = 'task-run-1';
const ATTEMPT_ID = 'attempt-1';
const SESSION_ID = 'session-1';
const RUN_ID = 'run-1';
const INVOCATION_ID = 'invocation-1';
const TURN_ID = 'turn-1';

async function withStores(
  run: (stores: {
    taskRunStore: ReturnType<typeof createInMemoryTaskRunStore>;
    agentRunStore: ReturnType<typeof createSqliteAgentRunStore>;
    runtimeEventStore: ReturnType<typeof createWorkspaceRuntimeStore>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-task-run-inspect-'));
  try {
    await run({
      taskRunStore: createInMemoryTaskRunStore(),
      agentRunStore: createSqliteAgentRunStore(root),
      runtimeEventStore: createWorkspaceRuntimeStore(root),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runHeader(overrides: Partial<AgentRunHeader> = {}): AgentRunHeader {
  return {
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 10,
    completedAt: 10,
    ...overrides,
  };
}

function runEvent(id: string, type: AgentRunEvent['type']): AgentRunEvent {
  return { id, type, runId: RUN_ID, sessionId: SESSION_ID, turnId: TURN_ID, ts: 10 };
}

function runtimeEvent(id: string, overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id,
    invocationId: INVOCATION_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    ts: 5,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

function acceptedSelfCheck(attemptId: string | null = ATTEMPT_ID): HeavyTaskSemanticSelfCheckState {
  return {
    schemaVersion: 1,
    selfCheckId: 'self-check-1',
    taskRunId: TASK_RUN_ID,
    ...(attemptId ? { attemptId } : {}),
    ts: 4,
    status: 'pass',
    publicReason: 'Public test completed.',
    commandEvidence: [{ command: 'npm test', exitCode: 0, outputExcerpt: 'passed' }],
    artifactEvidence: [],
    guard: {
      status: 'accepted',
      checkedAt: 4,
      categories: [],
      publicReason: 'Accepted public evidence.',
    },
    source: { kind: 'model_tool', toolCallId: 'self-check-tool' },
  };
}
