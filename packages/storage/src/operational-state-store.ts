import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import {
  configureSqliteRuntimeDatabase,
  migrateSqliteRuntimeDatabase,
  SQLITE_RUNTIME_SCHEMA_VERSION,
} from './sqlite-runtime-schema.js';
import {
  migrateSqliteSessionMetadataDatabase,
  SQLITE_SESSION_METADATA_SCHEMA_VERSION,
} from './sqlite-session-metadata-schema.js';
import {
  migrateSqliteCoreExecutionDatabase,
  SQLITE_CORE_EXECUTION_SCHEMA_VERSION,
} from './sqlite-core-execution-schema.js';
import {
  migrateSqliteWorkflowDatabase,
  SQLITE_WORKFLOW_SCHEMA_VERSION,
} from './sqlite-workflow-schema.js';
import { migrateSqliteUsageDatabase, SQLITE_USAGE_SCHEMA_VERSION } from './sqlite-usage-schema.js';
import {
  migrateSqliteArtifactDatabase,
  SQLITE_ARTIFACT_SCHEMA_VERSION,
} from './sqlite-artifact-schema.js';
import {
  migrateSqliteAutomationDatabase,
  SQLITE_AUTOMATION_SCHEMA_VERSION,
} from './sqlite-automation-schema.js';

export const OPERATIONAL_STATE_DATABASE_NAME = 'runtime.sqlite';
export const LEGACY_SESSION_METADATA_DATABASE_NAME = 'sessions.sqlite';
export const OPERATIONAL_STATE_SCHEMA_VERSION = 1;

const SESSION_METADATA_TABLES = [
  'session_metadata',
  'session_metadata_labels',
  'session_metadata_import_sources',
  'session_metadata_tombstones',
  'subagent_spawns',
  'agent_graph_intent_claims',
  'agent_graph_schedule_updates',
  'agent_graph_operator_provisions',
  'agent_graph_client_projections',
  'agent_graph_client_operator_projections',
  'agent_graph_client_terminal_activity',
  'agent_graph_client_applied_records',
  'agent_graph_supervisor_wakes',
  'agent_graph_supervisor_wake_attempts',
  'sandbox_boundary_log',
] as const;

const require = createRequire(import.meta.url);
const owners = new Map<string, OperationalStateDatabaseOwner>();

export type OperationalStateCutoverFailpoint =
  | 'after_cutover_started'
  | 'after_cutover_rows_copied'
  | 'after_cutover_validated';

export interface OperationalStateDatabaseOptions {
  now?: () => number;
  failpoint?: (point: OperationalStateCutoverFailpoint) => void;
}

export interface OperationalStateDatabaseLease {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  transaction<T>(mode: 'read' | 'write', operation: () => T): T;
  backup(destinationPath: string): Promise<number>;
  close(): void;
}

export type OperationalStoreCutoverFailpoint =
  | 'after_cutover_started'
  | 'after_cutover_rows_copied'
  | 'after_cutover_validated';

export interface OperationalStoreCutoverInput {
  readonly storeName: string;
  readonly sourcePath: string;
  readonly sourceFingerprint: string;
  readonly importAndValidate: (database: DatabaseSync) => Readonly<Record<string, number>>;
  readonly now?: () => number;
  readonly failpoint?: (point: OperationalStoreCutoverFailpoint) => void;
}

interface CutoverJournalRow {
  source_fingerprint: string;
  state: 'started' | 'completed';
}

interface TableColumn {
  name: string;
  pk: number;
}

/**
 * Acquire the process-local owner for the operational SQLite authority.
 *
 * Repositories receive leases instead of opening independent connections.
 * The last lease closes the connection, while transaction boundaries remain
 * centralized on the owner for the lifetime of the workspace.
 */
export function acquireOperationalStateDatabase(
  workspaceRoot: string,
  options: OperationalStateDatabaseOptions = {},
): OperationalStateDatabaseLease {
  const databasePath = resolve(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME);
  let owner = owners.get(databasePath);
  if (!owner) {
    owner = new OperationalStateDatabaseOwner(databasePath, options);
    owners.set(databasePath, owner);
  }
  return owner.acquire();
}

class OperationalStateDatabaseOwner {
  readonly database: DatabaseSync;
  private references = 0;
  private closed = false;
  private transactionDepth = 0;

  constructor(
    readonly databasePath: string,
    options: OperationalStateDatabaseOptions,
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const Database = loadDatabaseSync();
    this.database = new Database(databasePath);
    try {
      configureSqliteRuntimeDatabase(this.database);
      migrateSqliteRuntimeDatabase(this.database);
      migrateSqliteSessionMetadataDatabase(this.database);
      migrateSqliteCoreExecutionDatabase(this.database);
      migrateSqliteWorkflowDatabase(this.database);
      migrateSqliteUsageDatabase(this.database);
      migrateSqliteArtifactDatabase(this.database);
      migrateSqliteAutomationDatabase(this.database);
      migrateOperationalStateDatabase(this.database, options.now ?? Date.now);
      cutoverLegacySessionMetadata({
        destination: this.database,
        destinationPath: databasePath,
        sourcePath: join(dirname(databasePath), LEGACY_SESSION_METADATA_DATABASE_NAME),
        now: options.now ?? Date.now,
        failpoint: options.failpoint,
      });
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  acquire(): OperationalStateDatabaseLease {
    if (this.closed) throw new Error('Operational state database is closed');
    this.references += 1;
    let released = false;
    return {
      database: this.database,
      databasePath: this.databasePath,
      transaction: (mode, operation) => this.transaction(mode, operation),
      backup: (destinationPath) => this.backup(destinationPath),
      close: () => {
        if (released) return;
        released = true;
        this.releaseReference();
      },
    };
  }

  private async backup(destinationPath: string): Promise<number> {
    if (this.closed) throw new Error('Operational state database is closed');
    if (!destinationPath) throw new Error('Operational state backup destination is required');
    const canonicalDestination = resolve(destinationPath);
    if (canonicalDestination === this.databasePath) {
      throw new Error('Operational state backup destination must differ from the source database');
    }
    if (existsSync(canonicalDestination)) {
      throw new Error(
        `Operational state backup destination already exists: ${canonicalDestination}`,
      );
    }
    mkdirSync(dirname(canonicalDestination), { recursive: true });
    this.references += 1;
    try {
      return await loadSqliteModule().backup(this.database, canonicalDestination);
    } finally {
      this.releaseReference();
    }
  }

  private releaseReference(): void {
    this.references -= 1;
    if (this.references !== 0) return;
    this.closed = true;
    owners.delete(this.databasePath);
    this.database.close();
  }

  private transaction<T>(mode: 'read' | 'write', operation: () => T): T {
    if (this.closed) throw new Error('Operational state database is closed');
    if (this.transactionDepth > 0) return operation();
    this.database.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.database);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

function migrateOperationalStateDatabase(db: DatabaseSync, now: () => number): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS operational_schema_migrations (
        scope TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 0),
        applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
      );

      CREATE TABLE IF NOT EXISTS cutover_journal (
        store_name TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('started', 'completed')),
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        completed_at INTEGER,
        validation_json TEXT
      );
    `);
    const appliedAt = now();
    registerSchema(db, 'runtime', SQLITE_RUNTIME_SCHEMA_VERSION, appliedAt);
    registerSchema(db, 'session_metadata', SQLITE_SESSION_METADATA_SCHEMA_VERSION, appliedAt);
    registerSchema(db, 'core_execution', SQLITE_CORE_EXECUTION_SCHEMA_VERSION, appliedAt);
    registerSchema(db, 'workflow', SQLITE_WORKFLOW_SCHEMA_VERSION, appliedAt);
    registerSchema(db, 'usage', SQLITE_USAGE_SCHEMA_VERSION, appliedAt);
    registerSchema(db, 'artifact', SQLITE_ARTIFACT_SCHEMA_VERSION, appliedAt);
    registerSchema(db, 'automation', SQLITE_AUTOMATION_SCHEMA_VERSION, appliedAt);
    registerSchema(db, 'operational', OPERATIONAL_STATE_SCHEMA_VERSION, appliedAt);
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw error;
  }
}

/**
 * Complete one logical legacy-store cutover under the operational owner.
 *
 * The durable `started` row intentionally commits before the data transaction.
 * A crash therefore resumes against the same source fingerprint, while copied
 * rows and the completed marker commit atomically.
 */
export function completeOperationalStoreCutover(
  lease: OperationalStateDatabaseLease,
  input: OperationalStoreCutoverInput,
): void {
  const journal = lease.database
    .prepare(`
      SELECT source_fingerprint, state
      FROM cutover_journal
      WHERE store_name = ?
    `)
    .get(input.storeName) as CutoverJournalRow | undefined;
  if (journal?.state === 'completed') {
    if (journal.source_fingerprint !== input.sourceFingerprint) {
      throw new Error(`Legacy ${input.storeName} source changed after cutover completed`);
    }
    return;
  }
  if (journal && journal.source_fingerprint !== input.sourceFingerprint) {
    throw new Error(`Legacy ${input.storeName} source changed after cutover started`);
  }
  if (!journal) {
    lease.transaction('write', () => {
      lease.database
        .prepare(`
          INSERT INTO cutover_journal(
            store_name,
            source_path,
            source_fingerprint,
            state,
            started_at
          ) VALUES (?, ?, ?, 'started', ?)
        `)
        .run(input.storeName, input.sourcePath, input.sourceFingerprint, (input.now ?? Date.now)());
    });
  }
  input.failpoint?.('after_cutover_started');
  lease.transaction('write', () => {
    const validation = input.importAndValidate(lease.database);
    input.failpoint?.('after_cutover_rows_copied');
    for (const [name, count] of Object.entries(validation)) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`Invalid ${input.storeName} cutover validation count for ${name}`);
      }
    }
    input.failpoint?.('after_cutover_validated');
    const result = lease.database
      .prepare(`
        UPDATE cutover_journal
        SET state = 'completed', completed_at = ?, validation_json = ?
        WHERE store_name = ?
          AND source_fingerprint = ?
          AND state = 'started'
      `)
      .run(
        (input.now ?? Date.now)(),
        JSON.stringify(validation),
        input.storeName,
        input.sourceFingerprint,
      );
    if (result.changes !== 1) {
      throw new Error(`Unable to complete ${input.storeName} cutover journal`);
    }
  });
}

function registerSchema(db: DatabaseSync, scope: string, version: number, appliedAt: number): void {
  const existing = db
    .prepare('SELECT version FROM operational_schema_migrations WHERE scope = ?')
    .get(scope) as { version?: unknown } | undefined;
  if (
    existing &&
    (typeof existing.version !== 'number' ||
      !Number.isSafeInteger(existing.version) ||
      existing.version > version)
  ) {
    throw new Error(`Operational schema ${scope} is newer than supported version ${version}`);
  }
  db.prepare(`
    INSERT INTO operational_schema_migrations(scope, version, applied_at)
    VALUES (?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      version = excluded.version,
      applied_at = CASE
        WHEN operational_schema_migrations.version = excluded.version
        THEN operational_schema_migrations.applied_at
        ELSE excluded.applied_at
      END
  `).run(scope, version, appliedAt);
}

function cutoverLegacySessionMetadata(input: {
  destination: DatabaseSync;
  destinationPath: string;
  sourcePath: string;
  now: () => number;
  failpoint?: (point: OperationalStateCutoverFailpoint) => void;
}): void {
  if (
    !existsSync(input.sourcePath) ||
    resolve(input.sourcePath) === resolve(input.destinationPath)
  ) {
    return;
  }
  const sourceStat = lstatSync(input.sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size === 0) {
    throw new Error('Legacy sessions.sqlite is not a non-empty regular database file');
  }

  const Database = loadDatabaseSync();
  const source = new Database(input.sourcePath);
  try {
    configureSqliteRuntimeDatabase(source);
    migrateSqliteSessionMetadataDatabase(source);
    source.exec('BEGIN IMMEDIATE');
    try {
      const fingerprint = fingerprintSessionMetadata(source);
      const journal = input.destination
        .prepare(`
          SELECT source_fingerprint, state
          FROM cutover_journal
          WHERE store_name = 'session_metadata'
        `)
        .get() as CutoverJournalRow | undefined;
      if (journal?.state === 'completed') {
        if (journal.source_fingerprint !== fingerprint) {
          throw new Error(
            'Legacy sessions.sqlite changed after session metadata cutover completed',
          );
        }
        source.exec('COMMIT');
        return;
      }
      if (journal && journal.source_fingerprint !== fingerprint) {
        throw new Error('Legacy sessions.sqlite changed after session metadata cutover started');
      }
      if (!journal) {
        input.destination.exec('BEGIN IMMEDIATE');
        try {
          input.destination
            .prepare(`
              INSERT INTO cutover_journal(
                store_name,
                source_path,
                source_fingerprint,
                state,
                started_at
              ) VALUES ('session_metadata', ?, ?, 'started', ?)
            `)
            .run(input.sourcePath, fingerprint, input.now());
          input.destination.exec('COMMIT');
        } catch (error) {
          rollback(input.destination);
          throw error;
        }
      }
      input.failpoint?.('after_cutover_started');

      input.destination.exec('BEGIN IMMEDIATE');
      let attached = false;
      try {
        input.destination.exec(
          `ATTACH DATABASE ${quoteString(input.sourcePath)} AS legacy_sessions`,
        );
        attached = true;
        const validation: Record<string, number> = {};
        for (const table of SESSION_METADATA_TABLES) {
          const columns = readTableColumns(source, table);
          assertNoCutoverConflicts(input.destination, table, columns);
          const names = columns.map((column) => quoteIdentifier(column.name)).join(', ');
          input.destination.exec(`
            INSERT OR IGNORE INTO main.${quoteIdentifier(table)} (${names})
            SELECT ${names} FROM legacy_sessions.${quoteIdentifier(table)}
          `);
        }
        input.failpoint?.('after_cutover_rows_copied');
        for (const table of SESSION_METADATA_TABLES) {
          const columns = readTableColumns(source, table);
          assertAllSourceRowsCopied(input.destination, table, columns);
          validation[table] = readRowCount(source, table);
        }
        input.failpoint?.('after_cutover_validated');
        input.destination
          .prepare(`
            UPDATE cutover_journal
            SET state = 'completed', completed_at = ?, validation_json = ?
            WHERE store_name = 'session_metadata'
              AND source_fingerprint = ?
              AND state = 'started'
          `)
          .run(input.now(), JSON.stringify(validation), fingerprint);
        input.destination.exec('COMMIT');
      } catch (error) {
        rollback(input.destination);
        throw error;
      } finally {
        if (attached) {
          input.destination.exec('DETACH DATABASE legacy_sessions');
        }
      }
      source.exec('COMMIT');
    } catch (error) {
      rollback(source);
      throw error;
    }
  } finally {
    source.close();
  }
}

function fingerprintSessionMetadata(db: DatabaseSync): string {
  const hash = createHash('sha256');
  hash.update(`session_metadata_schema:${SQLITE_SESSION_METADATA_SCHEMA_VERSION}\n`);
  for (const table of SESSION_METADATA_TABLES) {
    const columns = readTableColumns(db, table);
    const order = primaryKeyColumns(columns);
    const rows = db
      .prepare(
        `SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${order
          .map((column) => quoteIdentifier(column))
          .join(', ')}`,
      )
      .all() as Record<string, unknown>[];
    hash.update(`${table}:${rows.length}\n`);
    for (const row of rows) {
      hash.update(JSON.stringify(columns.map((column) => row[column.name])));
      hash.update('\n');
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

function assertNoCutoverConflicts(
  db: DatabaseSync,
  table: string,
  columns: readonly TableColumn[],
): void {
  const primaryKey = primaryKeyColumns(columns);
  const identity = primaryKey
    .map(
      (column) =>
        `main.${quoteIdentifier(table)}.${quoteIdentifier(column)} IS legacy.${quoteIdentifier(column)}`,
    )
    .join(' AND ');
  const equality = columns
    .map(
      (column) =>
        `main.${quoteIdentifier(table)}.${quoteIdentifier(column.name)} IS legacy.${quoteIdentifier(column.name)}`,
    )
    .join(' AND ');
  const row = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM legacy_sessions.${quoteIdentifier(table)} AS legacy
      JOIN main.${quoteIdentifier(table)}
        ON ${identity}
      WHERE NOT (${equality})
    `)
    .get() as { count?: unknown } | undefined;
  if (row?.count !== 0) {
    throw new Error(`Session metadata cutover conflict in table ${table}`);
  }
}

function assertAllSourceRowsCopied(
  db: DatabaseSync,
  table: string,
  columns: readonly TableColumn[],
): void {
  const equality = columns
    .map(
      (column) =>
        `main.${quoteIdentifier(table)}.${quoteIdentifier(column.name)} IS legacy.${quoteIdentifier(column.name)}`,
    )
    .join(' AND ');
  const row = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM legacy_sessions.${quoteIdentifier(table)} AS legacy
      WHERE NOT EXISTS (
        SELECT 1 FROM main.${quoteIdentifier(table)}
        WHERE ${equality}
      )
    `)
    .get() as { count?: unknown } | undefined;
  if (row?.count !== 0) {
    throw new Error(`Session metadata cutover validation failed for table ${table}`);
  }
}

function readTableColumns(db: DatabaseSync, table: string): TableColumn[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
    name?: unknown;
    pk?: unknown;
  }>;
  const columns = rows.map((row) => {
    if (
      typeof row.name !== 'string' ||
      typeof row.pk !== 'number' ||
      !Number.isSafeInteger(row.pk)
    ) {
      throw new Error(`Invalid SQLite table metadata for ${table}`);
    }
    return { name: row.name, pk: row.pk };
  });
  if (columns.length === 0 || columns.every((column) => column.pk === 0)) {
    throw new Error(`Session metadata cutover table ${table} has no primary key`);
  }
  return columns;
}

function primaryKeyColumns(columns: readonly TableColumn[]): string[] {
  return columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
}

function readRowCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as
    | { count?: unknown }
    | undefined;
  if (typeof row?.count !== 'number' || !Number.isSafeInteger(row.count) || row.count < 0) {
    throw new Error(`Invalid row count for ${table}`);
  }
  return row.count;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const warningType = typeof args[0] === 'string' ? args[0] : undefined;
    if (
      warningType === 'ExperimentalWarning' &&
      String(warning).startsWith('SQLite is an experimental feature')
    ) {
      return;
    }
    Reflect.apply(emitWarning, process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try {
    return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  } finally {
    process.emitWarning = emitWarning;
  }
}

function loadSqliteModule(): typeof import('node:sqlite') {
  return require('node:sqlite') as typeof import('node:sqlite');
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the failure that triggered rollback.
  }
}
