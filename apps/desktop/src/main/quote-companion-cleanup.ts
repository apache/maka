import { acquireOperationalStateDatabase } from '@maka/storage';

interface SessionCopyCleanupStore {
  list(): Promise<string[]>;
  track(sessionId: string): Promise<void>;
  forget(sessionId: string): Promise<void>;
}

export type SessionCopyCleanupDisposition = 'removed' | 'retained';

export interface SessionCopyCleanupRecovery {
  removed: string[];
  failed: Array<{ sessionId: string; error: unknown }>;
}

export interface SessionCopyCleanupAuthority {
  cleanup(sessionId: string): Promise<void>;
  schedule(sessionId: string): Promise<void>;
  recover(): Promise<SessionCopyCleanupRecovery>;
}

export function createSessionCopyCleanupAuthority(input: {
  workspaceRoot: string;
  removeSession: (sessionId: string) => Promise<SessionCopyCleanupDisposition | void>;
}): SessionCopyCleanupAuthority {
  return new SessionCopyCleanupAuthorityImpl(
    new SqliteSessionCopyCleanupStore(input.workspaceRoot),
    input.removeSession,
  );
}

class SessionCopyCleanupAuthorityImpl implements SessionCopyCleanupAuthority {
  private readonly inFlight = new Map<string, Promise<SessionCopyCleanupDisposition>>();

  constructor(
    private readonly store: SessionCopyCleanupStore,
    private readonly removeSession: (
      sessionId: string,
    ) => Promise<SessionCopyCleanupDisposition | void>,
  ) {}

  cleanup(sessionId: string): Promise<void> {
    return this.cleanupDisposition(sessionId).then(() => undefined);
  }

  private cleanupDisposition(sessionId: string): Promise<SessionCopyCleanupDisposition> {
    const normalized = normalizeSessionId(sessionId);
    const active = this.inFlight.get(normalized);
    if (active) return active;
    const operation = this.cleanupOnce(normalized).finally(() => {
      this.inFlight.delete(normalized);
    });
    this.inFlight.set(normalized, operation);
    return operation;
  }

  async schedule(sessionId: string): Promise<void> {
    const normalized = normalizeSessionId(sessionId);
    await this.store.track(normalized);
    void this.cleanup(normalized).catch(() => undefined);
  }

  async recover(): Promise<SessionCopyCleanupRecovery> {
    const removed: string[] = [];
    const failed: SessionCopyCleanupRecovery['failed'] = [];
    for (const sessionId of await this.store.list()) {
      try {
        const disposition = await this.cleanupDisposition(sessionId);
        if (disposition === 'removed') removed.push(sessionId);
      } catch (error) {
        failed.push({ sessionId, error });
      }
    }
    return { removed, failed };
  }

  private async cleanupOnce(sessionId: string): Promise<SessionCopyCleanupDisposition> {
    await this.store.track(sessionId);
    const disposition = (await this.removeSession(sessionId)) ?? 'removed';
    await this.store.forget(sessionId);
    return disposition;
  }
}

class SqliteSessionCopyCleanupStore implements SessionCopyCleanupStore {
  constructor(private readonly workspaceRoot: string) {}

  async list(): Promise<string[]> {
    return this.withDatabase('read', (database) =>
      (
        database
          .prepare(`
            SELECT session_id AS sessionId
            FROM workflow_quote_companion_cleanup
            ORDER BY tracked_at, session_id
          `)
          .all() as Array<{ sessionId: string }>
      ).map((row) => row.sessionId),
    );
  }

  async track(sessionId: string): Promise<void> {
    this.withDatabase('write', (database) => {
      database
        .prepare(`
          INSERT OR IGNORE INTO workflow_quote_companion_cleanup(session_id, tracked_at)
          VALUES (?, ?)
        `)
        .run(sessionId, Date.now());
    });
  }

  async forget(sessionId: string): Promise<void> {
    this.withDatabase('write', (database) => {
      database
        .prepare('DELETE FROM workflow_quote_companion_cleanup WHERE session_id = ?')
        .run(sessionId);
    });
  }

  private withDatabase<T>(
    mode: 'read' | 'write',
    operation: (database: import('node:sqlite').DatabaseSync) => T,
  ): T {
    const lease = acquireOperationalStateDatabase(this.workspaceRoot);
    try {
      return lease.transaction(mode, () => operation(lease.database));
    } finally {
      lease.close();
    }
  }
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid quote companion session id');
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) {
    throw new Error('Invalid quote companion session id');
  }
  return normalized;
}
