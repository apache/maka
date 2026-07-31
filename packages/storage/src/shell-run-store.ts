import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  isValidLegacyShellRunState,
  isShellOutput,
  isShellRunId,
  isShellRunStatus,
  isTerminalShellRunStatus,
  isValidShellRunState,
  isValidShellRunStatusTransition,
  type ShellRunRecord,
  type ShellRunPatch,
  type ShellRunStore,
} from '@maka/core';
import { syncDirectoryChain, syncFile } from './stable-storage.js';
import { chainWrite } from './write-queue.js';

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
const LEGACY_SHELL_RUN_RECORD_KEYS = new Set([
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
  'stdoutTail',
  'stderrTail',
  'latestOutputStream',
  'stdoutTruncated',
  'stderrTruncated',
  'observedAt',
  'orphanedReason',
  'pid',
]);

export function createShellRunStore(workspaceRoot: string): ShellRunStore {
  return new FileShellRunStore(workspaceRoot);
}

class FileShellRunStore implements ShellRunStore {
  private readonly durabilityRoot: string;
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.durabilityRoot = workspaceRoot;
    this.sessionsRoot = join(workspaceRoot, 'sessions');
  }

  async createShellRun(record: ShellRunRecord): Promise<ShellRunRecord> {
    assertSessionId(record.sessionId);
    assertShellRunId(record.shellRunId);
    const normalized = normalizeShellRunRecord(record, record.sessionId, record.shellRunId);
    await this.withQueue(record.sessionId, record.shellRunId, async () => {
      if (await pathExists(this.shellRunPath(record.sessionId, record.shellRunId))) {
        throw new Error(`ShellRun already exists: ${record.shellRunId}`);
      }
      await mkdir(this.shellRunDir(record.sessionId, record.shellRunId), { recursive: true });
      await writeAtomic(
        this.shellRunPath(record.sessionId, record.shellRunId),
        JSON.stringify(normalized, sanitizeJson) + '\n',
        this.durabilityRoot,
        true,
      );
    });
    return normalized;
  }

  async updateShellRun(
    sessionId: string,
    shellRunId: string,
    patch: ShellRunPatch,
  ): Promise<ShellRunRecord> {
    let next: ShellRunRecord | undefined;
    await this.withQueue(sessionId, shellRunId, async () => {
      assertShellRunPatch(patch);
      const hasDurableIntent = Object.hasOwn(patch, 'status') || Object.hasOwn(patch, 'observedAt');
      const current = await this.readShellRunUnlocked(sessionId, shellRunId);
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
      if (isDeepStrictEqual(candidate, current)) {
        if (hasDurableIntent) {
          const path = this.shellRunPath(sessionId, shellRunId);
          await syncFile(path);
          await syncDirectoryChain(dirname(path), this.durabilityRoot);
        }
        next = current;
        return;
      }
      next = normalizeShellRunRecord(
        { ...candidate, revision: current.revision + 1 },
        sessionId,
        shellRunId,
      );
      await writeAtomic(
        this.shellRunPath(sessionId, shellRunId),
        JSON.stringify(next, sanitizeJson) + '\n',
        this.durabilityRoot,
        hasDurableIntent,
      );
    });
    if (!next) throw new Error(`Failed to update shell run ${shellRunId}`);
    return next;
  }

  async readShellRun(sessionId: string, shellRunId: string): Promise<ShellRunRecord> {
    return this.readShellRunUnlocked(sessionId, shellRunId);
  }

  async listSessionShellRuns(sessionId: string): Promise<ShellRunRecord[]> {
    assertSessionId(sessionId);
    let entries;
    try {
      entries = await readdir(this.shellRunsRoot(sessionId), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: ShellRunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isShellRunId(entry.name)) continue;
      try {
        records.push(await this.readShellRunUnlocked(sessionId, entry.name));
      } catch {
        // Malformed shell run folders should not hide healthy runs.
      }
    }
    return records.sort(
      (a, b) => a.startedAt - b.startedAt || a.shellRunId.localeCompare(b.shellRunId),
    );
  }

  private async readShellRunUnlocked(
    sessionId: string,
    shellRunId: string,
  ): Promise<ShellRunRecord> {
    assertSessionId(sessionId);
    assertShellRunId(shellRunId);
    return normalizeShellRunRecord(
      JSON.parse(await readFile(this.shellRunPath(sessionId, shellRunId), 'utf8')),
      sessionId,
      shellRunId,
    );
  }

  private shellRunsRoot(sessionId: string): string {
    assertSessionId(sessionId);
    return join(this.sessionsRoot, sessionId, 'shell-runs');
  }

  private shellRunDir(sessionId: string, shellRunId: string): string {
    assertShellRunId(shellRunId);
    return join(this.shellRunsRoot(sessionId), shellRunId);
  }

  private shellRunPath(sessionId: string, shellRunId: string): string {
    return join(this.shellRunDir(sessionId, shellRunId), 'shell-run.json');
  }

  private withQueue(
    sessionId: string,
    shellRunId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    assertSessionId(sessionId);
    assertShellRunId(shellRunId);
    const key = `${sessionId}:${shellRunId}`;
    return chainWrite(this.writeQueues, key, operation);
  }
}

async function writeAtomic(
  path: string,
  content: string,
  durabilityRoot: string,
  durable: boolean,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, 'utf8');
    if (durable) await syncFile(tempPath);
    await rename(tempPath, path);
    if (durable) await syncDirectoryChain(dirname(path), durabilityRoot);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function normalizeShellRunRecord(
  value: unknown,
  sessionId: string,
  shellRunId: string,
): ShellRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ShellRun record for ${shellRunId}: expected an object`);
  }
  const record = (normalizeLegacyShellRunRecord(value, sessionId, shellRunId) ??
    value) as Partial<ShellRunRecord>;
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

function normalizeLegacyShellRunRecord(
  value: object,
  sessionId: string,
  shellRunId: string,
): ShellRunRecord | undefined {
  if (!hasOnlyKeys(value, LEGACY_SHELL_RUN_RECORD_KEYS)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.output !== undefined ||
    record.revision !== undefined ||
    record.shellRunId !== shellRunId ||
    record.sessionId !== sessionId ||
    typeof record.sourceTurnId !== 'string' ||
    typeof record.sourceToolCallId !== 'string' ||
    typeof record.cwd !== 'string' ||
    typeof record.command !== 'string' ||
    !isShellRunStatus(record.status) ||
    !isFiniteNumber(record.startedAt) ||
    !isFiniteNumber(record.updatedAt) ||
    typeof record.stdoutTail !== 'string' ||
    typeof record.stderrTail !== 'string' ||
    typeof record.stdoutTruncated !== 'boolean' ||
    typeof record.stderrTruncated !== 'boolean' ||
    (record.sourceRunId !== undefined && typeof record.sourceRunId !== 'string') ||
    (record.completedAt !== undefined && !isFiniteNumber(record.completedAt)) ||
    (record.timeoutMs !== undefined && !isFiniteNumber(record.timeoutMs)) ||
    (record.exitCode !== undefined && !isFiniteNumber(record.exitCode)) ||
    (record.failureMessage !== undefined && typeof record.failureMessage !== 'string') ||
    (record.observedAt !== undefined && !isFiniteNumber(record.observedAt)) ||
    (record.orphanedReason !== undefined && typeof record.orphanedReason !== 'string') ||
    (record.pid !== undefined && !isFiniteNumber(record.pid)) ||
    (record.latestOutputStream !== undefined &&
      record.latestOutputStream !== 'stdout' &&
      record.latestOutputStream !== 'stderr') ||
    !isValidLegacyShellRunState(record)
  )
    return undefined;

  const failureMessage =
    typeof record.failureMessage === 'string'
      ? record.failureMessage
      : record.status === 'orphaned'
        ? (record.orphanedReason as string)
        : undefined;
  return {
    shellRunId,
    sessionId,
    ...(typeof record.sourceRunId === 'string' ? { sourceRunId: record.sourceRunId } : {}),
    sourceTurnId: record.sourceTurnId,
    sourceToolCallId: record.sourceToolCallId,
    cwd: record.cwd,
    command: record.command,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(isFiniteNumber(record.completedAt) ? { completedAt: record.completedAt } : {}),
    ...(isFiniteNumber(record.timeoutMs) ? { timeoutMs: record.timeoutMs } : {}),
    ...(isFiniteNumber(record.exitCode) ? { exitCode: record.exitCode } : {}),
    ...(failureMessage !== undefined ? { failureMessage } : {}),
    revision: 1,
    ...(isFiniteNumber(record.observedAt) ? { observedAt: record.observedAt } : {}),
    output: {
      mode: 'pipes',
      stdout: record.stdoutTail,
      stderr: record.stderrTail,
      ...(record.latestOutputStream === 'stdout' || record.latestOutputStream === 'stderr'
        ? { latestStream: record.latestOutputStream }
        : {}),
      stdoutTruncated: record.stdoutTruncated,
      stderrTruncated: record.stderrTruncated,
      redacted: false,
    },
  };
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
