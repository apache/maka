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

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { isCanonicalStorageRef } from '@maka/core/events';
import {
  discoverMarkedStorageRoot,
  runWithStorageRootLease,
  tryAcquireInteractiveRootOwner,
} from './root-authority.js';
import {
  migrateSqliteContextOffloadDatabase,
  SQLITE_CONTEXT_OFFLOAD_SCHEMA_VERSION,
} from './sqlite-context-offload-schema.js';
import {
  CONTEXT_OFFLOAD_DATABASE_NAME,
  CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
} from './sqlite-context-offload-store.js';
import { syncDirectoryChain, syncFile } from './stable-storage.js';
import { SQLITE_SESSION_MESSAGE_CHUNK_MARKER } from './sqlite-session-metadata-schema.js';

/**
 * Existing artifact-only snapshots keep their old admission contract. Context
 * snapshots require the root owner: a Session gate does not fence global GC.
 * The callback must recheck absence before publishing an artifact-only snapshot.
 */
export async function withOfflineContextSnapshot<T>(
  root: string,
  operation: (contextLocked: boolean) => Promise<T>,
  options: {
    /**
     * Take the authority even when the root has no context database yet.
     *
     * A reader only needs it when there is something to read, but a writer
     * that is about to CREATE the context store needs it too -- otherwise the
     * one case where it matters most, a fresh workspace, is the one case that
     * runs unprotected.
     */
    requireAuthority?: boolean;
  } = {},
): Promise<T> {
  if (
    options.requireAuthority !== true &&
    !(await exists(join(root, CONTEXT_OFFLOAD_DATABASE_NAME)))
  ) {
    return operation(false);
  }
  const capability = await discoverMarkedStorageRoot({ path: root });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner)
    throw new Error(
      'Context snapshot requires an offline Storage Root; stop the Runtime Host first',
    );
  try {
    return await runWithStorageRootLease(owner.lease, 'interactive', 'write', () =>
      operation(true),
    );
  } finally {
    await owner.close();
  }
}

/** Copies under the offline owner and the caller's Artifact lock; never mutates the source DB. */
export async function copyContextSnapshot(
  sourceRoot: string,
  targetRoot: string,
  contextLocked: boolean,
  sessionIds?: readonly string[],
): Promise<boolean> {
  const sourcePath = join(sourceRoot, CONTEXT_OFFLOAD_DATABASE_NAME);
  if (!(await exists(sourcePath))) return false;
  if (!contextLocked)
    throw new Error(
      'Context storage appeared during snapshot; retry with the Runtime Host stopped',
    );
  await assertRegularPath(sourceRoot, CONTEXT_OFFLOAD_DATABASE_NAME);
  const targetPath = join(targetRoot, CONTEXT_OFFLOAD_DATABASE_NAME);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, targetPath);
  } finally {
    source.close();
  }
  await chmod(targetPath, 0o600);
  const target = new DatabaseSync(targetPath);
  try {
    target.exec('PRAGMA foreign_keys = ON');
    migrateSqliteContextOffloadDatabase(target);
    target.exec('BEGIN IMMEDIATE');
    // A subagent child's context refs belong to the export as much as its
    // parent's do: the parent's tool call is why the child ran at all.
    if (sessionIds !== undefined) {
      const keep = sessionIds.map(() => '?').join(', ');
      target
        .prepare(`DELETE FROM context_refs WHERE session_id NOT IN (${keep})`)
        .run(...sessionIds);
    }
    target.exec(`
      DELETE FROM context_gc_candidates;
      DELETE FROM context_file_deletions;
      DELETE FROM context_blobs WHERE NOT EXISTS (
        SELECT 1 FROM context_refs WHERE context_refs.blob_id = context_blobs.blob_id
      );
      DELETE FROM context_session_usage;
      INSERT INTO context_session_usage
        SELECT r.session_id, count(*), sum(b.size_bytes)
        FROM context_refs r JOIN context_blobs b USING(blob_id) GROUP BY r.session_id;
      UPDATE context_store_usage SET
        blob_count = (SELECT count(*) FROM context_blobs),
        physical_bytes = (SELECT coalesce(sum(size_bytes), 0) FROM context_blobs)
      WHERE singleton = 1;
      COMMIT;
      PRAGMA journal_mode = DELETE;
      VACUUM;
    `);
    // VACUUM on the private destination removes other Sessions' deleted bytes,
    // including SQLite free pages. It is never run on the live source.
    for (const row of target
      .prepare(
        "SELECT blob_id, payload, size_bytes FROM context_blobs WHERE storage_kind = 'managed_file'",
      )
      .iterate()) {
      const path = managedPath(row.blob_id, row.payload);
      await assertRegularPath(sourceRoot, path);
      const destination = join(targetRoot, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(join(sourceRoot, path), destination);
      await chmod(destination, 0o600);
      await syncFile(destination);
      await syncDirectoryChain(dirname(destination), targetRoot);
    }
  } finally {
    target.close();
  }
  await syncFile(targetPath);
  await syncDirectoryChain(targetRoot, targetRoot);
  return true;
}

export async function planContextSnapshotFiles(
  root: string,
  sessionIds: readonly string[],
): Promise<string[]> {
  const path = join(root, CONTEXT_OFFLOAD_DATABASE_NAME);
  if (!(await exists(path))) return [];
  await assertRegularPath(root, CONTEXT_OFFLOAD_DATABASE_NAME);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
    if (![1, 2, SQLITE_CONTEXT_OFFLOAD_SCHEMA_VERSION].includes(version))
      throw new Error('Unsupported context snapshot schema');
    const files = [CONTEXT_OFFLOAD_DATABASE_NAME];
    if (version < 3) return files;
    for (const row of database
      .prepare(`SELECT DISTINCT b.blob_id, b.payload FROM context_refs r
      JOIN context_blobs b ON b.blob_id = r.blob_id
      WHERE r.session_id IN (${sessionIds.map(() => '?').join(', ')})
        AND b.storage_kind = 'managed_file' ORDER BY b.blob_id`)
      .iterate(...sessionIds)) {
      const file = managedPath(row.blob_id, row.payload);
      await assertRegularPath(root, file);
      files.push(file);
    }
    return files;
  } finally {
    database.close();
  }
}

/** Verifies both payload integrity and typed ledger/message references before publication. */
export async function validateContextSnapshot(root: string): Promise<void> {
  let context: DatabaseSync | undefined;
  const contextPath = join(root, CONTEXT_OFFLOAD_DATABASE_NAME);
  try {
    if (await exists(contextPath)) {
      await assertRegularPath(root, CONTEXT_OFFLOAD_DATABASE_NAME);
      context = new DatabaseSync(contextPath, { readOnly: true });
      if (
        context.prepare('PRAGMA user_version').get()?.user_version !==
        SQLITE_CONTEXT_OFFLOAD_SCHEMA_VERSION
      )
        throw new Error('Unsupported context snapshot schema');
      if (
        context.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
        context.prepare('PRAGMA foreign_key_check').get()
      )
        throw new Error('Invalid context snapshot database');
      for (const row of context
        .prepare('SELECT blob_id, storage_kind, payload, size_bytes FROM context_blobs')
        .iterate()) {
        const digest = blobHash(row.blob_id);
        if (!Number.isSafeInteger(row.size_bytes) || Number(row.size_bytes) < 0)
          throw new Error('Invalid context snapshot size');
        if (row.storage_kind === 'managed_file') {
          const path = managedPath(row.blob_id, row.payload);
          await assertRegularPath(root, path);
          const info = await lstat(join(root, path));
          if (info.size !== row.size_bytes || (await hashFile(join(root, path))) !== digest) {
            throw new Error('Context snapshot payload size/hash mismatch');
          }
        } else if (
          row.storage_kind !== 'inline' ||
          !(row.payload instanceof Uint8Array) ||
          row.payload.byteLength !== row.size_bytes ||
          createHash('sha256').update(row.payload).digest('hex') !== digest
        ) {
          throw new Error('Context snapshot inline payload size/hash mismatch');
        }
      }
      const actual = context
        .prepare('SELECT count(*) AS n, coalesce(sum(size_bytes), 0) AS bytes FROM context_blobs')
        .get()!;
      const usage = context
        .prepare('SELECT blob_count, physical_bytes FROM context_store_usage WHERE singleton = 1')
        .get();
      if (usage?.blob_count !== actual.n || usage.physical_bytes !== actual.bytes)
        throw new Error('Context snapshot usage mismatch');
      if (
        context
          .prepare(`SELECT 1 FROM (
        SELECT r.session_id, count(*) AS reference_count, sum(b.size_bytes) AS logical_bytes
        FROM context_refs r JOIN context_blobs b USING(blob_id) GROUP BY r.session_id
        EXCEPT SELECT session_id, reference_count, logical_bytes FROM context_session_usage
      ) LIMIT 1`)
          .get()
      )
        throw new Error('Context snapshot Session usage mismatch');
    }
    validateLedgerContextRefs(root, context);
  } finally {
    context?.close();
  }
}

function validateLedgerContextRefs(root: string, context: DatabaseSync | undefined): void {
  const runtime = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
  const find = context?.prepare('SELECT 1 FROM context_refs WHERE session_id = ? AND ref_id = ?');
  const check = (value: unknown, sessionId: string): void => {
    const ref = record(value);
    if (ref.kind !== 'session_context') return;
    if (
      !isCanonicalStorageRef(value) ||
      ref.sessionId !== sessionId ||
      !find?.get(sessionId, String(ref.refId))
    )
      throw new Error('Snapshot has a missing or cross-Session context reference');
  };
  const content = (value: unknown, sessionId: string): void => {
    const item = record(value);
    if (item.kind === 'image') check(item.ref, sessionId);
  };
  const attachments = (value: unknown, sessionId: string): void => {
    const item = record(value);
    if (Array.isArray(item.attachments)) {
      for (const attachment of item.attachments) check(record(attachment).ref, sessionId);
    }
  };
  const projection = (value: unknown, sessionId: string): void => {
    const item = record(value);
    if (item.kind === 'content' && Array.isArray(item.parts)) {
      for (const part of item.parts) {
        const entry = record(part);
        if (entry.kind === 'artifact') check(entry.ref, sessionId);
      }
    }
  };
  try {
    for (const row of runtime
      .prepare('SELECT session_id, payload_json FROM runtime_events')
      .iterate()) {
      const event = record(JSON.parse(String(row.payload_json)));
      const item = record(event.content);
      const sessionId = String(row.session_id);
      if (item.kind === 'text') attachments(item, sessionId);
      if (item.kind === 'function_response') {
        content(item.result, sessionId);
        projection(item.modelProjection, sessionId);
      }
    }
    for (const row of runtime
      .prepare(
        "SELECT session_id, record_json FROM core_agent_run_events WHERE event_type = 'model_projection_transition_recorded'",
      )
      .iterate()) {
      const event = record(JSON.parse(String(row.record_json)));
      projection(record(record(event.data).transition).replacement, String(row.session_id));
    }
    const chunks = runtime.prepare(
      'SELECT data FROM session_message_chunks WHERE session_id = ? AND sequence = ? ORDER BY chunk_index',
    );
    for (const row of runtime
      .prepare('SELECT session_id, sequence, record_json FROM session_messages')
      .iterate()) {
      const encoded =
        row.record_json === SQLITE_SESSION_MESSAGE_CHUNK_MARKER
          ? Buffer.concat(
              chunks.all(row.session_id!, row.sequence!).map((chunk) => {
                if (!(chunk.data instanceof Uint8Array))
                  throw new Error('Invalid snapshot message chunk');
                return Buffer.from(chunk.data);
              }),
            ).toString('utf8')
          : String(row.record_json);
      const message = record(JSON.parse(encoded));
      const sessionId = String(row.session_id);
      if (message.type === 'user') attachments(message, sessionId);
      if (message.type === 'tool_result') content(message.content, sessionId);
    }
  } finally {
    runtime.close();
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function blobHash(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32)
    throw new Error('Invalid context snapshot blob identity');
  return Buffer.from(value).toString('hex');
}

function managedPath(blobId: unknown, payload: unknown): string {
  const digest = blobHash(blobId);
  const expected = `sha256/${digest.slice(0, 2)}/${digest}`;
  if (!(payload instanceof Uint8Array) || !Buffer.from(payload).equals(Buffer.from(expected))) {
    throw new Error('Invalid context snapshot managed locator');
  }
  return `${CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME}/${expected}`;
}

async function assertRegularPath(root: string, relativePath: string): Promise<void> {
  const canonical = await realpath(root);
  const parts = relativePath.split('/');
  let path = canonical;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
    ) {
      throw new Error('Context snapshot path must not contain symlinks or special files');
    }
  }
  if ((await realpath(path)) !== resolve(canonical, relativePath))
    throw new Error('Context snapshot path escaped its root');
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
