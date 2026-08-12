import { DatabaseSync } from 'node:sqlite';
import { migrateSqliteArtifactDatabase } from './sqlite-artifact-schema.js';
import { migrateSqliteCoreExecutionDatabase } from './sqlite-core-execution-schema.js';
import { migrateSqliteRuntimeDatabase } from './sqlite-runtime-schema.js';
import { migrateSqliteSessionMetadataDatabase } from './sqlite-session-metadata-schema.js';
import { migrateSqliteUsageDatabase } from './sqlite-usage-schema.js';
import { migrateSqliteWorkflowDatabase } from './sqlite-workflow-schema.js';

interface OperationalTargetSchema {
  readonly tables: ReadonlyMap<string, TableSignature>;
  readonly objects: ReadonlyMap<string, string>;
}

interface TableSignature {
  readonly columns: ReadonlyMap<string, string>;
  readonly checks: ReadonlySet<string>;
  readonly uniqueKeys: ReadonlySet<string>;
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
  for (const [table, required] of target.tables) {
    const observed = actual.tables.get(table);
    if (!observed) throw incomplete(`missing required table ${table}`);
    for (const [column, signature] of required.columns) {
      if (!observed.columns.has(column)) {
        throw incomplete(`table ${table} is missing required column ${column}`);
      }
      if (
        observed.columns.get(column) !== signature &&
        !isReleasedNullableColumn(table, column, observed.columns.get(column), signature)
      ) {
        throw incomplete(`table ${table} column ${column} has an incompatible definition`);
      }
    }
    for (const check of required.checks) {
      if (!observed.checks.has(check)) {
        throw incomplete(`table ${table} is missing required check ${check}`);
      }
    }
    for (const key of required.uniqueKeys) {
      if (!observed.uniqueKeys.has(key)) {
        throw incomplete(`table ${table} is missing required unique key ${key}`);
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
  const tables = new Map<string, TableSignature>();
  const objects = new Map<string, string>();
  for (const row of rows) {
    if (row.type === 'table') {
      tables.set(row.name, {
        columns: readTableColumns(database, row.name),
        checks: new Set(extractChecks(row.sql ?? '')),
        uniqueKeys: readImplicitUniqueKeys(database, row.name),
      });
    } else if (row.sql !== null) {
      objects.set(
        row.name,
        row.type === 'index'
          ? `index:${row.tbl_name}:${normalizeSql(row.sql)}`
          : `trigger:${row.tbl_name}:${normalizeSql(row.sql)}`,
      );
    }
  }
  return { tables, objects };
}

function readTableColumns(database: DatabaseSync, table: string): ReadonlyMap<string, string> {
  const rows = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
    name?: unknown;
    type?: unknown;
    notnull?: unknown;
    dflt_value?: unknown;
    pk?: unknown;
  }>;
  return new Map(
    rows
      .filter(
        (row): row is typeof row & { name: string; type: string; notnull: number; pk: number } =>
          typeof row.name === 'string' &&
          typeof row.type === 'string' &&
          typeof row.notnull === 'number' &&
          typeof row.pk === 'number',
      )
      .map((row) => [
        row.name,
        `${row.type.toUpperCase()}:${row.notnull}:${String(row.dflt_value)}:${row.pk}`,
      ]),
  );
}

function readImplicitUniqueKeys(database: DatabaseSync, table: string): ReadonlySet<string> {
  const indexes = database.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all() as Array<{
    name?: unknown;
    origin?: unknown;
  }>;
  return new Set(
    indexes
      .filter(
        (index): index is { name: string; origin: string } =>
          typeof index.name === 'string' &&
          typeof index.origin === 'string' &&
          index.origin !== 'c',
      )
      .map((index) =>
        (
          database.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all() as Array<{
            seqno: number;
            name: string;
          }>
        )
          .sort((left, right) => left.seqno - right.seqno)
          .map((column) => column.name)
          .join(','),
      ),
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeSql(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim().toUpperCase();
}

function extractChecks(sql: string): string[] {
  const normalized = normalizeSql(sql);
  const checks: string[] = [];
  for (
    let start = normalized.indexOf('CHECK');
    start >= 0;
    start = normalized.indexOf('CHECK', start + 1)
  ) {
    const open = normalized.indexOf('(', start + 5);
    if (open < 0) break;
    let depth = 0;
    for (let end = open; end < normalized.length; end += 1) {
      if (normalized[end] === '(') depth += 1;
      if (normalized[end] === ')') depth -= 1;
      if (depth === 0) {
        checks.push(normalized.slice(open + 1, end).replaceAll(/\s+/gu, ''));
        start = end;
        break;
      }
    }
  }
  return checks;
}

function isReleasedNullableColumn(
  table: string,
  column: string,
  observed: string | undefined,
  required: string,
): boolean {
  return (
    table === 'workflow_quote_companion_cleanup' &&
    column === 'record_json' &&
    observed === required.replace(':1:', ':0:')
  );
}

function incomplete(detail: string): IncompleteOperationalSchemaError {
  return new IncompleteOperationalSchemaError(`Incomplete operational SQLite schema: ${detail}`);
}
