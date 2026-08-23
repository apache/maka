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

import {
  expandExperiment,
  type ExperimentCell,
  type ExperimentSpec,
  type JsonObject,
} from './experiment.js';
import {
  decodeEvalResult,
  type CellAttempt,
  type EvalResult,
  isReplaceableAttempt,
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
    readonly environment?: Readonly<Record<string, string>>;
    readonly credentialEnvironment: Readonly<Record<string, string>>;
    readonly captureStdout?: boolean;
  }) => Promise<{
    readonly termination: 'exited' | 'framework_timeout';
    readonly exitCode: number;
    readonly stdout: string;
    readonly diagnostic?: {
      readonly category:
        | 'none'
        | 'unstructured-output'
        | 'result-frame-missing'
        | 'result-frame-invalid'
        | 'result-frame-ambiguous'
        | 'result-frame-oversize'
        | 'execution-scope-unavailable';
      readonly bytes?: number;
      readonly sha256?: string;
    };
  }>;
}

export interface SubjectAdapter {
  readonly kind: ExperimentCell['subject']['kind'];
  validate?(cell: ExperimentCell): void;
  prepare?(input: {
    readonly spec: ExperimentSpec;
    readonly cells: readonly ExperimentCell[];
  }): Promise<void>;
  canReuse?(input: { readonly cell: ExperimentCell; readonly attempt: CellAttempt }): boolean;
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

export type ExecutorPreparationCode =
  | 'cancelled'
  | 'preparation-failed'
  | 'spawn-failed'
  | 'exit-before-ready'
  | 'invalid-ready'
  | 'framework-version-mismatch';

export type ExecutorAttemptOutcome =
  | { readonly kind: 'settled'; readonly value: EvalResult }
  | {
      readonly kind: 'indeterminate';
      readonly cause: 'host-cancelled' | 'cleanup-unconfirmed';
      readonly value?: EvalResult;
    }
  | {
      readonly kind: 'not_started';
      readonly code: ExecutorPreparationCode;
      readonly artifacts: readonly JsonObject[];
    };

export interface ExperimentExecutor {
  readonly kind: string;
  validate?(cell: ExperimentCell): void;
  runAttempt(
    input: {
      readonly cell: ExperimentCell;
      readonly subjectCredentialNames: readonly string[];
      readonly signal?: AbortSignal;
    },
    operation: (attempt: {
      readonly context: SubjectExecutionContext;
      verify(): Promise<ExecutorVerification>;
    }) => Promise<EvalResult>,
  ): Promise<ExecutorAttemptOutcome>;
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
    const subjectCredentialNames = [
      ...new Set(input.spec.subjects.flatMap((subject) => subject.credentials)),
    ];
    if (input.executor.kind !== input.spec.executor.kind) throw new Error('executor kind mismatch');

    for (const cell of selected) {
      input.executor.validate?.(cell);
      const subject = subjects.get(cell.subject.kind);
      if (!subject) throw new Error(`missing subject adapter: ${cell.subject.kind}`);
      subject.validate?.(cell);
    }
    for (const subject of subjects.values()) {
      const cellsForSubject = selected.filter((cell) => cell.subject.kind === subject.kind);
      if (cellsForSubject.length > 0) {
        await subject.prepare?.({ spec: input.spec, cells: cellsForSubject });
      }
    }
    await runTaskGroups(
      groupTaskCells(selected),
      input.spec.execution.maxConcurrentTaskGroups,
      input.signal,
      async (group, fail) => {
        if (input.signal?.aborted) return;
        const operations = group.map(async (cell) => {
          if (input.signal?.aborted) return;
          const attempts = await input.store.list(cell.id);
          if (input.signal?.aborted) return;
          const subject = subjects.get(cell.subject.kind)!;
          if (selectSubjectResult(attempts, subject, cell)) return;
          const startedAt = (input.now ?? Date.now)();
          const result = await executeCell(
            input.executor,
            subject,
            cell,
            subjectCredentialNames,
            input.signal,
          );
          await input.store.append({
            cellId: cell.id,
            sequence: (attempts.at(-1)?.sequence ?? 0) + 1,
            startedAt,
            completedAt: (input.now ?? Date.now)(),
            result,
          });
        });
        await Promise.allSettled(
          operations.map((operation) =>
            operation.catch((error: unknown) => {
              fail(error);
              throw error;
            }),
          ),
        );
      },
    );

    return new Map(
      (
        await Promise.all(
          cells.map(
            async (cell) =>
              [
                cell.id,
                selectSubjectResult(
                  await input.store.list(cell.id),
                  subjects.get(cell.subject.kind)!,
                  cell,
                ),
              ] as const,
          ),
        )
      ).flatMap(([cellId, result]) => (result ? [[cellId, result] as const] : [])),
    );
  });
}

function selectSubjectResult(
  attempts: readonly CellAttempt[],
  subject: SubjectAdapter,
  cell: ExperimentCell,
): CellAttempt | undefined {
  return [...attempts]
    .sort((left, right) => left.sequence - right.sequence)
    .find(
      (attempt) =>
        !isReplaceableAttempt(attempt) && (subject.canReuse?.({ cell, attempt }) ?? true),
    );
}

function groupTaskCells(cells: readonly ExperimentCell[]): ExperimentCell[][] {
  const groups = new Map<string, ExperimentCell[]>();
  for (const cell of cells) {
    const key = `${cell.task.id}\u0000${cell.repetition}`;
    const group = groups.get(key);
    if (group) group.push(cell);
    else groups.set(key, [cell]);
  }
  return [...groups.values()];
}

async function runTaskGroups<T>(
  groups: readonly T[],
  maximum: number,
  signal: AbortSignal | undefined,
  run: (group: T, fail: (error: unknown) => void) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
  };
  const worker = async () => {
    for (;;) {
      if (failed || signal?.aborted) return;
      const group = groups[next];
      next += 1;
      if (group === undefined) return;
      try {
        await run(group, fail);
      } catch (error) {
        fail(error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(maximum, groups.length) }, async () => await worker()),
  );
  if (failed) throw failure;
}

async function executeCell(
  executor: ExperimentExecutor,
  subject: SubjectAdapter,
  cell: ExperimentCell,
  subjectCredentialNames: readonly string[],
  signal?: AbortSignal,
): Promise<EvalResult> {
  try {
    const attempt = await executor.runAttempt(
      { cell, subjectCredentialNames, ...(signal ? { signal } : {}) },
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
          const verified = decodeVerification(await verify());
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
    if (attempt.kind === 'not_started') {
      const cancelled = attempt.code === 'cancelled';
      return failure(
        cancelled ? 'indeterminate' : 'infra_failed',
        cancelled ? 'executor preparation cancelled' : 'executor preparation failed',
        undefined,
        attempt.artifacts,
      );
    }
    if (attempt.kind === 'settled') return decodeEvalResult(attempt.value);
    const failureReason =
      attempt.cause === 'host-cancelled'
        ? 'executor cancelled before verification completed'
        : 'executor cleanup did not settle';
    if (!attempt.value) return failure('indeterminate', failureReason);
    const partial = decodeEvalResult(attempt.value);
    return {
      ...partial,
      score: null,
      status: 'indeterminate',
      failureReason,
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
  artifacts: readonly JsonObject[] = subject?.artifacts ?? [],
): EvalResult {
  return {
    score: null,
    usage: subject?.usage ?? null,
    costUsd: subject?.costUsd ?? null,
    durationMs: subject?.durationMs ?? 0,
    status,
    failureReason,
    artifacts,
  };
}

function selectCells(cells: readonly ExperimentCell[], ids?: readonly string[]): ExperimentCell[] {
  if (!ids) return [...cells];
  const selected = new Set(ids);
  const known = new Set(cells.map(({ id }) => id));
  for (const id of selected) if (!known.has(id)) throw new Error(`unknown experiment cell: ${id}`);
  return cells.filter(({ id }) => selected.has(id));
}
