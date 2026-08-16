import { DatabaseSync } from 'node:sqlite';
import { migrateSqliteArtifactDatabase } from './sqlite-artifact-schema.js';
import { migrateSqliteCoreExecutionDatabase } from './sqlite-core-execution-schema.js';
import { migrateSqliteRuntimeDatabase } from './sqlite-runtime-schema.js';
import { migrateSqliteSessionMetadataDatabase } from './sqlite-session-metadata-schema.js';
import { migrateSqliteUsageDatabase } from './sqlite-usage-schema.js';
import { migrateSqliteWorkflowDatabase } from './sqlite-workflow-schema.js';

class IncompleteOperationalSchemaError extends Error {}

let cachedTargetSchema: ReadonlyMap<string, string> | undefined;

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
  for (const [name, required] of target) {
    const observed = actual.get(name);
    if (observed === undefined) throw incomplete(`missing required schema object ${name}`);
    if (observed !== required)
      throw incomplete(`schema object ${name} has an incompatible definition`);
  }
  for (const name of actual.keys()) {
    if (!target.has(name)) throw incomplete(`unexpected schema object ${name}`);
  }
}

function buildOperationalTargetSchema(): ReadonlyMap<string, string> {
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

function readSchema(database: DatabaseSync): ReadonlyMap<string, string> {
  const rows = database
    .prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view') AND sql IS NOT NULL
      ORDER BY type, name
    `)
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  return new Map(
    rows.map(({ type, name, tbl_name, sql }) => [
      `${type}:${name}`,
      normalizeReleasedSchemaException(name, `${type}:${tbl_name}:${normalizeSql(sql)}`),
    ]),
  );
}

function normalizeReleasedSchemaException(name: string, signature: string): string {
  if (name !== 'workflow_quote_companion_cleanup') return signature;
  return signature.replace(/RECORD_JSON TEXT(?=[,)])/u, 'RECORD_JSON TEXT NOT NULL');
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
    if (quote === '(' || quote === ')' || quote === ',' || quote === ';') {
      normalized = normalized.trimEnd();
      normalized += quote;
      pendingSpace = false;
      continue;
    }
    if (pendingSpace && !normalized.endsWith('(') && !normalized.endsWith(',')) normalized += ' ';
    normalized += value[index]?.toUpperCase();
    pendingSpace = false;
  }
  return normalized;
}

function incomplete(detail: string): IncompleteOperationalSchemaError {
  return new IncompleteOperationalSchemaError(`Incomplete operational SQLite schema: ${detail}`);
}
