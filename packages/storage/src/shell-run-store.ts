import {
  assertShellRunIdentifier,
  assertShellRunPatch,
  assertShellRunSessionId,
  nextShellRunRecord,
  normalizeShellRunRecord,
  shellRunNotFoundError,
  type ShellRunRecord,
  type ShellRunPatch,
  type ShellRunStore,
} from '@maka/core/shell-run';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

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
    assertShellRunSessionId(record.sessionId);
    assertShellRunIdentifier(record.shellRunId);
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
    assertShellRunSessionId(sessionId);
    assertShellRunIdentifier(shellRunId);
    assertShellRunPatch(patch);
    return this.#lease.transaction('write', () => {
      const current = readSqliteShellRun(this.#lease.database, sessionId, shellRunId);
      const next = nextShellRunRecord(current, patch);
      if (next === current) return current;
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
    assertShellRunSessionId(sessionId);
    assertShellRunIdentifier(shellRunId);
    return readSqliteShellRun(this.#lease.database, sessionId, shellRunId);
  }

  async listSessionShellRuns(sessionId: string): Promise<ShellRunRecord[]> {
    assertShellRunSessionId(sessionId);
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
  if (!row) throw shellRunNotFoundError(shellRunId);
  if (typeof row.record_json !== 'string') throw new Error('Invalid SQLite ShellRun row');
  return normalizeShellRunRecord(JSON.parse(row.record_json), sessionId, shellRunId);
}

function sanitizeJson(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}
