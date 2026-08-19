import { randomUUID } from 'node:crypto';
import { chmod, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { redactSecrets } from '@maka/core/redaction';
import { resolveRootControlNamespace } from '@maka/storage/root-authority';
import { z } from 'zod';
import type { CandidateStartupFailure } from '../candidate-startup-failure.js';

export const RUNTIME_HOST_STARTUP_DIAGNOSTIC_FILE = 'startup-diagnostic.json';

const STARTUP_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
const MAX_STARTUP_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_ERROR_CHAIN_ENTRIES = 4;
const MAX_ERROR_TEXT_BYTES = 1_024;
const MAX_LOG_ENTRIES = 4;
const MAX_LOG_TEXT_BYTES = 1_536;
const MAX_LABEL_BYTES = 128;

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

export function resolveCandidateStartupDiagnosticPath(rootId: string): string {
  assertRootId(rootId);
  return join(resolveRootControlNamespace(), rootId, RUNTIME_HOST_STARTUP_DIAGNOSTIC_FILE);
}

export async function writeCandidateStartupDiagnostic(input: {
  readonly rootId: string;
  readonly failure: CandidateStartupFailure;
  readonly error: unknown;
  readonly logs?: readonly string[];
}): Promise<void> {
  const path = resolveCandidateStartupDiagnosticPath(input.rootId);
  const document: CandidateStartupDiagnostic = {
    schemaVersion: STARTUP_DIAGNOSTIC_SCHEMA_VERSION,
    rootId: input.rootId,
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
}

export async function readCandidateStartupDiagnostic(
  rootId: string,
): Promise<CandidateStartupDiagnostic | undefined> {
  const path = resolveCandidateStartupDiagnosticPath(rootId);
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
    return decodeCandidateStartupDiagnostic(JSON.parse(contents) as unknown, rootId);
  } catch (error) {
    if (error instanceof CandidateStartupDiagnosticError) throw error;
    throw new CandidateStartupDiagnosticError(
      'invalid_startup_diagnostic',
      'Runtime Host startup diagnostic is invalid',
      { cause: error },
    );
  }
}

export async function clearCandidateStartupDiagnostic(rootId: string): Promise<void> {
  const path = resolveCandidateStartupDiagnosticPath(rootId);
  await unlink(path).catch((error: unknown) => {
    if (!isNodeError(error, 'ENOENT')) throw error;
  });
}

function decodeCandidateStartupDiagnostic(
  value: unknown,
  expectedRootId: string,
): CandidateStartupDiagnostic {
  const diagnostic = candidateStartupDiagnosticSchema.parse(value);
  if (diagnostic.rootId !== expectedRootId) {
    throw new CandidateStartupDiagnosticError(
      'invalid_startup_diagnostic',
      'Runtime Host startup diagnostic belongs to a different storage root',
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
