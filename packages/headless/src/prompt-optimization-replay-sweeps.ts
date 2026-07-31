import type { FixedPromptControllerResult } from './fixed-prompt-controller.js';
import type { FixedPromptTaskWalEvent, FixedPromptWalEvent } from './fixed-prompt-wal-types.js';
import { isTaskEvent, taskEventMatchesPromptIdentity } from './prompt-optimization-replay-state.js';

export function replayControllerSweep(input: {
  events: readonly FixedPromptWalEvent[];
  runId: string;
  roundId: string;
  taskIds: readonly string[];
  expectedPromptHash: string;
  resumeFingerprint?: string;
  resultsTsvPath: string;
}): FixedPromptControllerResult | undefined {
  const requested = new Set(input.taskIds);
  const matched = input.events.filter(
    (event): event is FixedPromptTaskWalEvent =>
      isTaskEvent(event) &&
      event.runId === input.runId &&
      event.roundId === input.roundId &&
      requested.has(event.taskId),
  );
  if (matched.length === 0) return undefined;
  if (input.resumeFingerprint === undefined) {
    throw new Error(`RSI WAL replay requires a resume fingerprint for ${input.roundId}`);
  }

  const byTaskId = new Map<string, FixedPromptTaskWalEvent>();
  for (const event of matched) {
    if (event.resumeFingerprint !== input.resumeFingerprint) {
      throw new Error(`RSI WAL replay identity mismatch for ${event.roundId}/${event.taskId}`);
    }
    if (!taskEventMatchesPromptIdentity(event, input.expectedPromptHash)) {
      throw new Error(`RSI WAL replay prompt hash mismatch for ${event.roundId}/${event.taskId}`);
    }
    mergeReplayedTaskEvent(byTaskId, event);
  }

  if (byTaskId.size !== input.taskIds.length) return undefined;
  const orderedEvents = input.taskIds.map((taskId) => byTaskId.get(taskId)!);
  return {
    taskIds: [...input.taskIds],
    events: orderedEvents,
    totalTokens: sum(
      orderedEvents.map((event) =>
        'tokenSummary' in event ? (event.tokenSummary?.total ?? 0) : 0,
      ),
    ),
    totalCostUsd: sum(
      orderedEvents.map((event) =>
        'tokenSummary' in event ? (event.tokenSummary?.costUsd ?? 0) : 0,
      ),
    ),
    resultsTsvPath: input.resultsTsvPath,
  };
}

export function replayRequiredControllerSweep(
  input: Parameters<typeof replayControllerSweep>[0] & { missingEvidenceMessage: string },
): FixedPromptControllerResult {
  const result = replayControllerSweep(input);
  if (!result) throw new Error(input.missingEvidenceMessage);
  return result;
}

export function replayPromptBaselinePartition(
  input: Parameters<typeof replayControllerSweep>[0] & {
    partition: 'held-in' | 'held-out';
    required: boolean;
  },
): FixedPromptControllerResult | undefined {
  if (!input.required) return replayControllerSweep(input);
  return replayRequiredControllerSweep({
    ...input,
    missingEvidenceMessage: `RSI WAL replay missing required baseline ${input.partition} evidence for ${input.roundId}`,
  });
}

function mergeReplayedTaskEvent(
  byTaskId: Map<string, FixedPromptTaskWalEvent>,
  event: FixedPromptTaskWalEvent,
): void {
  const existing = byTaskId.get(event.taskId);
  if (!existing) {
    byTaskId.set(event.taskId, event);
    return;
  }
  if (existing.type === 'task_infra_failed') {
    byTaskId.set(event.taskId, event);
    return;
  }
  throw new Error(`RSI WAL replay duplicate task event for ${event.roundId}/${event.taskId}`);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
