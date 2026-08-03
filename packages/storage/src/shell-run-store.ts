import { isDeepStrictEqual } from 'node:util';
import {
  isShellOutput,
  isShellRunId,
  isShellRunSourceToolCallId,
  isShellRunStatus,
  isTerminalShellRunStatus,
  isValidShellRunState,
  isValidShellRunStatusTransition,
  type ShellRunRecord,
  type ShellRunPatch,
  type ShellRunStore,
} from '@maka/core';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHELL_RUN_PATCH_KEYS = new Set([
  'status',
  'exitCode',
  'failureMessage',
  'updatedAt',
  'completedAt',
  'observedAt',
  'output',
]);
const SHELL_RUN_RECORD_KEYS = new Set([
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
export interface ClosableShellRunStore extends ShellRunStore {
  ready(): Promise<void>;
  close(): void;
}

export function createSqliteShellRunStore(workspaceRoot: string): ClosableShellRunStore {
  return new SqliteShellRunStore(workspaceRoot);
}

class SqliteShellRunStore implements ClosableShellRunStore {
  readonly #lease: OperationalStateDatabaseLease;

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(workspaceRoot);
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  async createShellRun(record: ShellRunRecord): Promise<ShellRunRecord> {
    assertSessionId(record.sessionId);
    assertShellRunId(record.shellRunId);
    const normalized = normalizeShellRunRecord(record, record.sessionId, record.shellRunId);
    this.#lease.transaction('write', () => {
      const result = this.#lease.database
        .prepare(`
          INSERT OR IGNORE INTO core_shell_runs(
            session_id, shell_run_id, started_at, record_json
          ) VALUES (?, ?, ?, ?)
        `)
        .run(
          normalized.sessionId,
          normalized.shellRunId,
          normalized.startedAt,
          JSON.stringify(normalized, sanitizeJson),
        );
      if (result.changes !== 1) {
        throw new Error(`ShellRun already exists: ${normalized.shellRunId}`);
      }
    });
    return normalized;
  }

  async updateShellRun(
    sessionId: string,
    shellRunId: string,
    patch: ShellRunPatch,
  ): Promise<ShellRunRecord> {
    assertSessionId(sessionId);
    assertShellRunId(shellRunId);
    assertShellRunPatch(patch);
    return this.#lease.transaction('write', () => {
      const current = readSqliteShellRun(this.#lease.database, sessionId, shellRunId);
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
      assertShellRunTransition(current, candidate);
      if (isDeepStrictEqual(candidate, current)) return current;
      const next = normalizeShellRunRecord(
        { ...candidate, revision: current.revision + 1 },
        sessionId,
        shellRunId,
      );
      const result = this.#lease.database
        .prepare(`
          UPDATE core_shell_runs
          SET started_at = ?, record_json = ?
          WHERE session_id = ? AND shell_run_id = ?
        `)
        .run(next.startedAt, JSON.stringify(next, sanitizeJson), sessionId, shellRunId);
      if (result.changes !== 1) throw new Error(`Failed to update shell run ${shellRunId}`);
      return next;
    });
  }

  async readShellRun(sessionId: string, shellRunId: string): Promise<ShellRunRecord> {
    assertSessionId(sessionId);
    assertShellRunId(shellRunId);
    return readSqliteShellRun(this.#lease.database, sessionId, shellRunId);
  }

  async listSessionShellRuns(sessionId: string): Promise<ShellRunRecord[]> {
    assertSessionId(sessionId);
    const rows = this.#lease.database
      .prepare(`
        SELECT shell_run_id, record_json
        FROM core_shell_runs
        WHERE session_id = ?
        ORDER BY started_at, shell_run_id
      `)
      .all(sessionId) as Array<{ shell_run_id?: unknown; record_json?: unknown }>;
    return rows.map((row) => {
      if (typeof row.shell_run_id !== 'string' || typeof row.record_json !== 'string') {
        throw new Error('Invalid SQLite ShellRun row');
      }
      return normalizeShellRunRecord(JSON.parse(row.record_json), sessionId, row.shell_run_id);
    });
  }

  close(): void {
    this.#lease.close();
  }
}

function readSqliteShellRun(
  db: import('node:sqlite').DatabaseSync,
  sessionId: string,
  shellRunId: string,
): ShellRunRecord {
  const row = db
    .prepare(`
      SELECT record_json
      FROM core_shell_runs
      WHERE session_id = ? AND shell_run_id = ?
    `)
    .get(sessionId, shellRunId) as { record_json?: unknown } | undefined;
  if (!row) {
    const error = new Error(`ShellRun does not exist: ${shellRunId}`) as Error & { code?: string };
    error.code = 'ENOENT';
    throw error;
  }
  if (typeof row.record_json !== 'string') throw new Error('Invalid SQLite ShellRun row');
  return normalizeShellRunRecord(JSON.parse(row.record_json), sessionId, shellRunId);
}

function normalizeShellRunRecord(
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
    isSandboxExecution(record.sandboxExecution) &&
    isSandboxEscalation(record.sandboxEscalation, record.sandboxExecution) &&
    optionalStrings.every((item) => item === undefined || typeof item === 'string');
  if (!valid) {
    throw new Error(`Invalid ShellRun record for ${shellRunId}: malformed fields`);
  }
  if (!isValidShellRunState(record)) {
    throw new Error(`Invalid ShellRun record for ${shellRunId}: inconsistent state fields`);
  }
  return canonicalShellRunRecord(record as ShellRunRecord);
}

function assertSessionId(value: string): void {
  if (!SESSION_ID_PATTERN.test(value)) throw new Error('Invalid session id');
}

function assertShellRunId(value: string): void {
  if (!isShellRunId(value)) throw new Error('Invalid shell run id');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isSandboxExecution(value: unknown): boolean {
  if (value === undefined) return true;
  if (!hasOnlyKeys(value, new Set(['type', 'enforced']))) return false;
  const execution = value as Record<string, unknown>;
  return (
    (execution.type === 'none' ||
      execution.type === 'macos-seatbelt' ||
      execution.type === 'linux') &&
    typeof execution.enforced === 'boolean' &&
    execution.enforced === (execution.type !== 'none')
  );
}

function isSandboxEscalation(value: unknown, execution: unknown): boolean {
  if (value === undefined) return true;
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

function assertShellRunPatch(patch: ShellRunPatch): void {
  for (const key of Object.keys(patch)) {
    if (!SHELL_RUN_PATCH_KEYS.has(key)) {
      throw new Error(`ShellRun field is immutable: ${key}`);
    }
  }
}

function assertShellRunTransition(current: ShellRunRecord, candidate: ShellRunRecord): void {
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
}

function hasOnlyKeys(value: unknown, allowed: ReadonlySet<string>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => allowed.has(key));
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
      ? {
          sandboxExecution: { ...record.sandboxExecution },
        }
      : {}),
    ...(record.sandboxEscalation !== undefined
      ? {
          sandboxEscalation: { ...record.sandboxEscalation },
        }
      : {}),
    revision: record.revision,
    ...(record.observedAt !== undefined ? { observedAt: record.observedAt } : {}),
    output: canonicalShellOutput(record.output),
  };
}

function canonicalShellOutput(output: ShellRunRecord['output']): ShellRunRecord['output'] {
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

function sanitizeJson(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}
