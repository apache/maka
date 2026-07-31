import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CLEANUP_FILE_VERSION = 1;
const CLEANUP_FILE_NAME = 'quote-companion-cleanup.json';

interface QuoteCompanionCleanupFile {
  version: typeof CLEANUP_FILE_VERSION;
  pendingSessionIds: string[];
}

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
  /**
   * Record the cleanup intent before attempting removal. The record is cleared
   * only after the complete Desktop session-removal path succeeds.
   */
  cleanup(sessionId: string): Promise<void>;
  /** Retry every cleanup intent left by an earlier failed attempt or app exit. */
  recover(): Promise<QuoteCompanionCleanupRecovery>;
}

export function createQuoteCompanionCleanupAuthority(input: {
  workspaceRoot: string;
  removeSession: (sessionId: string) => Promise<void>;
}): QuoteCompanionCleanupAuthority {
  return new FileQuoteCompanionCleanupAuthority(
    new FileQuoteCompanionCleanupStore(input.workspaceRoot),
    input.removeSession,
  );
}

class FileQuoteCompanionCleanupAuthority implements QuoteCompanionCleanupAuthority {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly store: QuoteCompanionCleanupStore,
    private readonly removeSession: (sessionId: string) => Promise<void>,
  ) {}

  cleanup(sessionId: string): Promise<void> {
    const normalized = normalizeSessionId(sessionId);
    const active = this.inFlight.get(normalized);
    if (active) return active;

    const operation = this.cleanupOnce(normalized, true).finally(() => {
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

  private async cleanupOnce(sessionId: string, track: boolean): Promise<void> {
    // This small file is the companion cleanup WAL: once `track` resolves, a
    // failed removal can be replayed after panel unmount or Desktop restart.
    if (track) await this.store.track(sessionId);
    await this.removeSession(sessionId);
    await this.store.forget(sessionId);
  }
}

class FileQuoteCompanionCleanupStore implements QuoteCompanionCleanupStore {
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.filePath = join(workspaceRoot, CLEANUP_FILE_NAME);
  }

  async list(): Promise<string[]> {
    await this.queue;
    return this.read();
  }

  track(sessionId: string): Promise<void> {
    return this.mutate((current) =>
      current.includes(sessionId) ? current : [...current, sessionId],
    );
  }

  forget(sessionId: string): Promise<void> {
    return this.mutate((current) => current.filter((id) => id !== sessionId));
  }

  private async mutate(update: (current: string[]) => string[]): Promise<void> {
    const run = async () => {
      const current = await this.read();
      await this.write(update(current));
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    await next;
  }

  private async read(): Promise<string[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<QuoteCompanionCleanupFile>;
      if (
        parsed.version !== CLEANUP_FILE_VERSION ||
        !Array.isArray(parsed.pendingSessionIds)
      ) {
        throw new Error('Invalid quote companion cleanup file');
      }
      return [...new Set(parsed.pendingSessionIds.map(normalizeSessionId))];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async write(pendingSessionIds: string[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const next: QuoteCompanionCleanupFile = {
      version: CLEANUP_FILE_VERSION,
      pendingSessionIds,
    };
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid quote companion session id');
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error('Invalid quote companion session id');
  }
  return normalized;
}
