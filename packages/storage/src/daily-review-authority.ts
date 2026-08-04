import {
  DEFAULT_DAILY_REVIEW_CONFIG,
  dailyReviewArchiveToSummary,
  normalizeDailyReviewArchive,
  normalizeDailyReviewConfig,
  type DailyReviewArchive,
  type DailyReviewArchiveSummary,
  type DailyReviewConfig,
} from '@maka/core/daily-review';
import { acquireOperationalStateDatabase } from './operational-state-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';

const ARCHIVE_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-(1d|7d|30d)$/;
const writerBrand: unique symbol = Symbol('InteractiveDailyReviewAuthorityWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveDailyReviewAuthorityWriter>();

export interface DailyReviewAuthoritySnapshot {
  readonly revision: number;
  readonly config: DailyReviewConfig;
}

export type DailyReviewConfigMutationResult =
  | {
      readonly kind: 'committed' | 'unchanged';
      readonly snapshot: DailyReviewAuthoritySnapshot;
    }
  | {
      readonly kind: 'revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

export interface InteractiveDailyReviewAuthorityWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  readConfig(): Promise<DailyReviewAuthoritySnapshot>;
  updateConfig(
    expectedRevision: number,
    config: DailyReviewConfig,
  ): Promise<DailyReviewConfigMutationResult>;
  putArchive(archive: DailyReviewArchive): Promise<DailyReviewArchive>;
  listArchives(): Promise<readonly DailyReviewArchiveSummary[]>;
  getArchive(archiveId: string): Promise<DailyReviewArchive | null>;
  deleteArchive(archiveId: string): Promise<boolean>;
  pruneArchives(maxArchives: number): Promise<void>;
  close(): void;
}

export function authenticateInteractiveDailyReviewAuthorityWriter(
  writer: InteractiveDailyReviewAuthorityWriter,
): InteractiveDailyReviewAuthorityWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive Daily Review authority writer',
    );
  }
  return writer;
}

export async function openInteractiveDailyReviewAuthorityForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveDailyReviewAuthorityWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;

  const writer = createWriterFacade(lease);
  await writer.readConfig();
  await assertStorageRootLease(lease, 'interactive', 'write');
  const raced = writerByLease.get(lease);
  if (raced) {
    writer.close();
    return raced;
  }
  writers.add(writer);
  writerByLease.set(lease, writer);
  return writer;
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
): InteractiveDailyReviewAuthorityWriter {
  let closed = false;
  const run = <T>(operation: (root: string) => T): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Daily Review authority writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', async (root) => operation(root));
  };
  const withDatabase = <T>(
    root: string,
    mode: 'read' | 'write',
    operation: (database: import('node:sqlite').DatabaseSync) => T,
  ): T => {
    const database = acquireOperationalStateDatabase(root);
    try {
      return database.transaction(mode, () => operation(database.database));
    } finally {
      database.close();
    }
  };

  const writer: InteractiveDailyReviewAuthorityWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    readConfig: () =>
      run((root) => withDatabase(root, 'read', (database) => readConfigSnapshot(database))),
    updateConfig: (expectedRevision, config) =>
      run((root) =>
        withDatabase(root, 'write', (database) => {
          const current = readConfigSnapshot(database);
          if (current.revision !== expectedRevision) {
            return {
              kind: 'revision_conflict' as const,
              expectedRevision,
              actualRevision: current.revision,
            };
          }
          const next = normalizeDailyReviewConfig(config);
          if (sameConfig(current.config, next)) {
            return { kind: 'unchanged' as const, snapshot: current };
          }
          const revision = current.revision + 1;
          database
            .prepare(
              `
              INSERT INTO workflow_daily_review_state(singleton, config_json)
              VALUES (1, ?)
              ON CONFLICT(singleton) DO UPDATE SET config_json = excluded.config_json
            `,
            )
            .run(JSON.stringify(next));
          database
            .prepare(
              `
              INSERT INTO workflow_daily_review_authority_state(singleton, revision)
              VALUES (1, ?)
              ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision
            `,
            )
            .run(revision);
          return {
            kind: 'committed' as const,
            snapshot: { revision, config: next },
          };
        }),
      ),
    putArchive: (archive) =>
      run((root) =>
        withDatabase(root, 'write', (database) => {
          assertArchiveId(archive.id);
          const normalized = normalizeDailyReviewArchive(archive);
          if (normalized.id !== archive.id) {
            throw new Error(`Daily Review archive id mismatch: ${archive.id}`);
          }
          database
            .prepare(
              `
              INSERT INTO workflow_daily_review_archives(
                archive_id, generated_at, day_from_ms, record_json
              ) VALUES (?, ?, ?, ?)
              ON CONFLICT(archive_id) DO UPDATE SET
                generated_at = excluded.generated_at,
                day_from_ms = excluded.day_from_ms,
                record_json = excluded.record_json
            `,
            )
            .run(
              normalized.id,
              normalized.generatedAt,
              normalized.day.fromMs,
              JSON.stringify(normalized),
            );
          return normalized;
        }),
      ),
    listArchives: () =>
      run((root) =>
        withDatabase(root, 'read', (database) =>
          (
            database
              .prepare(
                `
                SELECT archive_id AS archiveId, record_json AS recordJson
                FROM workflow_daily_review_archives
                ORDER BY generated_at DESC, day_from_ms DESC, archive_id
              `,
              )
              .all() as Array<{ archiveId: string; recordJson: string }>
          ).map((row) => dailyReviewArchiveToSummary(decodeArchive(row.archiveId, row.recordJson))),
        ),
      ),
    getArchive: (archiveId) =>
      run((root) =>
        withDatabase(root, 'read', (database) => {
          assertArchiveId(archiveId);
          const row = database
            .prepare(
              `
              SELECT record_json AS recordJson
              FROM workflow_daily_review_archives
              WHERE archive_id = ?
            `,
            )
            .get(archiveId) as { recordJson?: unknown } | undefined;
          return typeof row?.recordJson === 'string'
            ? decodeArchive(archiveId, row.recordJson)
            : null;
        }),
      ),
    deleteArchive: (archiveId) =>
      run((root) =>
        withDatabase(root, 'write', (database) => {
          assertArchiveId(archiveId);
          return (
            database
              .prepare('DELETE FROM workflow_daily_review_archives WHERE archive_id = ?')
              .run(archiveId).changes > 0
          );
        }),
      ),
    pruneArchives: (maxArchives) =>
      run((root) =>
        withDatabase(root, 'write', (database) => {
          const limit = Math.max(0, Math.trunc(maxArchives));
          if (limit === 0) return;
          database
            .prepare(
              `
              DELETE FROM workflow_daily_review_archives
              WHERE archive_id IN (
                SELECT archive_id
                FROM workflow_daily_review_archives
                ORDER BY generated_at DESC, day_from_ms DESC, archive_id
                LIMIT -1 OFFSET ?
              )
            `,
            )
            .run(limit);
        }),
      ),
    close: () => {
      if (closed) return;
      closed = true;
      if (writerByLease.get(lease) === writer) writerByLease.delete(lease);
      writers.delete(writer);
    },
  };
  return Object.freeze(writer);
}

function readConfigSnapshot(
  database: import('node:sqlite').DatabaseSync,
): DailyReviewAuthoritySnapshot {
  const configRow = database
    .prepare(
      'SELECT config_json AS configJson FROM workflow_daily_review_state WHERE singleton = 1',
    )
    .get() as { configJson?: unknown } | undefined;
  const revisionRow = database
    .prepare('SELECT revision FROM workflow_daily_review_authority_state WHERE singleton = 1')
    .get() as { revision?: unknown } | undefined;
  const revision =
    typeof revisionRow?.revision === 'number' &&
    Number.isSafeInteger(revisionRow.revision) &&
    revisionRow.revision >= 0
      ? revisionRow.revision
      : 0;
  const config =
    typeof configRow?.configJson === 'string'
      ? normalizeDailyReviewConfig(JSON.parse(configRow.configJson) as Partial<DailyReviewConfig>)
      : DEFAULT_DAILY_REVIEW_CONFIG;
  return { revision, config };
}

function decodeArchive(archiveId: string, recordJson: string): DailyReviewArchive {
  const archive = normalizeDailyReviewArchive(JSON.parse(recordJson));
  if (archive.id !== archiveId) {
    throw new Error(`Daily Review archive id mismatch: ${archiveId}`);
  }
  return archive;
}

function assertArchiveId(archiveId: string): void {
  if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
    throw new Error(`Invalid Daily Review archive id: ${archiveId}`);
  }
}

function sameConfig(left: DailyReviewConfig, right: DailyReviewConfig): boolean {
  return (
    left.enabled === right.enabled &&
    left.executeTime === right.executeTime &&
    left.modelKey === right.modelKey
  );
}
