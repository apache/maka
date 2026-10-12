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

import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContextOffloadStore } from '@maka/core/context-offload';
import { SUBAGENT_WORKTREE_DIRECTORY } from './git-worktree-child-executor.js';
import { LONG_TERM_MEMORY_DATABASE_NAME } from './long-term-memory-store.js';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import {
  CONTEXT_OFFLOAD_DATABASE_NAME,
  CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME,
} from './sqlite-context-offload-store.js';
import { sqliteDatabaseSidecars } from './sqlite-file-set.js';

/**
 * State Root parts whose size is cheap to learn. Nothing here scans the rows of
 * the operational database: a full-table payload sum reads every leaf page and
 * blocks the Host for as long as that takes.
 */
export type StorageFootprintKind = 'database' | 'artifacts' | 'context_offload' | 'memory';

export interface StorageFootprintTotal {
  readonly kind: StorageFootprintKind;
  readonly bytes: number;
  /** False when the figure comes from recorded metadata rather than the files on disk. */
  readonly exact: boolean;
}

export interface StorageFootprint {
  readonly totals: readonly StorageFootprintTotal[];
  /** Free pages in runtime.sqlite that a future VACUUM could return to the OS. */
  readonly reclaimableBytes: number;
  /** Live Subagent worktrees; counted, never walked, because a checkout can be huge. */
  readonly worktreeCount: number;
}

export interface SessionStorageFootprint {
  readonly sessionId: string;
  readonly bytes: {
    /** Logical message bytes as stored in rows; excludes page and index overhead. */
    readonly transcript: number;
    /** Logical runtime event bytes as stored in rows. */
    readonly runtime: number;
    /** Artifact sizes recorded in their metadata. */
    readonly artifacts: number;
    /**
     * Logical context-offload bytes referenced by this Session. Blobs are
     * deduplicated across Sessions, so this can exceed what deleting it frees.
     * Absent when the context-offload Store is unavailable.
     */
    readonly context?: number;
  };
  /** Worktrees bound to this Session or to its direct Subagent children. */
  readonly worktreeCount: number;
}

export interface StorageFootprintReader {
  measure(): Promise<StorageFootprint>;
  /**
   * Measures the Sessions that exist, in input order; unknown ids are omitted.
   * Each Session is measured by its own statements, so the cost of one request
   * is bounded by the caller's list (the Host protocol admits 25).
   */
  measureSessions(sessionIds: readonly string[]): Promise<readonly SessionStorageFootprint[]>;
  close(): void;
}

export interface OpenStorageFootprintReaderOptions {
  readonly contextOffload?: Pick<ContextOffloadStore, 'usage'>;
}

/**
 * Per-Session payload sums. Each statement covers one Session through an index
 * that leads with `session_id`, so its cost grows with that Session's rows
 * rather than with the table. `octet_length` on TEXT and `length` on BLOB skip
 * the overflow pages of large values, but every matching row is still read.
 */
const TRANSCRIPT_SOURCES = [
  { table: 'session_messages', bytes: 'octet_length(record_json)' },
  { table: 'session_message_chunks', bytes: 'length(data)' },
] as const;

const RUNTIME_SOURCES = [
  { table: 'runtime_events', bytes: 'octet_length(payload_json)' },
  {
    table: 'runtime_partial_snapshots',
    bytes: 'octet_length(payload_json) + octet_length(text_content)',
  },
  { table: 'core_agent_run_events', bytes: 'octet_length(record_json)' },
] as const;

const ARTIFACT_SOURCE = {
  table: 'artifact_records',
  bytes: "COALESCE(json_extract(record_json, '$.sizeBytes'), 0)",
} as const;
const HAS_WORKTREE = "json_extract(payload_json, '$.subagentWorkspace') IS NOT NULL";

/**
 * Opens a read-only footprint reader over one State Root. It shares the
 * process-local runtime.sqlite connection and adds no triggers or counters, so
 * the write path pays nothing for it (#5038). Every statement runs on its own
 * and the reader yields to the event loop after it, so no read transaction is
 * held and the Host keeps serving between statements.
 */
export function openStorageFootprintReader(
  root: string,
  options: OpenStorageFootprintReaderOptions = {},
): StorageFootprintReader {
  const lease = acquireOperationalStateDatabase(root, { schemaMigration: 'require_current' });
  return new SqliteStorageFootprintReader(root, lease, options.contextOffload);
}

class SqliteStorageFootprintReader implements StorageFootprintReader {
  #closed = false;

  constructor(
    private readonly root: string,
    private readonly lease: OperationalStateDatabaseLease,
    private readonly contextOffload: Pick<ContextOffloadStore, 'usage'> | undefined,
  ) {}

  async measure(): Promise<StorageFootprint> {
    this.#assertOpen();
    const databaseBytes = await fileSetBytes(join(this.root, OPERATIONAL_STATE_DATABASE_NAME));
    const reclaimableBytes = this.#readReclaimableBytes();
    await yieldToEventLoop();
    // One small metadata row per artifact file, so the whole table stays cheap.
    const artifacts = this.#readAllArtifactBytes();
    await yieldToEventLoop();
    // Inline blobs live inside the SQLite file set, so only the managed value
    // files outside it are added; the Store's physical-byte counter covers both.
    const contextBytes =
      (await fileSetBytes(join(this.root, CONTEXT_OFFLOAD_DATABASE_NAME))) +
      (await directoryBytes(join(this.root, CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME)));
    const memoryBytes = await fileSetBytes(join(this.root, LONG_TERM_MEMORY_DATABASE_NAME));
    const worktreeCount = await countDirectories(join(this.root, SUBAGENT_WORKTREE_DIRECTORY));
    const totals: StorageFootprintTotal[] = [
      { kind: 'database', bytes: databaseBytes, exact: true },
      { kind: 'artifacts', bytes: artifacts, exact: false },
      { kind: 'context_offload', bytes: contextBytes, exact: true },
      { kind: 'memory', bytes: memoryBytes, exact: true },
    ];
    return { totals, reclaimableBytes, worktreeCount };
  }

  async measureSessions(
    sessionIds: readonly string[],
  ): Promise<readonly SessionStorageFootprint[]> {
    this.#assertOpen();
    const results: SessionStorageFootprint[] = [];
    // One Session per statement, with a yield after each: a large task's sum
    // is still a long range scan, and the Host serves other work between them.
    for (const sessionId of new Set(sessionIds)) {
      if (!(await this.#sessionExists(sessionId))) continue;
      const transcript = await this.#sumForSession(TRANSCRIPT_SOURCES, sessionId);
      const runtime = await this.#sumForSession(RUNTIME_SOURCES, sessionId);
      const artifacts = await this.#sumForSession([ARTIFACT_SOURCE], sessionId);
      const worktreeCount = await this.#countWorktrees(sessionId);
      const context = this.contextOffload
        ? (await this.contextOffload.usage(sessionId)).logicalBytes
        : undefined;
      results.push({
        sessionId,
        bytes: {
          transcript,
          runtime,
          artifacts,
          ...(context === undefined ? {} : { context }),
        },
        worktreeCount,
      });
    }
    return results;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.lease.close();
  }

  async #sessionExists(sessionId: string): Promise<boolean> {
    const row = this.lease.database
      .prepare('SELECT 1 AS present FROM session_metadata WHERE session_id = ?')
      .get(sessionId);
    await yieldToEventLoop();
    return row !== undefined;
  }

  async #sumForSession(sources: readonly SqlByteSource[], sessionId: string): Promise<number> {
    let total = 0;
    for (const source of sources) {
      const row = this.lease.database
        .prepare(
          `SELECT COALESCE(SUM(${source.bytes}), 0) AS bytes
           FROM ${source.table}
           WHERE session_id = ?`,
        )
        .get(sessionId) as { bytes: number | bigint };
      total += toSafeCount(row.bytes);
      await yieldToEventLoop();
    }
    return total;
  }

  async #countWorktrees(sessionId: string): Promise<number> {
    const row = this.lease.database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM session_metadata
            WHERE session_id = ? AND ${HAS_WORKTREE})
           + (SELECT COUNT(*) FROM session_metadata
              WHERE subagent_parent_session_id = ? AND ${HAS_WORKTREE}) AS count`,
      )
      .get(sessionId, sessionId) as { count: number | bigint };
    await yieldToEventLoop();
    return toSafeCount(row.count);
  }

  #readAllArtifactBytes(): number {
    const row = this.lease.database
      .prepare(
        `SELECT COALESCE(SUM(${ARTIFACT_SOURCE.bytes}), 0) AS bytes FROM ${ARTIFACT_SOURCE.table}`,
      )
      .get() as { bytes: number | bigint };
    return toSafeCount(row.bytes);
  }

  #readReclaimableBytes(): number {
    const pageSize = this.lease.database.prepare('PRAGMA page_size').get() as {
      page_size: number | bigint;
    };
    const freelist = this.lease.database.prepare('PRAGMA freelist_count').get() as {
      freelist_count: number | bigint;
    };
    return toSafeCount(freelist.freelist_count) * toSafeCount(pageSize.page_size);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Storage footprint reader is closed');
  }
}

interface SqlByteSource {
  readonly table: string;
  readonly bytes: string;
}

async function fileSetBytes(databasePath: string): Promise<number> {
  let total = 0;
  for (const path of [databasePath, ...sqliteDatabaseSidecars(databasePath)]) {
    try {
      total += (await stat(path)).size;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return total;
}

/** Files under the managed context value tree (`sha256/<xx>/<blob>`), stat'ed asynchronously. */
async function directoryBytes(path: string, depth = 0): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory() && depth < 3) {
      total += await directoryBytes(child, depth + 1);
    } else if (entry.isFile()) {
      try {
        total += (await stat(child)).size;
      } catch (error) {
        // A value file deleted mid-walk simply no longer counts.
        if (!isMissingFile(error)) throw error;
      }
    }
  }
  return total;
}

async function countDirectories(path: string): Promise<number> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
}

function toSafeCount(value: number | bigint): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Storage footprint measurement is out of range');
  }
  return count;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
