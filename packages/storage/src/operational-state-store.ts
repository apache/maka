import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
export const OPERATIONAL_STATE_SCHEMA_VERSION = 1;

const require = createRequire(import.meta.url);
const owners = new Map<string, OperationalStateDatabaseOwner>();

export interface OperationalStateDatabaseOptions {
  now?: () => number;
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
