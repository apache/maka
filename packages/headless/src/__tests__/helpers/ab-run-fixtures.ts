import {
  FIXED_PROMPT_WAL_SCHEMA_VERSION,
  type FixedPromptTaskCompletedEvent,
  type TaskRunOutput,
} from '../../fixed-prompt-controller.js';
import { tokenSummary } from './cell-output-fixtures.js';

export function harborOutput(input: {
  taskId: string;
  durationMs?: number;
  promptHash: string;
  reward?: number;
}): TaskRunOutput {
  return {
    harbor: { reward: input.reward ?? 1 },
    cell: {
      schemaVersion: 1,
      status: 'completed',
      promptHash: input.promptHash,
      tokenSummary: tokenSummary({ input: 4, output: 6, reasoning: 0, total: 10, costUsd: 0.01 }),
      toolSummary: {
        providerVisibleToolCount: 1,
        actualToolCalls: 1,
        actualToolNames: ['Bash'],
        actualToolCallCounts: { Bash: 1 },
      },
      steps: 1,
      durationMs: input.durationMs ?? 100,
      startedAt: 0,
      finishedAt: input.durationMs ?? 100,
      runtimeEventsPath: `/logs/${input.taskId}/runtime-events.jsonl`,
      runtimeRefs: {
        invocationId: `inv-${input.taskId}`,
        sessionId: `session-${input.taskId}`,
        runId: `run-${input.taskId}`,
        turnId: `turn-${input.taskId}`,
      },
    },
  };
}

export function completed(taskId: string, passed: boolean): FixedPromptTaskCompletedEvent {
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_completed',
    id: `event-${taskId}-${passed ? 'pass' : 'fail'}`,
    ts: 0,
    runId: 'run',
    roundId: 'round',
    taskId,
    status: 'completed',
    passed,
    scored: true,
    eligible: true,
    errorClass: passed ? undefined : 'verification_failed',
    promptHash: 'hash',
    tokenSummary: tokenSummary({ input: 1, output: 1, reasoning: 0, total: 2, costUsd: 0.01 }),
    tokenSummarySource: 'final',
    steps: 1,
    durationMs: 100,
    runtimeEventsPath: `/logs/${taskId}/runtime-events.jsonl`,
    harbor: { reward: passed ? 1 : 0 },
  };
}

export function idFactory(): () => string {
  let next = 0;
  return () => `id-${next++}`;
}
