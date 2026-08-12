import { DatabaseSync } from 'node:sqlite';
import { migrateSqliteArtifactDatabase } from './sqlite-artifact-schema.js';
import { migrateSqliteCoreExecutionDatabase } from './sqlite-core-execution-schema.js';
import { migrateSqliteRuntimeDatabase } from './sqlite-runtime-schema.js';
import { migrateSqliteSessionMetadataDatabase } from './sqlite-session-metadata-schema.js';
import { migrateSqliteUsageDatabase } from './sqlite-usage-schema.js';
import { migrateSqliteWorkflowDatabase } from './sqlite-workflow-schema.js';

interface OperationalTargetSchema {
  readonly tables: ReadonlyMap<string, ReadonlySet<string>>;
  readonly objects: ReadonlyMap<string, string>;
}

class IncompleteOperationalSchemaError extends Error {}

let cachedTargetSchema: OperationalTargetSchema | undefined;

export function ensureOperationalSchemaRegistry(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS operational_schema_migrations (
      scope TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version >= 0),
      applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
    );
  `);
}

export function isCurrentOperationalTargetSchema(database: DatabaseSync): boolean {
  try {
    assertCurrentOperationalTargetSchema(database);
    return true;
  } catch (error) {
    if (error instanceof IncompleteOperationalSchemaError) return false;
    throw error;
  }
}

export function assertCurrentOperationalTargetSchema(database: DatabaseSync): void {
  const target = (cachedTargetSchema ??= buildOperationalTargetSchema());
  const actual = readSchema(database);
  for (const [table, requiredColumns] of target.tables) {
    const actualColumns = actual.tables.get(table);
    if (!actualColumns) throw incomplete(`missing required table ${table}`);
    for (const column of requiredColumns) {
      if (!actualColumns.has(column)) {
        throw incomplete(`table ${table} is missing required column ${column}`);
      }
    }
  }
  for (const [object, signature] of target.objects) {
    if (actual.objects.get(object) !== signature) {
      throw incomplete(
        `required ${signature.split(':', 1)[0]} ${object} has an incompatible definition`,
      );
    }
  }
}

function buildOperationalTargetSchema(): OperationalTargetSchema {
  const database = new DatabaseSync(':memory:');
  try {
    migrateSqliteRuntimeDatabase(database);
    migrateSqliteSessionMetadataDatabase(database);
    migrateSqliteCoreExecutionDatabase(database);
    migrateSqliteWorkflowDatabase(database);
    migrateSqliteUsageDatabase(database);
    migrateSqliteArtifactDatabase(database);
    ensureOperationalSchemaRegistry(database);
    return readSchema(database);
  } finally {
    database.close();
  }
}

function readSchema(database: DatabaseSync): OperationalTargetSchema {
  const rows = database
    .prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger')
    `)
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const tables = new Map<string, ReadonlySet<string>>();
  const objects = new Map<string, string>();
  for (const row of rows) {
    if (row.type === 'table') {
      tables.set(row.name, new Set(readColumns(database, `table_info`, row.name)));
    } else if (row.sql !== null) {
      objects.set(
        row.name,
        row.type === 'index'
          ? `index:${row.tbl_name}:${readIndexUnique(database, row.tbl_name, row.name)}:${readColumns(database, 'index_info', row.name).join(',')}`
          : `trigger:${row.tbl_name}:${normalizeSql(row.sql)}`,
      );
    }
  }
  return { tables, objects };
}

function readColumns(
  database: DatabaseSync,
  pragma: 'table_info' | 'index_info',
  object: string,
): string[] {
  return (
    database.prepare(`PRAGMA ${pragma}(${quoteIdentifier(object)})`).all() as Array<{
      name?: unknown;
    }>
  )
    .map((row) => row.name)
    .filter((name): name is string => typeof name === 'string');
}

function readIndexUnique(database: DatabaseSync, table: string, name: string): string {
  const rows = database.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all() as Array<{
    name?: unknown;
    unique?: unknown;
  }>;
  const index = rows.find((row) => row.name === name);
  return index?.unique === 1 ? 'unique' : 'nonunique';
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeSql(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

function incomplete(detail: string): IncompleteOperationalSchemaError {
  return new IncompleteOperationalSchemaError(`Incomplete operational SQLite schema: ${detail}`);
}
