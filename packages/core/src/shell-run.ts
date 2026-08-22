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

export const SHELL_RUN_STATUSES = [
  'starting',
  'running',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'orphaned',
] as const;

export type ShellRunStatus = (typeof SHELL_RUN_STATUSES)[number];

export const SHELL_RUN_ACTIVE_STATUSES = ['starting', 'running'] as const;

export const SHELL_RUN_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'orphaned',
] as const;

export const SHELL_RUN_ID_MAX_CHARS = 128;
export const SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES = 512;

const SHELL_RUN_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${SHELL_RUN_ID_MAX_CHARS}}$`);
const PIPE_SHELL_OUTPUT_KEYS = new Set([
  'mode',
  'stdout',
  'stderr',
  'latestStream',
  'stdoutTruncated',
  'stderrTruncated',
  'redacted',
]);
const PTY_SHELL_OUTPUT_KEYS = new Set([
  'mode',
  'screen',
  'scrollback',
  'lastAlternateScreen',
  'cols',
  'rows',
  'cursor',
  'alternateScreen',
  'truncated',
  'redacted',
]);
const PTY_CURSOR_KEYS = new Set(['x', 'y', 'visible']);

export type ShellRunTerminalStatus = (typeof SHELL_RUN_TERMINAL_STATUSES)[number];
export type ShellRunActiveStatus = (typeof SHELL_RUN_ACTIVE_STATUSES)[number];
export type ShellMode = 'pipes' | 'pty';

export interface PipeShellOutput {
  mode: 'pipes';
  stdout: string;
  stderr: string;
  latestStream?: 'stdout' | 'stderr';
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  redacted: boolean;
}

export interface PtyShellOutput {
  mode: 'pty';
  screen: string;
  scrollback: string;
  lastAlternateScreen?: string;
  cols: number;
  rows: number;
  cursor: {
    x: number;
    y: number;
    visible: boolean;
  };
  alternateScreen: boolean;
  truncated: boolean;
  redacted: boolean;
}

export type ShellOutput = PipeShellOutput | PtyShellOutput;

export type ShellRunOperation =
  | {
      kind: 'stop';
      applied: boolean;
    }
  | {
      kind: 'pty_control';
      failed: boolean;
      input?: {
        bytes: number;
        queued: boolean;
      };
      resize?: {
        cols: number;
        rows: number;
        applied: boolean;
        changed: boolean;
      };
    };

export interface ShellRunRecord {
  shellRunId: string;
  sessionId: string;
  sourceRunId?: string;
  sourceTurnId: string;
  sourceToolCallId: string;
  cwd: string;
  command: string;
  status: ShellRunStatus;
  exitCode?: number;
  failureMessage?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  timeoutMs?: number;
  revision: number;
  observedAt?: number;
  output: ShellOutput;
  sandboxExecution?: {
    type: 'none' | 'macos-seatbelt' | 'linux' | 'windows';
    enforced: boolean;
  };
  sandboxEscalation?: {
    commandHash: string;
    unsandboxed: true;
  };
}

export type ShellRunPatch = Partial<
  Pick<
    ShellRunRecord,
    'status' | 'exitCode' | 'failureMessage' | 'updatedAt' | 'completedAt' | 'observedAt' | 'output'
  >
>;

export interface ShellRunStore {
  createShellRun(record: ShellRunRecord): Promise<ShellRunRecord>;
  updateShellRun(
    sessionId: string,
    shellRunId: string,
    patch: ShellRunPatch,
  ): Promise<ShellRunRecord>;
  readShellRun(sessionId: string, shellRunId: string): Promise<ShellRunRecord>;
  listSessionShellRuns(sessionId: string): Promise<ShellRunRecord[]>;
}

export function isShellRunStatus(value: unknown): value is ShellRunStatus {
  return typeof value === 'string' && (SHELL_RUN_STATUSES as readonly string[]).includes(value);
}

export function isShellRunSourceToolCallId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES
  );
}

export function isShellRunId(value: unknown): value is string {
  return typeof value === 'string' && SHELL_RUN_ID_PATTERN.test(value);
}

export function isTerminalShellRunStatus(value: ShellRunStatus): value is ShellRunTerminalStatus {
  return (SHELL_RUN_TERMINAL_STATUSES as readonly string[]).includes(value);
}

export function isActiveShellRunStatus(value: ShellRunStatus): value is ShellRunActiveStatus {
  return (SHELL_RUN_ACTIVE_STATUSES as readonly string[]).includes(value);
}

export function isValidShellRunStatusTransition(
  current: ShellRunStatus,
  next: ShellRunStatus,
): boolean {
  if (current === next) return true;
  if (current === 'starting') {
    return next === 'running' || next === 'failed' || next === 'orphaned';
  }
  return current === 'running' && isTerminalShellRunStatus(next);
}

export function isShellOutput(value: unknown): value is ShellOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const output = value as Partial<ShellOutput>;
  if (output.mode === 'pipes') {
    return (
      hasOnlyKeys(output, PIPE_SHELL_OUTPUT_KEYS) &&
      typeof output.stdout === 'string' &&
      typeof output.stderr === 'string' &&
      (output.latestStream === undefined ||
        output.latestStream === 'stdout' ||
        output.latestStream === 'stderr') &&
      typeof output.stdoutTruncated === 'boolean' &&
      typeof output.stderrTruncated === 'boolean' &&
      typeof output.redacted === 'boolean'
    );
  }
  if (output.mode !== 'pty') return false;
  const pty = output as Partial<PtyShellOutput>;
  const cursor = pty.cursor;
  return (
    hasOnlyKeys(pty, PTY_SHELL_OUTPUT_KEYS) &&
    typeof pty.screen === 'string' &&
    typeof pty.scrollback === 'string' &&
    (pty.lastAlternateScreen === undefined || typeof pty.lastAlternateScreen === 'string') &&
    isPositiveInteger(pty.cols) &&
    isPositiveInteger(pty.rows) &&
    !!cursor &&
    hasOnlyKeys(cursor, PTY_CURSOR_KEYS) &&
    isNonNegativeInteger(cursor.x) &&
    cursor.x <= pty.cols &&
    isNonNegativeInteger(cursor.y) &&
    cursor.y < pty.rows &&
    typeof cursor.visible === 'boolean' &&
    typeof pty.alternateScreen === 'boolean' &&
    typeof pty.truncated === 'boolean' &&
    typeof pty.redacted === 'boolean'
  );
}

export function isValidShellRunState(value: {
  status?: unknown;
  completedAt?: unknown;
  exitCode?: unknown;
  failureMessage?: unknown;
  observedAt?: unknown;
}): boolean {
  switch (value.status) {
    case 'starting':
    case 'running':
      return (
        value.completedAt === undefined &&
        value.exitCode === undefined &&
        value.failureMessage === undefined &&
        value.observedAt === undefined
      );
    case 'completed':
      return (
        isFiniteNumber(value.completedAt) &&
        value.exitCode === 0 &&
        value.failureMessage === undefined
      );
    case 'failed':
      return (
        isFiniteNumber(value.completedAt) &&
        ((isFiniteNumber(value.exitCode) && value.exitCode !== 0) ||
          (value.exitCode === undefined &&
            typeof value.failureMessage === 'string' &&
            value.failureMessage.length > 0))
      );
    case 'timed_out':
      return isFiniteNumber(value.completedAt) && value.exitCode === 124;
    case 'cancelled':
      return isFiniteNumber(value.completedAt) && value.exitCode === 130;
    case 'orphaned':
      return (
        isFiniteNumber(value.completedAt) &&
        value.exitCode === undefined &&
        typeof value.failureMessage === 'string' &&
        value.failureMessage.length > 0
      );
    default:
      return false;
  }
}

/**
 * Store-independent ShellRun invariants.
 *
 * Every ShellRunStore has to enforce the same shape, patch, and transition
 * rules — regardless of storage medium — and ShellRunProcessManager reads those
 * rules back as behaviour (monotonic revisions, immutable terminal outcomes).
 * They live here so a second store is a storage-medium change, not a second
 * copy of the state machine.
 */
const SHELL_RUN_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const SHELL_RUN_PATCH_KEYS: ReadonlySet<string> = new Set([
  'status',
  'exitCode',
  'failureMessage',
  'updatedAt',
  'completedAt',
  'observedAt',
  'output',
]);

const SHELL_RUN_RECORD_KEYS: ReadonlySet<string> = new Set([
  'shellRunId',
  'sessionId',
  'sourceRunId',
  'sourceTurnId',
  'sourceToolCallId',
  'cwd',
  'command',
  'status',
  'startedAt',
  'updatedAt',
  'completedAt',
  'timeoutMs',
  'exitCode',
  'failureMessage',
  'sandboxExecution',
  'sandboxEscalation',
  'revision',
  'observedAt',
  'output',
]);

export function assertShellRunSessionId(value: string): void {
  if (!SHELL_RUN_SESSION_ID_PATTERN.test(value)) throw new Error('Invalid session id');
}

export function assertShellRunIdentifier(value: string): void {
  if (!isShellRunId(value)) throw new Error('Invalid shell run id');
}

export function shellRunNotFoundError(shellRunId: string): Error & { code?: string } {
  const error = new Error(`ShellRun does not exist: ${shellRunId}`) as Error & { code?: string };
  error.code = 'ENOENT';
  return error;
}

export function normalizeShellRunRecord(
  value: unknown,
  sessionId: string,
  shellRunId: string,
): ShellRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ShellRun record for ${shellRunId}: expected an object`);
  }
  const record = value as Partial<ShellRunRecord>;
  const requiredStrings = [
    record.shellRunId,
    record.sessionId,
    record.sourceTurnId,
    record.sourceToolCallId,
    record.cwd,
    record.command,
  ];
  const optionalStrings = [record.sourceRunId, record.failureMessage];
  const valid =
    hasOnlyKeys(record, SHELL_RUN_RECORD_KEYS) &&
    requiredStrings.every((item) => typeof item === 'string') &&
    isShellRunSourceToolCallId(record.sourceToolCallId) &&
    record.sessionId === sessionId &&
    record.shellRunId === shellRunId &&
    isShellRunStatus(record.status) &&
    isFiniteNumber(record.startedAt) &&
    isFiniteNumber(record.updatedAt) &&
    isPositiveInteger(record.revision) &&
    isShellOutput(record.output) &&
    (record.completedAt === undefined || isFiniteNumber(record.completedAt)) &&
    (record.timeoutMs === undefined || isFiniteNumber(record.timeoutMs)) &&
    (record.exitCode === undefined || isFiniteNumber(record.exitCode)) &&
    (record.observedAt === undefined || isFiniteNumber(record.observedAt)) &&
    isShellRunSandboxExecution(record.sandboxExecution) &&
    isShellRunSandboxEscalation(record.sandboxEscalation, record.sandboxExecution) &&
    optionalStrings.every((item) => item === undefined || typeof item === 'string');
  if (!valid) {
    throw new Error(`Invalid ShellRun record for ${shellRunId}: malformed fields`);
  }
  if (!isValidShellRunState(record)) {
    throw new Error(`Invalid ShellRun record for ${shellRunId}: inconsistent state fields`);
  }
  return canonicalShellRunRecord(record as ShellRunRecord);
}

export function assertShellRunPatch(patch: ShellRunPatch): void {
  for (const key of Object.keys(patch)) {
    if (!SHELL_RUN_PATCH_KEYS.has(key)) {
      throw new Error(`ShellRun field is immutable: ${key}`);
    }
  }
}

/**
 * Applies a validated patch and returns the next record, or `current` unchanged
 * when the patch is a no-op. The revision only advances on a real change, which
 * is what callers use to tell a durable write from a redundant one.
 */
export function nextShellRunRecord(current: ShellRunRecord, patch: ShellRunPatch): ShellRunRecord {
  assertShellRunPatch(patch);
  const { sessionId, shellRunId } = current;
  if (patch.output && patch.output.mode !== current.output.mode) {
    throw new Error(`ShellRun output mode is immutable: ${current.output.mode}`);
  }
  const effectivePatch =
    current.observedAt !== undefined && Object.hasOwn(patch, 'observedAt')
      ? { ...patch, observedAt: current.observedAt }
      : patch;
  const candidate = normalizeShellRunRecord(
    { ...current, ...effectivePatch, sessionId, shellRunId, revision: current.revision },
    sessionId,
    shellRunId,
  );
  if (!isValidShellRunStatusTransition(current.status, candidate.status)) {
    throw new Error(`Invalid ShellRun status transition: ${current.status} -> ${candidate.status}`);
  }
  if (
    isTerminalShellRunStatus(current.status) &&
    (candidate.completedAt !== current.completedAt ||
      candidate.exitCode !== current.exitCode ||
      candidate.failureMessage !== current.failureMessage)
  ) {
    throw new Error(`ShellRun terminal outcome is immutable: ${current.status}`);
  }
  if (shellRunRecordsEqual(candidate, current)) return current;
  return normalizeShellRunRecord(
    { ...candidate, revision: current.revision + 1 },
    sessionId,
    shellRunId,
  );
}

/**
 * Structural equality for normalized ShellRun records. Records are plain
 * JSON-safe data (string/number/boolean/null/arrays/objects), so a small
 * recursive comparison is sufficient and keeps this module free of node:*
 * imports so the renderer-facing `@maka/core` barrel stays browser-safe.
 */
function shellRunRecordsEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if (left.length !== (right as unknown[]).length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!shellRunRecordsEqual(left[index], (right as unknown[])[index])) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (
      !shellRunRecordsEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}

function isShellRunSandboxExecution(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!hasOnlyKeys(value, new Set(['type', 'enforced']))) return false;
  const execution = value as Record<string, unknown>;
  return (
    (execution.type === 'none' ||
      execution.type === 'macos-seatbelt' ||
      execution.type === 'linux' ||
      execution.type === 'windows') &&
    typeof execution.enforced === 'boolean' &&
    execution.enforced === (execution.type !== 'none')
  );
}

function isShellRunSandboxEscalation(value: unknown, execution: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!hasOnlyKeys(value, new Set(['commandHash', 'unsandboxed']))) return false;
  const escalation = value as Record<string, unknown>;
  const sandbox = execution as { type?: unknown; enforced?: unknown } | undefined;
  return (
    typeof escalation.commandHash === 'string' &&
    escalation.commandHash.length > 0 &&
    escalation.unsandboxed === true &&
    sandbox?.type === 'none' &&
    sandbox.enforced === false
  );
}

function canonicalShellRunRecord(record: ShellRunRecord): ShellRunRecord {
  return {
    shellRunId: record.shellRunId,
    sessionId: record.sessionId,
    ...(record.sourceRunId !== undefined ? { sourceRunId: record.sourceRunId } : {}),
    sourceTurnId: record.sourceTurnId,
    sourceToolCallId: record.sourceToolCallId,
    cwd: record.cwd,
    command: record.command,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.failureMessage !== undefined ? { failureMessage: record.failureMessage } : {}),
    ...(record.sandboxExecution !== undefined
      ? { sandboxExecution: { ...record.sandboxExecution } }
      : {}),
    ...(record.sandboxEscalation !== undefined
      ? { sandboxEscalation: { ...record.sandboxEscalation } }
      : {}),
    revision: record.revision,
    ...(record.observedAt !== undefined ? { observedAt: record.observedAt } : {}),
    output: canonicalShellOutput(record.output),
  };
}

function canonicalShellOutput(output: ShellOutput): ShellOutput {
  if (output.mode === 'pipes') {
    return {
      mode: 'pipes',
      stdout: output.stdout,
      stderr: output.stderr,
      ...(output.latestStream !== undefined ? { latestStream: output.latestStream } : {}),
      stdoutTruncated: output.stdoutTruncated,
      stderrTruncated: output.stderrTruncated,
      redacted: output.redacted,
    };
  }
  return {
    mode: 'pty',
    screen: output.screen,
    scrollback: output.scrollback,
    ...(output.lastAlternateScreen !== undefined
      ? { lastAlternateScreen: output.lastAlternateScreen }
      : {}),
    cols: output.cols,
    rows: output.rows,
    cursor: { ...output.cursor },
    alternateScreen: output.alternateScreen,
    truncated: output.truncated,
    redacted: output.redacted,
  };
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
