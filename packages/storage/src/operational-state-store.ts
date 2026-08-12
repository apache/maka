import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import {
  configureSqliteRuntimeDatabase,
  configureSqliteRuntimeLockWait,
  migrateSqliteRuntimeDatabase,
  readUserVersion,
  SQLITE_RUNTIME_SCHEMA_VERSION,
} from './sqlite-runtime-schema.js';
import {
  migrateSqliteSessionMetadataDatabase,
  readSqliteSessionMetadataSchemaVersion,
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
  assertLegacySchedulingSchema,
  insertMigratedScheduledTasks,
  planLegacyScheduledTasks,
} from './sqlite-legacy-scheduling.js';

export const OPERATIONAL_STATE_DATABASE_NAME = 'runtime.sqlite';
export const OPERATIONAL_STATE_SCHEMA_VERSION = 2;

/** Resolve the authoritative on-disk path of the operational-state database. */
export function resolveOperationalStateDatabasePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME);
}

const OPERATIONAL_SCHEMA_VERSIONS: ReadonlyMap<string, number> = new Map([
  ['runtime', SQLITE_RUNTIME_SCHEMA_VERSION],
  ['session_metadata', SQLITE_SESSION_METADATA_SCHEMA_VERSION],
  ['core_execution', SQLITE_CORE_EXECUTION_SCHEMA_VERSION],
  ['workflow', SQLITE_WORKFLOW_SCHEMA_VERSION],
  ['usage', SQLITE_USAGE_SCHEMA_VERSION],
  ['artifact', SQLITE_ARTIFACT_SCHEMA_VERSION],
  ['operational', OPERATIONAL_STATE_SCHEMA_VERSION],
] as const);
const REMOVED_OPERATIONAL_SCHEMA_VERSIONS: ReadonlyMap<string, number> = new Map([
  ['automation', 2],
]);

const require = createRequire(import.meta.url);
const owners = new Map<string, OperationalStateDatabaseOwner>();

export interface OperationalStateDatabaseOptions {
  now?: () => number;
}

export class OperationalStateMigrationBlockedError extends Error {
  readonly code = 'operational_state_migration_blocked';

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Operational state migration is blocked', {
      cause,
    });
    this.name = 'OperationalStateMigrationBlockedError';
  }
}

export interface OperationalStateDatabaseLease {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  transaction<T>(mode: 'read' | 'write', operation: () => T): T;
  backup(destinationPath: string): Promise<number>;
  close(): void;
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
  const databasePath = resolveOperationalStateDatabasePath(workspaceRoot);
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
      configureSqliteRuntimeLockWait(this.database);
      this.database.exec('PRAGMA foreign_keys = ON');
      inspectAndMigrateOperationalState(this.database, options.now ?? Date.now);
      configureSqliteRuntimeDatabase(this.database);
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

function inspectAndMigrateOperationalState(database: DatabaseSync, now: () => number): void {
  try {
    inspectOperationalStateSchema(database);
    migrateOperationalStateDatabaseInternal(database, now);
  } catch (error) {
    if (isSqliteEnvironmentError(error)) throw error;
    throw new OperationalStateMigrationBlockedError(error);
  }
}

function isSqliteEnvironmentError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode !== 'number') return false;
  return [5, 6, 7, 8, 10, 13, 14].includes(errcode & 0xff);
}

export interface OperationalStateSchemaInspection {
  readonly status: 'current' | 'needs_migration';
  readonly versions: ReadonlyMap<string, number>;
}

export function inspectOperationalStateSchema(
  database: DatabaseSync,
): OperationalStateSchemaInspection {
  if (database.isTransaction) return inspectOperationalStateSchemaInternal(database);
  database.exec('BEGIN');
  try {
    const inspection = inspectOperationalStateSchemaInternal(database);
    database.exec('COMMIT');
    return inspection;
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function inspectOperationalStateSchemaInternal(
  database: DatabaseSync,
): OperationalStateSchemaInspection {
  let needsMigration = false;
  const runtimeVersion = readUserVersion(database);
  const versions = new Map<string, number>([['runtime', runtimeVersion]]);
  assertSupportedOperationalSchemaVersion('runtime', runtimeVersion, SQLITE_RUNTIME_SCHEMA_VERSION);
  needsMigration ||= runtimeVersion < SQLITE_RUNTIME_SCHEMA_VERSION;

  if (hasTable(database, 'session_metadata_schema')) {
    const sessionMetadataVersion = readSqliteSessionMetadataSchemaVersion(database);
    versions.set('session_metadata', sessionMetadataVersion);
    assertSupportedOperationalSchemaVersion(
      'session_metadata',
      sessionMetadataVersion,
      SQLITE_SESSION_METADATA_SCHEMA_VERSION,
    );
    needsMigration ||= sessionMetadataVersion < SQLITE_SESSION_METADATA_SCHEMA_VERSION;
  } else {
    needsMigration = true;
  }

  if (!hasTable(database, 'operational_schema_migrations')) {
    if (runtimeVersion === 0 && !hasApplicationSchemaObjects(database)) {
      return { status: 'needs_migration', versions };
    }
    throw new Error(
      'Operational schema registry is missing from a nonempty database; ' +
        'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
    );
  }
  const rows = database
    .prepare('SELECT scope, version FROM operational_schema_migrations')
    .all() as Array<{ scope?: unknown; version?: unknown }>;
  const registered = new Map<string, number>();
  for (const { scope, version } of rows) {
    if (typeof scope !== 'string') {
      throw new Error(
        'Operational schema registry has an invalid scope; ' +
          'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
      );
    }
    const supportedVersion = OPERATIONAL_SCHEMA_VERSIONS.get(scope);
    if (supportedVersion === undefined) {
      const removedVersion = REMOVED_OPERATIONAL_SCHEMA_VERSIONS.get(scope);
      if (removedVersion !== undefined) {
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
          throw new Error(`Operational schema ${scope} has invalid version ${String(version)}`);
        }
        assertSupportedOperationalSchemaVersion(scope, version, removedVersion);
        versions.set(scope, version);
        needsMigration = true;
        continue;
      }
      throw new Error(
        `Operational schema ${scope} is unknown to this Maka build; ` +
          'Maka did not migrate or delete the database. Upgrade Maka to open this workspace.',
      );
    }
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
      throw new Error(
        `Operational schema ${scope} has invalid version ${String(version)}; ` +
          'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
      );
    }
    assertSupportedOperationalSchemaVersion(scope, version, supportedVersion);
    registered.set(scope, version);
    if (scope === 'workflow' || scope === 'automation') versions.set(scope, version);
  }
  assertLegacySchedulingSchema(database, versions);
  for (const [scope, version] of OPERATIONAL_SCHEMA_VERSIONS) {
    const registeredVersion = registered.get(scope);
    if (registeredVersion === undefined) {
      throw new Error(
        `Operational schema registry is missing scope ${scope}; ` +
          'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
      );
    }
    needsMigration ||= registeredVersion < version;
  }
  return { status: needsMigration ? 'needs_migration' : 'current', versions };
}

function assertSupportedOperationalSchemaVersion(
  scope: string,
  observedVersion: number,
  supportedVersion: number,
): void {
  if (observedVersion <= supportedVersion) return;
  throw new Error(
    `Operational schema ${scope} is newer than supported version ${supportedVersion}; ` +
      'Maka did not migrate or delete the database. Upgrade Maka to open this workspace.',
  );
}

function hasTable(database: DatabaseSync, name: string): boolean {
  const table = database
    .prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `)
    .get(name) as { present?: unknown } | undefined;
  return table?.present === 1;
}

function hasApplicationSchemaObjects(database: DatabaseSync): boolean {
  const object = database
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get() as { present?: unknown } | undefined;
  return object?.present === 1;
}

export function migrateOperationalStateDatabaseInternal(db: DatabaseSync, now: () => number): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const inspection = inspectOperationalStateSchema(db);
    const legacyScheduledTasks = planLegacyScheduledTasks(db, inspection.versions);
    migrateSqliteRuntimeDatabase(db, { transaction: 'caller' });
    migrateSqliteSessionMetadataDatabase(db, { transaction: 'caller' });
    migrateSqliteCoreExecutionDatabase(db);
    migrateSqliteWorkflowDatabase(db);
    insertMigratedScheduledTasks(db, legacyScheduledTasks);
    migrateSqliteUsageDatabase(db);
    migrateSqliteArtifactDatabase(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS operational_schema_migrations (
        scope TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 0),
        applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
      );
    `);
    const appliedAt = now();
    db.exec(`
      DROP TABLE IF EXISTS automation_pending_fires;
      DROP TABLE IF EXISTS automation_definitions;
      DROP TABLE IF EXISTS automation_authority_state;
      DELETE FROM operational_schema_migrations WHERE scope = 'automation';
    `);
    for (const [scope, version] of OPERATIONAL_SCHEMA_VERSIONS) {
      registerSchema(db, scope, version, appliedAt);
    }
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function registerSchema(db: DatabaseSync, scope: string, version: number, appliedAt: number): void {
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
