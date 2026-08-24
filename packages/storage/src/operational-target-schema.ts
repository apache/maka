/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
  return new Map(readSchemaObjects(database).map((object) => [object.key, object.signature]));
}

function readSchemaObjects(
  database: DatabaseSync,
): Array<{ key: string; tableName: string; signature: string }> {
  const rows = database
    .prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view') AND sql IS NOT NULL
      ORDER BY type, name
    `)
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  return rows.map(({ type, name, tbl_name, sql }) => ({
    key: `${type}:${name}`,
    tableName: tbl_name,
    signature: normalizeReleasedSchemaException(name, `${type}:${tbl_name}:${normalizeSql(sql)}`),
  }));
}

/**
 * Released DDL for the pre-authority migration metadata tables, verbatim from
 * commit 1caea265c^ (before SQLite became the sole operational authority). These
 * strings are only ever read back through {@link readSchemaObjects} in a throwaway
 * database, so their exact whitespace/case is irrelevant — the normalized
 * `type:tbl_name:sql` signature (including CHECK/FK constraints and any attached
 * index/trigger) is what the retirement gate recognizes.
 */
const RELEASED_LEGACY_RETIREMENT_DDL: ReadonlyMap<string, string> = new Map([
  [
    'cutover_journal',
    `CREATE TABLE IF NOT EXISTS cutover_journal (
      store_name TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('started', 'completed')),
      started_at INTEGER NOT NULL CHECK (started_at >= 0),
      completed_at INTEGER,
      validation_json TEXT
    )`,
  ],
  [
    'runtime_import_sources',
    `CREATE TABLE runtime_import_sources (
      source_path TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      imported_at INTEGER NOT NULL
    )`,
  ],
  [
    'session_metadata_import_sources',
    `CREATE TABLE session_metadata_import_sources (
      source_path TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      session_id TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
    )`,
  ],
]);

let cachedLegacyRetirementSchema: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined;

function buildLegacyRetirementSchema(): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    for (const ddl of RELEASED_LEGACY_RETIREMENT_DDL.values()) database.exec(ddl);
    const byTable = new Map<string, Map<string, string>>();
    for (const object of readSchemaObjects(database)) {
      const bucket = byTable.get(object.tableName) ?? new Map<string, string>();
      bucket.set(object.key, object.signature);
      byTable.set(object.tableName, bucket);
    }
    return byTable;
  } finally {
    database.close();
  }
}

/**
 * Fail closed unless every schema object attached to a legacy metadata table
 * (`tableName`) matches the released layout down to CHECK/FK constraints and has
 * no extra index/trigger grafted on. Unlike a column-only comparison this rejects
 * a table that shares the released column names/types but carries altered
 * constraints or additional objects — the destructive retirement below must only
 * DROP shapes it can positively recognize.
 */
export function assertReleasedLegacyRetirementShape(
  database: DatabaseSync,
  tableName: string,
): void {
  const canonical = (cachedLegacyRetirementSchema ??= buildLegacyRetirementSchema()).get(tableName);
  if (canonical === undefined) {
    throw new Error(`No released legacy retirement signature is registered for ${tableName}`);
  }
  const observed = new Map<string, string>();
  for (const object of readSchemaObjects(database)) {
    if (object.tableName === tableName) observed.set(object.key, object.signature);
  }
  for (const [key, signature] of canonical) {
    const actual = observed.get(key);
    if (actual === undefined) {
      throw new Error(`Legacy operational metadata object ${key} is missing its released shape`);
    }
    if (actual !== signature) {
      throw new Error(`Legacy operational metadata object ${key} has an unfamiliar released shape`);
    }
  }
  for (const key of observed.keys()) {
    if (!canonical.has(key)) {
      throw new Error(
        `Legacy operational metadata table ${tableName} carries an unexpected object ${key}`,
      );
    }
  }
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
