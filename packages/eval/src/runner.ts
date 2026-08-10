import {
  expandExperiment,
  type ExperimentCell,
  type ExperimentSpec,
  type JsonObject,
} from './experiment.js';
import {
  decodeEvalResult,
  selectCellResult,
  type CellAttempt,
  type EvalResult,
  type NormalizedUsage,
} from './result.js';

export interface SubjectExecutionResult {
  readonly output?: string;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
  readonly durationMs: number;
  readonly status: 'completed' | 'failed' | 'infra_failed' | 'indeterminate';
  readonly failureReason: string | null;
  readonly artifacts: readonly JsonObject[];
}

export interface SubjectExecutionContext {
  readonly cwd: string;
  readonly taskInput: string;
  readonly metadata: JsonObject;
  readonly signal?: AbortSignal;
  readonly execute: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly credentialNames: readonly string[];
    readonly cancel?: { readonly command: string; readonly args: readonly string[] };
  }) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

export interface SubjectAdapter {
  readonly kind: ExperimentCell['subject']['kind'];
  validate?(cell: ExperimentCell): void;
  execute(input: {
    readonly cell: ExperimentCell;
    readonly context: SubjectExecutionContext;
  }): Promise<SubjectExecutionResult>;
}

export interface ExecutorVerification {
  readonly status: 'completed' | 'subject_failed' | 'infra_failed';
  readonly score: number | null;
  readonly failureReason: string | null;
  readonly artifacts: readonly JsonObject[];
}

export interface ExperimentExecutor {
  readonly kind: string;
  runAttempt(
    input: { readonly cell: ExperimentCell; readonly signal?: AbortSignal },
    operation: (attempt: {
      readonly context: SubjectExecutionContext;
      verify(subject: SubjectExecutionResult): Promise<ExecutorVerification>;
    }) => Promise<EvalResult>,
  ): Promise<
    | { readonly kind: 'settled'; readonly value: EvalResult }
    | { readonly kind: 'indeterminate'; readonly value?: EvalResult }
  >;
}

export interface AttemptStore {
  list(cellId: string): Promise<readonly CellAttempt[]>;
  append(attempt: CellAttempt): Promise<void>;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export async function runExperiment(input: {
  readonly spec: ExperimentSpec;
  readonly store: AttemptStore;
  readonly executor: ExperimentExecutor;
  readonly subjects: readonly SubjectAdapter[];
  readonly cellIds?: readonly string[];
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<ReadonlyMap<string, CellAttempt>> {
  return input.store.runExclusive(async () => {
    const cells = expandExperiment(input.spec);
    const selected = selectCells(cells, input.cellIds);
    const subjects = new Map(input.subjects.map((subject) => [subject.kind, subject]));
    if (input.executor.kind !== input.spec.executor.kind) throw new Error('executor kind mismatch');

    for (const cell of selected) {
      const subject = subjects.get(cell.subject.kind);
      if (!subject) throw new Error(`missing subject adapter: ${cell.subject.kind}`);
      subject.validate?.(cell);
      if (input.signal?.aborted) break;
      const attempts = await input.store.list(cell.id);
      if (selectCellResult(attempts)) continue;
      const startedAt = (input.now ?? Date.now)();
      const result = await executeCell(input.executor, subject, cell, input.signal);
      await input.store.append({
        cellId: cell.id,
        sequence: (attempts.at(-1)?.sequence ?? 0) + 1,
        startedAt,
        completedAt: (input.now ?? Date.now)(),
        result,
      });
    }

    return new Map(
      (
        await Promise.all(
          cells.map(
            async (cell) => [cell.id, selectCellResult(await input.store.list(cell.id))] as const,
          ),
        )
      ).flatMap(([cellId, result]) => (result ? [[cellId, result] as const] : [])),
    );
  });
}

async function executeCell(
  executor: ExperimentExecutor,
  subject: SubjectAdapter,
  cell: ExperimentCell,
  signal?: AbortSignal,
): Promise<EvalResult> {
  try {
    const attempt = await executor.runAttempt(
      { cell, ...(signal ? { signal } : {}) },
      async ({ context, verify }) => {
        let execution: SubjectExecutionResult;
        try {
          execution = decodeSubjectExecution(
            await subject.execute({
              cell,
              context: { ...context, ...(signal ? { signal } : {}) },
            }),
          );
        } catch {
          return failure('infra_failed', 'subject execution failed');
        }
        if (
          signal?.aborted ||
          execution.status === 'infra_failed' ||
          execution.status === 'indeterminate'
        ) {
          return fromUncertainSubject(execution, signal?.aborted === true);
        }
        try {
          const verified = decodeVerification(await verify(execution));
          return {
            score: verified.score,
            usage: execution.usage,
            costUsd: execution.costUsd,
            durationMs: execution.durationMs,
            status: settledStatus(execution.status, verified.status),
            failureReason:
              verified.status === 'infra_failed'
                ? verified.failureReason
                : (execution.failureReason ?? verified.failureReason),
            artifacts: [...execution.artifacts, ...verified.artifacts],
          };
        } catch {
          return failure('infra_failed', 'verification failed', execution);
        }
      },
    );
    if (attempt.kind === 'settled') return decodeEvalResult(attempt.value);
    if (!attempt.value) return failure('indeterminate', 'executor cleanup did not settle');
    const partial = decodeEvalResult(attempt.value);
    return {
      ...partial,
      score: null,
      status: 'indeterminate',
      failureReason: 'executor cleanup did not settle',
    };
  } catch {
    return failure('infra_failed', 'executor preparation failed');
  }
}

function decodeSubjectExecution(value: unknown): SubjectExecutionResult {
  const subject = exactRecord(
    value,
    ['usage', 'costUsd', 'durationMs', 'status', 'failureReason', 'artifacts'],
    ['output'],
  );
  if (
    subject.status !== 'completed' &&
    subject.status !== 'failed' &&
    subject.status !== 'infra_failed' &&
    subject.status !== 'indeterminate'
  ) {
    throw new Error('subject status is invalid');
  }
  if (subject.output !== undefined && typeof subject.output !== 'string') {
    throw new Error('subject output is invalid');
  }
  const decoded = decodeEvalResult({
    score: null,
    usage: subject.usage,
    costUsd: subject.costUsd,
    durationMs: subject.durationMs,
    status: subject.status === 'failed' ? 'subject_failed' : subject.status,
    failureReason: subject.failureReason,
    artifacts: subject.artifacts,
  });
  return {
    ...(subject.output === undefined ? {} : { output: subject.output }),
    usage: decoded.usage,
    costUsd: decoded.costUsd,
    durationMs: decoded.durationMs,
    status: subject.status,
    failureReason: decoded.failureReason,
    artifacts: decoded.artifacts,
  };
}

function decodeVerification(value: unknown): ExecutorVerification {
  const verification = exactRecord(value, ['status', 'score', 'failureReason', 'artifacts']);
  if (
    verification.status !== 'completed' &&
    verification.status !== 'subject_failed' &&
    verification.status !== 'infra_failed'
  ) {
    throw new Error('verification status is invalid');
  }
  const decoded = decodeEvalResult({
    score: verification.score,
    usage: null,
    costUsd: null,
    durationMs: 0,
    status: verification.status,
    failureReason: verification.failureReason,
    artifacts: verification.artifacts,
  });
  return {
    status: verification.status,
    score: decoded.score,
    failureReason: decoded.failureReason,
    artifacts: decoded.artifacts,
  };
}

function settledStatus(
  subject: SubjectExecutionResult['status'],
  verification: ExecutorVerification['status'],
): EvalResult['status'] {
  if (verification === 'infra_failed') return 'infra_failed';
  if (subject === 'failed' || verification === 'subject_failed') return 'subject_failed';
  return 'completed';
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('result envelope must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((field) => !Object.hasOwn(record, field)) ||
    Object.keys(record).some((field) => !allowed.has(field))
  ) {
    throw new Error('result envelope fields are invalid');
  }
  return record;
}

function fromUncertainSubject(subject: SubjectExecutionResult, cancelled: boolean): EvalResult {
  return {
    score: null,
    usage: subject.usage,
    costUsd: subject.costUsd,
    durationMs: subject.durationMs,
    status: cancelled
      ? 'indeterminate'
      : subject.status === 'infra_failed'
        ? 'infra_failed'
        : 'indeterminate',
    failureReason: subject.failureReason,
    artifacts: subject.artifacts,
  };
}

function failure(
  status: 'infra_failed' | 'indeterminate',
  failureReason: string,
  subject?: SubjectExecutionResult,
): EvalResult {
  return {
    score: null,
    usage: subject?.usage ?? null,
    costUsd: subject?.costUsd ?? null,
    durationMs: subject?.durationMs ?? 0,
    status,
    failureReason,
    artifacts: subject?.artifacts ?? [],
  };
}

function selectCells(cells: readonly ExperimentCell[], ids?: readonly string[]): ExperimentCell[] {
  if (!ids) return [...cells];
  const selected = new Set(ids);
  const known = new Set(cells.map(({ id }) => id));
  for (const id of selected) if (!known.has(id)) throw new Error(`unknown experiment cell: ${id}`);
  return cells.filter(({ id }) => selected.has(id));
}
