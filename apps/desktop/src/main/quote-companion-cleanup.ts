import { acquireOperationalStateDatabase } from '@maka/storage';

interface QuoteCompanionCleanupStore {
  list(): Promise<string[]>;
  track(sessionId: string): Promise<void>;
  forget(sessionId: string): Promise<void>;
}

export interface QuoteCompanionCleanupRecovery {
  removed: string[];
  failed: Array<{ sessionId: string; error: unknown }>;
}

export interface QuoteCompanionCleanupAuthority {
  cleanup(sessionId: string): Promise<void>;
  recover(): Promise<QuoteCompanionCleanupRecovery>;
}

export function createQuoteCompanionCleanupAuthority(input: {
  workspaceRoot: string;
  removeSession: (sessionId: string) => Promise<void>;
}): QuoteCompanionCleanupAuthority {
  return new QuoteCompanionCleanupAuthorityImpl(
    new SqliteQuoteCompanionCleanupStore(input.workspaceRoot),
    input.removeSession,
  );
}

class QuoteCompanionCleanupAuthorityImpl implements QuoteCompanionCleanupAuthority {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly store: QuoteCompanionCleanupStore,
    private readonly removeSession: (sessionId: string) => Promise<void>,
  ) {}

  cleanup(sessionId: string): Promise<void> {
    const normalized = normalizeSessionId(sessionId);
    const active = this.inFlight.get(normalized);
    if (active) return active;
    const operation = this.cleanupOnce(normalized).finally(() => {
      this.inFlight.delete(normalized);
    });
    this.inFlight.set(normalized, operation);
    return operation;
  }

  async recover(): Promise<QuoteCompanionCleanupRecovery> {
    const removed: string[] = [];
    const failed: QuoteCompanionCleanupRecovery['failed'] = [];
    for (const sessionId of await this.store.list()) {
      try {
        await this.cleanup(sessionId);
        removed.push(sessionId);
      } catch (error) {
        failed.push({ sessionId, error });
      }
    }
    return { removed, failed };
  }

  private async cleanupOnce(sessionId: string): Promise<void> {
    await this.store.track(sessionId);
    await this.removeSession(sessionId);
    await this.store.forget(sessionId);
  }
}

class SqliteQuoteCompanionCleanupStore implements QuoteCompanionCleanupStore {
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
