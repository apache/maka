import {
  DEFAULT_DAILY_REVIEW_CONFIG,
  dailyReviewArchiveToSummary,
  normalizeDailyReviewArchive,
  normalizeDailyReviewConfig,
  type DailyReviewArchive,
  type DailyReviewArchiveSummary,
  type DailyReviewConfig,
} from '@maka/core/daily-review';
import { acquireOperationalStateDatabase } from '@maka/storage';

const ARCHIVE_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-(1d|7d|30d)$/;

export interface DailyReviewArchiveStore {
  getConfig(): Promise<DailyReviewConfig>;
  setConfig(patch: Partial<DailyReviewConfig>): Promise<DailyReviewConfig>;
  putArchive(archive: DailyReviewArchive): Promise<DailyReviewArchive>;
  listArchives(): Promise<DailyReviewArchiveSummary[]>;
  getArchive(id: string): Promise<DailyReviewArchive | null>;
  deleteArchive(id: string): Promise<void>;
  prune(maxArchives: number): Promise<void>;
}

export function createDailyReviewArchiveStore(workspaceRoot: string): DailyReviewArchiveStore {
  return new SqliteDailyReviewArchiveStore(workspaceRoot);
}

class SqliteDailyReviewArchiveStore implements DailyReviewArchiveStore {
  constructor(private readonly workspaceRoot: string) {}

  async getConfig(): Promise<DailyReviewConfig> {
    return this.withDatabase('read', (database) => {
      const row = database
        .prepare('SELECT config_json AS configJson FROM workflow_daily_review_state WHERE singleton = 1')
        .get() as { configJson?: unknown } | undefined;
      return typeof row?.configJson === 'string'
        ? normalizeDailyReviewConfig(JSON.parse(row.configJson) as Partial<DailyReviewConfig>)
        : DEFAULT_DAILY_REVIEW_CONFIG;
    });
  }

  async setConfig(patch: Partial<DailyReviewConfig>): Promise<DailyReviewConfig> {
    return this.withDatabase('write', (database) => {
      const row = database
        .prepare('SELECT config_json AS configJson FROM workflow_daily_review_state WHERE singleton = 1')
        .get() as { configJson?: unknown } | undefined;
      const current =
        typeof row?.configJson === 'string'
          ? normalizeDailyReviewConfig(JSON.parse(row.configJson) as Partial<DailyReviewConfig>)
          : DEFAULT_DAILY_REVIEW_CONFIG;
      const next = normalizeDailyReviewConfig({ ...current, ...patch });
      database
        .prepare(`
          INSERT INTO workflow_daily_review_state(singleton, config_json)
          VALUES (1, ?)
          ON CONFLICT(singleton) DO UPDATE SET config_json = excluded.config_json
        `)
        .run(JSON.stringify(next));
      return next;
    });
  }

  async putArchive(archive: DailyReviewArchive): Promise<DailyReviewArchive> {
    assertArchiveId(archive.id);
    const normalized = normalizeDailyReviewArchive(archive);
    if (normalized.id !== archive.id) throw new Error(`Daily Review archive id mismatch: ${archive.id}`);
    this.withDatabase('write', (database) => {
      database
        .prepare(`
          INSERT INTO workflow_daily_review_archives(
            archive_id, generated_at, day_from_ms, record_json
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(archive_id) DO UPDATE SET
            generated_at = excluded.generated_at,
            day_from_ms = excluded.day_from_ms,
            record_json = excluded.record_json
        `)
        .run(normalized.id, normalized.generatedAt, normalized.day.fromMs, JSON.stringify(normalized));
    });
    return normalized;
  }

  async listArchives(): Promise<DailyReviewArchiveSummary[]> {
    return this.withDatabase('read', (database) =>
      (
        database
          .prepare(`
            SELECT archive_id AS archiveId, record_json AS recordJson
            FROM workflow_daily_review_archives
            ORDER BY generated_at DESC, day_from_ms DESC, archive_id
          `)
          .all() as Array<{ archiveId: string; recordJson: string }>
      ).map((row) => dailyReviewArchiveToSummary(decodeArchive(row.archiveId, row.recordJson))),
    );
  }

  async getArchive(id: string): Promise<DailyReviewArchive | null> {
    assertArchiveId(id);
    return this.withDatabase('read', (database) => {
      const row = database
        .prepare(`
          SELECT record_json AS recordJson
          FROM workflow_daily_review_archives
          WHERE archive_id = ?
        `)
        .get(id) as { recordJson?: unknown } | undefined;
      return typeof row?.recordJson === 'string' ? decodeArchive(id, row.recordJson) : null;
    });
  }

  async deleteArchive(id: string): Promise<void> {
    assertArchiveId(id);
    this.withDatabase('write', (database) => {
      database.prepare('DELETE FROM workflow_daily_review_archives WHERE archive_id = ?').run(id);
    });
  }

  async prune(maxArchives: number): Promise<void> {
    const limit = Math.max(0, Math.trunc(maxArchives));
    if (limit === 0) return;
    this.withDatabase('write', (database) => {
      database
        .prepare(`
          DELETE FROM workflow_daily_review_archives
          WHERE archive_id IN (
            SELECT archive_id
            FROM workflow_daily_review_archives
            ORDER BY generated_at DESC, day_from_ms DESC, archive_id
            LIMIT -1 OFFSET ?
          )
        `)
        .run(limit);
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

function decodeArchive(id: string, recordJson: string): DailyReviewArchive {
  const archive = normalizeDailyReviewArchive(JSON.parse(recordJson));
  if (archive.id !== id) throw new Error(`Daily Review archive id mismatch: ${id}`);
  return archive;
}

function assertArchiveId(id: string): void {
  if (!ARCHIVE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid Daily Review archive id: ${id}`);
  }
}
