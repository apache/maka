import { decodeJsonObject, type JsonObject } from './experiment.js';

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

export function decodeEvalResult(value: unknown, where = 'result'): EvalResult {
  const result = exact(value, where, [
    'score',
    'usage',
    'costUsd',
    'durationMs',
    'status',
    'failureReason',
    'artifacts',
  ]);
  if (
    !['completed', 'subject_failed', 'infra_failed', 'indeterminate'].includes(
      String(result.status),
    )
  ) {
    throw new Error(`${where}.status is invalid`);
  }
  if (result.failureReason !== null && typeof result.failureReason !== 'string') {
    throw new Error(`${where}.failureReason is invalid`);
  }
  if (!Array.isArray(result.artifacts)) {
    throw new Error(`${where}.artifacts is invalid`);
  }
  return {
    score: nullableNumber(result.score, `${where}.score`),
    usage: result.usage === null ? null : decodeUsage(result.usage, `${where}.usage`),
    costUsd: nullableNonnegative(result.costUsd, `${where}.costUsd`),
    durationMs: nonnegative(result.durationMs, `${where}.durationMs`),
    status: result.status as EvalResultStatus,
    failureReason: result.failureReason as string | null,
    artifacts: result.artifacts.map((artifact, index) =>
      decodeJsonObject(artifact, `${where}.artifacts[${index}]`),
    ),
  };
}

export function isReplaceableAttempt(attempt: CellAttempt): boolean {
  return attempt.result.status === 'infra_failed' || attempt.result.status === 'indeterminate';
}

export function selectCellResult(attempts: readonly CellAttempt[]): CellAttempt | undefined {
  return [...attempts]
    .sort((left, right) => left.sequence - right.sequence)
    .find((attempt) => !isReplaceableAttempt(attempt));
}

function decodeUsage(value: unknown, where: string): NormalizedUsage {
  const usage = exact(value, where, [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'totalTokens',
  ]);
  return Object.fromEntries(
    Object.entries(usage).map(([key, item]) => [key, nonnegative(item, `${where}.${key}`)]),
  ) as unknown as NormalizedUsage;
}

function exact(value: unknown, where: string, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  ) {
    throw new Error(`${where} fields are invalid`);
  }
  return record;
}

function nonnegative(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${where} is invalid`);
  }
  return value;
}

function nullableNumber(value: unknown, where: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where} is invalid`);
  return value;
}

function nullableNonnegative(value: unknown, where: string): number | null {
  return value === null ? null : nonnegative(value, where);
}
