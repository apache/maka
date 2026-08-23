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

import { randomUUID } from 'node:crypto';
import { chmod, lstat, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { redactSecrets } from '@maka/core/redaction';
import { resolveRootControlNamespace } from '@maka/storage/root-authority';
import { z } from 'zod';
import {
  isCandidateStartupAttemptId,
  type CandidateStartupFailure,
} from '../candidate-startup-failure.js';

export const RUNTIME_HOST_STARTUP_DIAGNOSTIC_FILE = 'startup-diagnostic.json';

const STARTUP_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
const MAX_STARTUP_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_ERROR_CHAIN_ENTRIES = 4;
const MAX_ERROR_TEXT_BYTES = 1_024;
const MAX_LOG_ENTRIES = 4;
const MAX_LOG_TEXT_BYTES = 1_536;
const MAX_LABEL_BYTES = 128;
const MAX_RETAINED_ATTEMPT_DIAGNOSTICS = 32;
const ATTEMPT_DIAGNOSTIC_RETENTION_MS = 24 * 60 * 60 * 1_000;

const boundedStringSchema = (maximumBytes: number) =>
  z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= maximumBytes);
const candidateStartupErrorSummarySchema = z
  .object({
    name: boundedStringSchema(MAX_LABEL_BYTES).optional(),
    code: z.union([boundedStringSchema(MAX_LABEL_BYTES), z.number().finite()]).optional(),
    message: boundedStringSchema(MAX_ERROR_TEXT_BYTES),
  })
  .strict();
const candidateStartupDiagnosticSchema = z
  .object({
    schemaVersion: z.literal(STARTUP_DIAGNOSTIC_SCHEMA_VERSION),
    rootId: z.string().regex(/^[a-f0-9]{64}$/u),
    startupAttemptId: z.string().refine(isCandidateStartupAttemptId),
    candidatePid: z.number().int().positive().safe(),
    capturedAt: boundedStringSchema(MAX_LABEL_BYTES).refine((value) =>
      Number.isFinite(Date.parse(value)),
    ),
    reason: z.enum([
      'stored_data_incompatible',
      'operational_state_migration_blocked',
      'local_ipc_security_failed',
      'internal_startup_failure',
    ]),
    errorChain: z.array(candidateStartupErrorSummarySchema).min(1).max(MAX_ERROR_CHAIN_ENTRIES),
    logs: z.array(boundedStringSchema(MAX_LOG_TEXT_BYTES)).max(MAX_LOG_ENTRIES),
  })
  .strict();

export type CandidateStartupDiagnostic = z.infer<typeof candidateStartupDiagnosticSchema>;

export class CandidateStartupDiagnosticError extends Error {
  constructor(
    readonly code: 'invalid_startup_diagnostic' | 'startup_diagnostic_io_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CandidateStartupDiagnosticError';
  }
}

export function resolveCandidateStartupDiagnosticPath(
  rootId: string,
  startupAttemptId?: string,
): string {
  assertRootId(rootId);
  if (startupAttemptId !== undefined) assertStartupAttemptId(startupAttemptId);
  const filename = startupAttemptId
    ? `startup-diagnostic.${startupAttemptId}.json`
    : RUNTIME_HOST_STARTUP_DIAGNOSTIC_FILE;
  return join(resolveRootControlNamespace(), rootId, filename);
}

export async function writeCandidateStartupDiagnostic(input: {
  readonly rootId: string;
  readonly startupAttemptId: string;
  readonly failure: CandidateStartupFailure;
  readonly error: unknown;
  readonly logs?: readonly string[];
}): Promise<void> {
  const path = resolveCandidateStartupDiagnosticPath(input.rootId, input.startupAttemptId);
  const document: CandidateStartupDiagnostic = {
    schemaVersion: STARTUP_DIAGNOSTIC_SCHEMA_VERSION,
    rootId: input.rootId,
    startupAttemptId: input.startupAttemptId,
    candidatePid: process.pid,
    capturedAt: new Date().toISOString(),
    reason: input.failure.reason,
    errorChain: summarizeErrorChain(input.error),
    logs: (input.logs ?? [])
      .slice(-MAX_LOG_ENTRIES)
      .map((entry) => boundedDiagnosticText(entry, MAX_LOG_TEXT_BYTES)),
  };
  const contents = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > MAX_STARTUP_DIAGNOSTIC_BYTES) {
    throw new CandidateStartupDiagnosticError(
      'invalid_startup_diagnostic',
      'Runtime Host startup diagnostic exceeded its size limit',
    );
  }

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let replaced = false;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    replaced = true;
    await syncDirectory(dirname(path));
  } catch (error) {
    if (error instanceof CandidateStartupDiagnosticError) throw error;
    throw new CandidateStartupDiagnosticError(
      'startup_diagnostic_io_failed',
      'Unable to preserve the Runtime Host startup diagnostic',
      { cause: error },
    );
  } finally {
    if (!replaced) await unlink(temporaryPath).catch(() => undefined);
  }
  await pruneCandidateStartupDiagnostics(input.rootId, input.startupAttemptId).catch(
    () => undefined,
  );
}

export async function readCandidateStartupDiagnostic(
  rootId: string,
  startupAttemptId?: string,
): Promise<CandidateStartupDiagnostic | undefined> {
  const path = resolveCandidateStartupDiagnosticPath(rootId, startupAttemptId);
  let contents: string;
  try {
    const diagnosticStat = await lstat(path);
    if (!diagnosticStat.isFile() || diagnosticStat.size > MAX_STARTUP_DIAGNOSTIC_BYTES) {
      throw new CandidateStartupDiagnosticError(
        'invalid_startup_diagnostic',
        'Runtime Host startup diagnostic must be a bounded regular file',
      );
    }
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    if (error instanceof CandidateStartupDiagnosticError) throw error;
    throw new CandidateStartupDiagnosticError(
      'startup_diagnostic_io_failed',
      'Unable to read the Runtime Host startup diagnostic',
      { cause: error },
    );
  }
  try {
    return decodeCandidateStartupDiagnostic(
      JSON.parse(contents) as unknown,
      rootId,
      startupAttemptId,
    );
  } catch (error) {
    if (error instanceof CandidateStartupDiagnosticError) throw error;
    throw new CandidateStartupDiagnosticError(
      'invalid_startup_diagnostic',
      'Runtime Host startup diagnostic is invalid',
      { cause: error },
    );
  }
}

export async function selectCandidateStartupDiagnostic(
  rootId: string,
  startupAttemptId: string,
): Promise<void> {
  const attemptPath = resolveCandidateStartupDiagnosticPath(rootId, startupAttemptId);
  const selectedPath = resolveCandidateStartupDiagnosticPath(rootId);
  await readCandidateStartupDiagnostic(rootId, startupAttemptId);
  try {
    await rename(attemptPath, selectedPath);
    await syncDirectory(dirname(selectedPath));
  } catch (error) {
    throw new CandidateStartupDiagnosticError(
      'startup_diagnostic_io_failed',
      'Unable to select the Runtime Host startup diagnostic',
      { cause: error },
    );
  }
}

export async function clearCandidateStartupDiagnostic(
  rootId: string,
  startupAttemptId?: string,
): Promise<void> {
  const path = resolveCandidateStartupDiagnosticPath(rootId, startupAttemptId);
  await unlink(path).catch((error: unknown) => {
    if (!isNodeError(error, 'ENOENT')) throw error;
  });
}

export async function clearSelectedCandidateStartupDiagnostic(
  rootId: string,
  expectedStartupAttemptId: string,
): Promise<boolean> {
  assertStartupAttemptId(expectedStartupAttemptId);
  const diagnostic = await readCandidateStartupDiagnostic(rootId);
  if (!diagnostic || diagnostic.startupAttemptId !== expectedStartupAttemptId) return false;
  await clearCandidateStartupDiagnostic(rootId);
  return true;
}

function decodeCandidateStartupDiagnostic(
  value: unknown,
  expectedRootId: string,
  expectedStartupAttemptId?: string,
): CandidateStartupDiagnostic {
  const diagnostic = candidateStartupDiagnosticSchema.parse(value);
  if (diagnostic.rootId !== expectedRootId) {
    throw new CandidateStartupDiagnosticError(
      'invalid_startup_diagnostic',
      'Runtime Host startup diagnostic belongs to a different storage root',
    );
  }
  if (
    expectedStartupAttemptId !== undefined &&
    diagnostic.startupAttemptId !== expectedStartupAttemptId
  ) {
    throw new CandidateStartupDiagnosticError(
      'invalid_startup_diagnostic',
      'Runtime Host startup diagnostic belongs to a different Candidate attempt',
    );
  }
  return diagnostic;
}

function summarizeErrorChain(error: unknown): z.infer<typeof candidateStartupErrorSummarySchema>[] {
  const summaries: z.infer<typeof candidateStartupErrorSummarySchema>[] = [];
  const visited = new Set<object>();
  let current: unknown = error;
  while (summaries.length < MAX_ERROR_CHAIN_ENTRIES) {
    if (typeof current !== 'object' || current === null || visited.has(current)) {
      if (summaries.length === 0) {
        summaries.push({ message: boundedDiagnosticText(String(current), MAX_ERROR_TEXT_BYTES) });
      }
      break;
    }
    visited.add(current);
    const candidate = current as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    summaries.push({
      ...(typeof candidate.name === 'string'
        ? { name: boundedDiagnosticText(candidate.name, MAX_LABEL_BYTES) }
        : {}),
      ...(typeof candidate.code === 'string' ||
      (typeof candidate.code === 'number' && Number.isFinite(candidate.code))
        ? {
            code:
              typeof candidate.code === 'string'
                ? boundedDiagnosticText(candidate.code, MAX_LABEL_BYTES)
                : candidate.code,
          }
        : {}),
      message: boundedDiagnosticText(
        typeof candidate.message === 'string' ? candidate.message : String(current),
        MAX_ERROR_TEXT_BYTES,
      ),
    });
    if (candidate.cause !== undefined) {
      current = candidate.cause;
      continue;
    }
    if (current instanceof AggregateError && current.errors.length > 0) {
      [current] = current.errors;
      continue;
    }
    break;
  }
  return summaries;
}

function boundedDiagnosticText(value: string, maximumBytes: number): string {
  return truncateUtf8(redactSecrets(value), maximumBytes, '\n<diagnostic truncated>');
}

function assertRootId(rootId: string): void {
  if (!/^[a-f0-9]{64}$/u.test(rootId)) {
    throw new TypeError('Runtime Host startup diagnostic requires a valid root id');
  }
}

function assertStartupAttemptId(startupAttemptId: string): void {
  if (!isCandidateStartupAttemptId(startupAttemptId)) {
    throw new TypeError('Runtime Host startup diagnostic requires a valid attempt id');
  }
}

async function pruneCandidateStartupDiagnostics(
  rootId: string,
  retainedAttemptId: string,
): Promise<void> {
  const controlDirectory = dirname(resolveCandidateStartupDiagnosticPath(rootId));
  const entries = await readdir(controlDirectory, { withFileTypes: true });
  const attempts = await Promise.all(
    entries.flatMap((entry) => {
      if (!entry.isFile()) return [];
      const startupAttemptId = startupAttemptIdFromFilename(entry.name);
      if (!startupAttemptId) return [];
      const path = join(controlDirectory, entry.name);
      return [
        lstat(path).then((fileStat) => ({
          startupAttemptId,
          path,
          mtimeMs: fileStat.mtimeMs,
        })),
      ];
    }),
  );
  attempts.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const expiredBefore = Date.now() - ATTEMPT_DIAGNOSTIC_RETENTION_MS;
  await Promise.all(
    attempts.map(async (attempt, index) => {
      if (attempt.startupAttemptId === retainedAttemptId) return;
      if (index < MAX_RETAINED_ATTEMPT_DIAGNOSTICS && attempt.mtimeMs >= expiredBefore) return;
      await unlink(attempt.path).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) throw error;
      });
    }),
  );
}

function startupAttemptIdFromFilename(filename: string): string | undefined {
  const prefix = 'startup-diagnostic.';
  const suffix = '.json';
  if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) return undefined;
  const startupAttemptId = filename.slice(prefix.length, -suffix.length);
  return isCandidateStartupAttemptId(startupAttemptId) ? startupAttemptId : undefined;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
