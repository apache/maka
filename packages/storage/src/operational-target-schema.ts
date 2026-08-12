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
  readonly foreignKeys: ReadonlySet<string>;
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
    for (const foreignKey of required.foreignKeys) {
      if (!observed.foreignKeys.has(foreignKey)) {
        throw incomplete(`table ${table} is missing required foreign key ${foreignKey}`);
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
        foreignKeys: readForeignKeys(database, row.name),
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

function readForeignKeys(database: DatabaseSync, table: string): ReadonlySet<string> {
  const rows = database
    .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
    .all() as Array<{
    id?: unknown;
    seq?: unknown;
    table?: unknown;
    from?: unknown;
    to?: unknown;
    on_update?: unknown;
    on_delete?: unknown;
    match?: unknown;
  }>;
  const grouped = new Map<number, Array<(typeof rows)[number] & { seq: number }>>();
  for (const row of rows) {
    if (typeof row.id !== 'number' || typeof row.seq !== 'number') continue;
    const group = grouped.get(row.id) ?? [];
    group.push({ ...row, seq: row.seq });
    grouped.set(row.id, group);
  }
  return new Set(
    [...grouped.values()].map((group) =>
      group
        .sort((left, right) => left.seq - right.seq)
        .map(
          (row) =>
            `${String(row.table)}:${String(row.from)}:${String(row.to)}:${String(row.on_update)}:${String(row.on_delete)}:${String(row.match)}`,
        )
        .join(','),
    ),
  );
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
  let normalized = '';
  let pendingSpace = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '-' && value[index + 1] === '-') {
      for (; index < value.length && value[index] !== '\n'; index += 1) {}
      pendingSpace ||= normalized.length > 0;
      continue;
    }
    if (value[index] === '/' && value[index + 1] === '*') {
      for (index += 2; index < value.length; index += 1) {
        if (value[index] === '*' && value[index + 1] === '/') {
          index += 1;
          break;
        }
      }
      pendingSpace ||= normalized.length > 0;
      continue;
    }
    const quote = value[index];
    if (quote === "'" || quote === '"' || quote === '`' || quote === '[') {
      if (pendingSpace) normalized += ' ';
      const close = quote === '[' ? ']' : quote;
      normalized += quote;
      for (index += 1; index < value.length; index += 1) {
        normalized += value[index];
        if (value[index] !== close) continue;
        if (close !== ']' && value[index + 1] === close) {
          index += 1;
          normalized += value[index];
          continue;
        }
        break;
      }
      pendingSpace = false;
      continue;
    }
    if (/\s/u.test(quote ?? '')) {
      pendingSpace ||= normalized.length > 0;
      continue;
    }
    if (pendingSpace) normalized += ' ';
    normalized += value[index]?.toUpperCase();
    pendingSpace = false;
  }
  return normalized;
}

function extractChecks(sql: string): string[] {
  const normalized = normalizeSql(sql);
  const masked = maskQuotedSql(normalized);
  const checks: string[] = [];
  for (
    let start = findKeyword(masked, 'CHECK');
    start >= 0;
    start = findKeyword(masked, 'CHECK', start + 1)
  ) {
    const open = masked.indexOf('(', start + 5);
    if (open < 0) break;
    let depth = 0;
    for (let end = open; end < masked.length; end += 1) {
      if (masked[end] === '(') depth += 1;
      if (masked[end] === ')') depth -= 1;
      if (depth === 0) {
        checks.push(normalizeSql(normalized.slice(open + 1, end)));
        start = end;
        break;
      }
    }
  }
  return checks;
}

function maskQuotedSql(sql: string): string {
  const masked = [...sql];
  for (let index = 0; index < sql.length; index += 1) {
    if (sql[index] === '-' && sql[index + 1] === '-') {
      for (; index < sql.length && sql[index] !== '\n'; index += 1) masked[index] = ' ';
      continue;
    }
    if (sql[index] === '/' && sql[index + 1] === '*') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      for (index += 2; index < sql.length; index += 1) {
        masked[index] = ' ';
        if (sql[index] === '*' && sql[index + 1] === '/') {
          masked[index + 1] = ' ';
          index += 1;
          break;
        }
      }
      continue;
    }
    const quote = sql[index];
    if (quote !== "'" && quote !== '"' && quote !== '`' && quote !== '[') continue;
    const close = quote === '[' ? ']' : quote;
    for (let cursor = index + 1; cursor < sql.length; cursor += 1) {
      masked[cursor] = ' ';
      if (sql[cursor] !== close) continue;
      if (close !== ']' && sql[cursor + 1] === close) {
        masked[cursor + 1] = ' ';
        cursor += 1;
        continue;
      }
      index = cursor;
      break;
    }
  }
  return masked.join('');
}

function findKeyword(sql: string, keyword: string, from = 0): number {
  const upper = sql.toUpperCase();
  for (
    let index = upper.indexOf(keyword, from);
    index >= 0;
    index = upper.indexOf(keyword, index + 1)
  ) {
    const before = sql[index - 1];
    const after = sql[index + keyword.length];
    if (!before?.match(/[A-Z0-9_]/iu) && !after?.match(/[A-Z0-9_]/iu)) return index;
  }
  return -1;
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
