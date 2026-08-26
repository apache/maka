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

import { collapseHomePath, truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { arch as osArch, homedir, release as osRelease } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';

const SCHEMA_VERSION = 1 as const;
const RUN_MAX_BYTES = 16 * 1024;
export const MAIN_PROCESS_RECOVERY_LOG_MAX_BYTES = 256 * 1024;
const EVIDENCE_MAX_BYTES = MAIN_PROCESS_RECOVERY_LOG_MAX_BYTES + RUN_MAX_BYTES;
const ENTRY_TRUNCATION_MARKER = '\n<recovery log entry truncated>';
export const MAIN_PROCESS_RECOVERY_FLUSH_DEBOUNCE_MS = 2_000;
export const MAIN_PROCESS_RECOVERY_FLUSH_INTERVAL_MS = 5 * 60_000;
export const MAIN_PROCESS_RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface MainProcessRecoveryRun {
  readonly startedAt: string;
  readonly appVersion: string;
  readonly buildMode: 'dev' | 'packaged';
  readonly buildCommit: string | null;
  readonly electronVersion: string;
  readonly nodeVersion: string;
  readonly chromeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly osRelease: string;
}

export interface MainProcessRecoveryEvidence {
  readonly run: MainProcessRecoveryRun;
  readonly snapshotAt: string | null;
  readonly logs: readonly string[];
}

export interface MainProcessRecoveryJournal {
  readonly pending: MainProcessRecoveryEvidence | undefined;
  markDirty(): void;
  flushNow(): void;
  markClean(): void;
  discardPending(): void;
}

interface MainProcessRecoveryJournalInput {
  readonly root: string;
  readonly appVersion: string;
  readonly buildMode: 'dev' | 'packaged';
  readonly buildCommit: string | null;
  readonly logs: () => readonly string[];
  readonly onError: (error: unknown) => void;
  readonly now?: () => Date;
}

interface StoredEvidence {
  readonly schemaVersion: 1;
  readonly run: MainProcessRecoveryRun;
  readonly capturedAt: string | null;
  readonly logs: readonly string[];
}

const boundedStringSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 1_024);
const isoDateSchema = boundedStringSchema.refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
});
const recoveryRunSchema = z
  .object({
    startedAt: isoDateSchema,
    appVersion: boundedStringSchema,
    buildMode: z.enum(['dev', 'packaged']),
    buildCommit: boundedStringSchema.nullable(),
    electronVersion: boundedStringSchema,
    nodeVersion: boundedStringSchema,
    chromeVersion: boundedStringSchema,
    platform: z.enum([
      'aix',
      'android',
      'darwin',
      'freebsd',
      'haiku',
      'linux',
      'openbsd',
      'sunos',
      'win32',
      'cygwin',
      'netbsd',
    ]),
    arch: boundedStringSchema,
    osRelease: boundedStringSchema,
  })
  .strict();
const storedEvidenceSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    run: recoveryRunSchema,
    capturedAt: isoDateSchema.nullable(),
    logs: z.array(z.string()),
  })
  .strict();

export function createMainProcessRecoveryJournal(
  input: MainProcessRecoveryJournalInput,
): MainProcessRecoveryJournal {
  const now = input.now ?? (() => new Date());
  ensurePrivateDirectory(input.root);
  const activePath = join(input.root, 'active.json');
  const pendingPath = join(input.root, 'pending.json');
  const temporaryPath = join(input.root, '.active.json.tmp');
  const startupAt = now();
  rotatePriorRun({ activePath, pendingPath, temporaryPath }, startupAt);
  const pending = readPendingEvidence(pendingPath, startupAt, input.onError);

  const run: MainProcessRecoveryRun = {
    startedAt: startupAt.toISOString(),
    appVersion: input.appVersion,
    buildMode: input.buildMode,
    buildCommit: input.buildCommit,
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome ?? '',
    platform: process.platform,
    arch: osArch(),
    osRelease: osRelease(),
  };
  writeEvidenceAtomically(activePath, temporaryPath, {
    schemaVersion: SCHEMA_VERSION,
    run,
    capturedAt: null,
    logs: [],
  });

  let dirty = false;
  let disabled = false;
  let timer: NodeJS.Timeout | undefined;
  let lastFlushAt = Number.NEGATIVE_INFINITY;

  const cancelTimer = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const fail = (error: unknown): void => {
    disabled = true;
    cancelTimer();
    input.onError(error);
  };

  const flush = (): void => {
    if (disabled || !dirty) return;
    cancelTimer();
    const capturedAt = now();
    try {
      const logs = boundedLogTail(
        input.logs().map((entry) => collapseHomePath(entry, homedir(), process.platform)),
      );
      writeEvidenceAtomically(activePath, temporaryPath, {
        schemaVersion: SCHEMA_VERSION,
        run,
        capturedAt: capturedAt.toISOString(),
        logs,
      });
      dirty = false;
      lastFlushAt = capturedAt.getTime();
    } catch (error) {
      fail(error);
    }
  };

  const scheduleFlush = (): void => {
    if (disabled || timer) return;
    const delay = Math.max(
      MAIN_PROCESS_RECOVERY_FLUSH_DEBOUNCE_MS,
      lastFlushAt + MAIN_PROCESS_RECOVERY_FLUSH_INTERVAL_MS - now().getTime(),
    );
    timer = setTimeout(flush, delay);
    timer.unref();
  };

  return {
    pending,
    markDirty(): void {
      if (disabled) return;
      dirty = true;
      scheduleFlush();
    },
    flushNow(): void {
      flush();
    },
    markClean(): void {
      disabled = true;
      cancelTimer();
      try {
        removeFileEntry(activePath);
      } catch (error) {
        input.onError(error);
      }
    },
    discardPending(): void {
      try {
        removeFileEntry(pendingPath);
      } catch (error) {
        input.onError(error);
      }
    },
  };
}

export function appendUncaughtMainProcessError(
  logs: { append(level: 'error', message: string, capturedAt?: Date): void },
  journal: Pick<MainProcessRecoveryJournal, 'markDirty' | 'flushNow'>,
  error: unknown,
  origin: NodeJS.UncaughtExceptionOrigin,
): void {
  try {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    logs.append('error', `[process] ${origin}: ${detail}`);
    journal.markDirty();
    journal.flushNow();
  } catch {
    // Evidence capture must not replace or delay Node's original fatal path.
  }
}

function rotatePriorRun(paths: {
  readonly activePath: string;
  readonly pendingPath: string;
  readonly temporaryPath: string;
}, promotedAt: Date): void {
  removeFileEntry(paths.temporaryPath);
  const active = lstatOrUndefined(paths.activePath);
  if (!active) return;
  if (!active.isFile() || active.isSymbolicLink()) {
    throw new Error('Main-process recovery active record is invalid');
  }
  // The pending file's mtime is its retention authority. Touch before rename
  // so even an interruption between these operations leaves recoverable state.
  utimesSync(paths.activePath, promotedAt, promotedAt);
  removeFileEntry(paths.pendingPath);
  renameSync(paths.activePath, paths.pendingPath);
}

function readPendingEvidence(
  pendingPath: string,
  now: Date,
  onError: (error: unknown) => void,
): MainProcessRecoveryEvidence | undefined {
  if (!lstatOrUndefined(pendingPath)) return undefined;
  try {
    const stored = readJsonFile(pendingPath, EVIDENCE_MAX_BYTES);
    const evidence = decodeEvidence(stored.value);
    if (now.getTime() - stored.modifiedAtMs > MAIN_PROCESS_RECOVERY_MAX_AGE_MS) {
      removeFileEntry(pendingPath);
      return undefined;
    }
    return {
      run: evidence.run,
      snapshotAt: evidence.capturedAt,
      logs: evidence.logs,
    };
  } catch (error) {
    onError(error);
    removeFileEntry(pendingPath);
    return undefined;
  }
}

function decodeEvidence(value: unknown): StoredEvidence {
  const logs =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).logs
      : undefined;
  if (Array.isArray(logs) && logs.some((entry) => typeof entry !== 'string')) {
    throw new Error('Main-process recovery logs are invalid');
  }
  const evidence = storedEvidenceSchema.parse(value);
  return {
    schemaVersion: SCHEMA_VERSION,
    run: evidence.run,
    capturedAt: evidence.capturedAt,
    logs: boundedLogTail(evidence.logs),
  };
}

function boundedLogTail(logs: readonly string[]): readonly string[] {
  const newestFirst: string[] = [];
  let bytes = 2;
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const entry = truncateUtf8(
      logs[index] ?? '',
      MAIN_PROCESS_RECOVERY_LOG_MAX_BYTES - 2,
      ENTRY_TRUNCATION_MARKER,
    );
    const entryBytes = Buffer.byteLength(JSON.stringify(entry));
    const separatorBytes = newestFirst.length > 0 ? 1 : 0;
    if (bytes + separatorBytes + entryBytes > MAIN_PROCESS_RECOVERY_LOG_MAX_BYTES) break;
    newestFirst.push(entry);
    bytes += separatorBytes + entryBytes;
  }
  return newestFirst.reverse();
}

function readJsonFile(
  path: string,
  maximumBytes: number,
): { readonly value: unknown; readonly modifiedAtMs: number } {
  const linkMetadata = lstatSync(path);
  if (!linkMetadata.isFile() || linkMetadata.isSymbolicLink()) {
    throw new Error(`Main-process recovery file ${basename(path)} is invalid`);
  }
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const fd = openSync(path, flags);
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new Error(`Main-process recovery file ${basename(path)} is invalid`);
    }
    return {
      value: JSON.parse(readFileSync(fd, 'utf8')),
      modifiedAtMs: metadata.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}

function writeEvidenceAtomically(
  activePath: string,
  temporaryPath: string,
  evidence: StoredEvidence,
): void {
  const contents = JSON.stringify(evidence);
  if (Buffer.byteLength(contents) > EVIDENCE_MAX_BYTES) {
    throw new Error('Main-process recovery evidence exceeds its size limit');
  }
  removeFileEntry(temporaryPath);
  try {
    writeFileSync(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporaryPath, activePath);
  } finally {
    removeFileEntry(temporaryPath);
  }
}

function ensurePrivateDirectory(path: string): void {
  const existing = lstatOrUndefined(path);
  if (!existing) mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Main-process recovery root is not a private directory');
  }
  chmodSync(path, 0o700);
}

function removeFileEntry(path: string): void {
  const metadata = lstatOrUndefined(path);
  if (!metadata) return;
  if (!metadata.isFile() && !metadata.isSymbolicLink()) {
    throw new Error(`Main-process recovery path ${basename(path)} is not a file`);
  }
  rmSync(path, { force: true });
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
