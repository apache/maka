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

import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ArtifactRecord } from '@maka/core/artifacts';
import { decodeArtifactRecordJsons } from './artifact-metadata-codec.js';
import { withArtifactWriterLock } from './artifact-writer-lock.js';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
} from './operational-state-store.js';

export const SESSION_BUNDLE_STATE_ENTRIES = ['artifacts', OPERATIONAL_STATE_DATABASE_NAME] as const;
export const SESSION_BUNDLE_PROTECTED_ENTRIES = [] as const;

export type SessionBundleExportErrorCode =
  | 'invalid_root'
  | 'overlapping_roots'
  | 'symlink'
  | 'path_escape'
  | 'unknown_entry'
  | 'unsupported_entry'
  | 'destination_not_empty';

export class SessionBundleExportError extends Error {
  constructor(
    readonly code: SessionBundleExportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SessionBundleExportError';
  }
}

export interface SessionBundleRootLayoutInput {
  stateRoot: string;
  configRoot: string;
  allowShared?: boolean;
}

export interface SessionBundleExportPlanEntry {
  relativePath: string;
  kind: 'file' | 'directory';
  source: 'copy' | 'filtered_runtime_sqlite';
}

export interface SessionBundleExportPlan {
  stateRoot: string;
  configRoot: string;
  destinationRoot: string;
  sessionId: string;
  includedEntries: string[];
  excludedEntries: string[];
  entries: SessionBundleExportPlanEntry[];
}

export interface SessionBundleExportInput extends SessionBundleRootLayoutInput {
  destinationRoot: string;
  sessionId: string;
}

export async function assertSessionBundleRootLayout(
  input: SessionBundleRootLayoutInput,
): Promise<void> {
  const stateRoot = await canonicalRoot(input.stateRoot, 'state');
  const configRoot = await canonicalRoot(input.configRoot, 'config', true);
  assertRootsSeparate(stateRoot, configRoot, input.allowShared === true);
}

export async function planSessionBundleExport(
  input: SessionBundleExportInput,
): Promise<SessionBundleExportPlan> {
  assertSafeSessionId(input.sessionId);
  const stateRoot = await canonicalRoot(input.stateRoot, 'state');
  const configRoot = await canonicalRoot(input.configRoot, 'config', true);
  const destinationRoot = resolve(input.destinationRoot);
  assertRootsSeparate(stateRoot, configRoot, input.allowShared === true);
  assertRootsSeparate(stateRoot, destinationRoot, false);
  assertRootsSeparate(configRoot, destinationRoot, false);

  const databasePath = resolve(stateRoot, OPERATIONAL_STATE_DATABASE_NAME);
  await assertRegularFile(databasePath, OPERATIONAL_STATE_DATABASE_NAME);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let artifacts: ArtifactRecord[];
  try {
    const session = database
      .prepare('SELECT 1 AS present FROM session_metadata WHERE session_id = ?')
      .get(input.sessionId);
    if (!session) {
      throw new SessionBundleExportError(
        'invalid_root',
        `Session bundle session does not exist: ${input.sessionId}`,
      );
    }
    const rows = database
      .prepare(
        'SELECT record_json FROM artifact_records WHERE session_id = ? ORDER BY created_at, storage_key',
      )
      .all(input.sessionId) as Array<{ record_json?: unknown }>;
    artifacts = decodeArtifactRecordJsons(rows.map((row) => row.record_json));
  } finally {
    database.close();
  }

  const entries: SessionBundleExportPlanEntry[] = [
    {
      relativePath: OPERATIONAL_STATE_DATABASE_NAME,
      kind: 'file',
      source: 'filtered_runtime_sqlite',
    },
  ];
  const includedEntries = [OPERATIONAL_STATE_DATABASE_NAME];
  if (artifacts.length > 0) {
    entries.push({ relativePath: 'artifacts', kind: 'directory', source: 'copy' });
    for (const artifact of artifacts) {
      if (!isArtifactPathForSession(artifact.relativePath, input.sessionId)) {
        throw new SessionBundleExportError(
          'path_escape',
          `Artifact path does not belong to session ${input.sessionId}: ${artifact.relativePath}`,
        );
      }
      const relativePath = `artifacts/${artifact.relativePath}`;
      await assertRegularFile(resolve(stateRoot, relativePath), relativePath);
      entries.push({ relativePath, kind: 'file', source: 'copy' });
    }
    includedEntries.push('artifacts');
  }
  const allowed = new Set<string>([...SESSION_BUNDLE_STATE_ENTRIES]);
  const excludedEntries = (await readdir(stateRoot)).filter((entry) => !allowed.has(entry)).sort();
  return {
    stateRoot,
    configRoot,
    destinationRoot,
    sessionId: input.sessionId,
    includedEntries,
    excludedEntries,
    entries,
  };
}

export async function exportSessionBundleState(
  input: SessionBundleExportInput,
): Promise<SessionBundleExportPlan> {
  return withArtifactWriterLock(input.stateRoot, async (stateRoot) => {
    const plan = await planSessionBundleExport({ ...input, stateRoot });
    await assertDestinationMissing(plan.destinationRoot);
    const stagingRoot = `${plan.destinationRoot}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(stagingRoot, { recursive: true });
      for (const entry of plan.entries) {
        const destination = resolveInside(stagingRoot, entry.relativePath);
        if (entry.kind === 'directory') {
          await mkdir(destination, { recursive: true });
          continue;
        }
        await mkdir(dirname(destination), { recursive: true });
        if (entry.source === 'copy') {
          await copyFile(resolveInside(plan.stateRoot, entry.relativePath), destination);
        } else {
          await exportFilteredDatabase(plan.stateRoot, destination, plan.sessionId);
        }
      }
      await mkdir(dirname(plan.destinationRoot), { recursive: true });
      await rename(stagingRoot, plan.destinationRoot);
      return plan;
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });
}

async function exportFilteredDatabase(
  stateRoot: string,
  destinationPath: string,
  sessionId: string,
): Promise<void> {
  const lease = acquireOperationalStateDatabase(stateRoot);
  try {
    await lease.backup(destinationPath);
  } finally {
    lease.close();
  }
  const database = new DatabaseSync(destinationPath);
  try {
    database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name?: unknown }>;
    for (const row of tables) {
      if (typeof row.name !== 'string' || PORTABLE_GLOBAL_TABLES.has(row.name)) continue;
      const columns = database
        .prepare(`PRAGMA table_info(${quoteIdentifier(row.name)})`)
        .all() as Array<{ name?: unknown }>;
      const names = new Set(
        columns
          .map((column) => column.name)
          .filter((name): name is string => typeof name === 'string'),
      );
      const sessionColumns = ['session_id', 'source_session_id', 'target_session_id'].filter(
        (name) => names.has(name),
      );
      if (sessionColumns.length > 0) {
        const predicate = sessionColumns
          .map((name) => `${quoteIdentifier(name)} <> ?`)
          .join(' OR ');
        database
          .prepare(`DELETE FROM ${quoteIdentifier(row.name)} WHERE ${predicate}`)
          .run(...sessionColumns.map(() => sessionId));
      } else if (!PORTABLE_DERIVED_TABLES.has(row.name)) {
        database.exec(`DELETE FROM ${quoteIdentifier(row.name)}`);
      }
    }
    database
      .prepare(`
      DELETE FROM tool_journal_events
      WHERE NOT EXISTS (
        SELECT 1 FROM runtime_events
        WHERE runtime_events.invocation_id = tool_journal_events.invocation_id
      )
    `)
      .run();
    database
      .prepare(`
      DELETE FROM runtime_partial_segments
      WHERE NOT EXISTS (
        SELECT 1 FROM runtime_partial_snapshots
        WHERE runtime_partial_snapshots.stream_key = runtime_partial_segments.stream_key
      )
    `)
      .run();
    database
      .prepare(`
      DELETE FROM tool_operations
      WHERE NOT EXISTS (
        SELECT 1 FROM runtime_events
        WHERE runtime_events.invocation_id = tool_operations.invocation_id
      )
    `)
      .run();
    database
      .prepare(`
      DELETE FROM core_interaction_outcomes
      WHERE NOT EXISTS (
        SELECT 1 FROM core_interaction_requests
        WHERE core_interaction_requests.request_id = core_interaction_outcomes.request_id
      )
    `)
      .run();
    database
      .prepare(`
      DELETE FROM core_message_host_epochs
      WHERE NOT EXISTS (
        SELECT 1 FROM core_message_receipts
        WHERE core_message_receipts.host_epoch = core_message_host_epochs.host_epoch
      )
    `)
      .run();
    database.exec('COMMIT');
    const foreignKeyViolation = database.prepare('PRAGMA foreign_key_check').get();
    if (foreignKeyViolation) throw new Error('Filtered session database has dangling references');
    const session = database
      .prepare('SELECT 1 AS present FROM session_metadata WHERE session_id = ?')
      .get(sessionId);
    if (!session) throw new Error(`Filtered session is missing: ${sessionId}`);
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    database.close();
  }
}

const PORTABLE_GLOBAL_TABLES = new Set([
  'operational_schema_migrations',
  'session_metadata_schema',
  'runtime_capabilities',
  'session_catalog_state',
]);

const PORTABLE_DERIVED_TABLES = new Set([
  'tool_journal_events',
  'tool_operations',
  'runtime_partial_segments',
  'core_interaction_outcomes',
  'core_message_host_epochs',
]);

export function isArtifactPathForSession(relativePath: string, sessionId: string): boolean {
  const parts = relativePath.split(/[\\/]+/);
  return (
    parts.length >= 2 &&
    parts[0] === sessionId &&
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

async function canonicalRoot(path: string, role: string, allowMissing = false): Promise<string> {
  const requested = resolve(path);
  try {
    const metadata = await lstat(requested);
    if (metadata.isSymbolicLink()) {
      throw new SessionBundleExportError('symlink', `${role} root cannot be a symlink`);
    }
    if (!metadata.isDirectory()) {
      throw new SessionBundleExportError('invalid_root', `${role} root is not a directory`);
    }
    return realpath(requested);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return requested;
    if (error instanceof SessionBundleExportError) throw error;
    throw new SessionBundleExportError('invalid_root', `${role} root does not exist`, {
      cause: error,
    });
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path).catch((error) => {
    throw new SessionBundleExportError('invalid_root', `Missing ${label}`, { cause: error });
  });
  if (metadata.isSymbolicLink()) {
    throw new SessionBundleExportError('symlink', `${label} cannot be a symlink`);
  }
  if (!metadata.isFile()) {
    throw new SessionBundleExportError('unsupported_entry', `${label} is not a regular file`);
  }
}

async function assertDestinationMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new SessionBundleExportError(
    'destination_not_empty',
    `Session bundle destination already exists: ${path}`,
  );
}

function resolveInside(root: string, path: string): string {
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SessionBundleExportError('path_escape', `Path escapes bundle root: ${path}`);
  }
  return candidate;
}

function assertRootsSeparate(left: string, right: string, allowSame: boolean): void {
  if (left === right) {
    if (allowSame) return;
    throw new SessionBundleExportError('overlapping_roots', 'Session bundle roots overlap');
  }
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  if (
    (!leftToRight.startsWith('..') && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith('..') && !isAbsolute(rightToLeft))
  ) {
    throw new SessionBundleExportError('overlapping_roots', 'Session bundle roots overlap');
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw new SessionBundleExportError('invalid_root', `Invalid session id: ${sessionId}`);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
