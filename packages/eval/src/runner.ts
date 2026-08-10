import {
  expandExperiment,
  type ExperimentCell,
  type ExperimentSpec,
  type JsonObject,
} from './experiment.js';
import {
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
  runAttempt<T>(
    input: { readonly cell: ExperimentCell; readonly signal?: AbortSignal },
    operation: (attempt: {
      readonly context: SubjectExecutionContext;
      verify(subject: SubjectExecutionResult): Promise<ExecutorVerification>;
    }) => Promise<T>,
  ): Promise<
    | { readonly kind: 'settled'; readonly value: T }
    | { readonly kind: 'indeterminate'; readonly value?: T }
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
          execution = await subject.execute({
            cell,
            context: { ...context, ...(signal ? { signal } : {}) },
          });
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
          const verified = await verify(execution);
          return {
            score: verified.score,
            usage: execution.usage,
            costUsd: execution.costUsd,
            durationMs: execution.durationMs,
            status: execution.status === 'failed' ? 'subject_failed' : verified.status,
            failureReason: execution.failureReason ?? verified.failureReason,
            artifacts: [...execution.artifacts, ...verified.artifacts],
          };
        } catch {
          return failure('infra_failed', 'verification failed', execution);
        }
      },
    );
    return attempt.kind === 'settled'
      ? attempt.value
      : (attempt.value ?? failure('indeterminate', 'executor cleanup did not settle'));
  } catch {
    return failure('infra_failed', 'executor preparation failed');
  }
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
