import type { JsonObject } from './experiment.js';

export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

export type EvalResultStatus = 'completed' | 'subject_failed' | 'infra_failed' | 'indeterminate';

export interface EvalResult {
  readonly score: number | null;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
  readonly durationMs: number;
  readonly status: EvalResultStatus;
  readonly failureReason: string | null;
  readonly artifacts: readonly JsonObject[];
}

export interface CellAttempt {
  readonly cellId: string;
  readonly sequence: number;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly result: EvalResult;
}

export function isReplaceableAttempt(attempt: CellAttempt): boolean {
  return attempt.result.status === 'infra_failed' || attempt.result.status === 'indeterminate';
}

export function selectCellResult(attempts: readonly CellAttempt[]): CellAttempt | undefined {
  return [...attempts]
    .sort((left, right) => left.sequence - right.sequence)
    .find((attempt) => !isReplaceableAttempt(attempt));
}
