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

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContextOffloadStore } from '@maka/core/context-offload';
import { LONG_TERM_MEMORY_DATABASE_NAME } from './long-term-memory-store.js';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

/**
 * Non-overlapping parts of the State Root footprint.
 *
 * `transcript`, `runtime` and `usage_history` are logical payload bytes stored
 * inside runtime.sqlite; `database` is what remains of that file set once they
 * are subtracted: other operational records, indexes, page overhead and free
 * pages. The parts therefore add up to the measured files without counting a
 * byte twice.
 */
export type StorageFootprintKind =
  | 'database'
  | 'transcript'
  | 'runtime'
  | 'usage_history'
  | 'artifacts'
  | 'context_offload'
  | 'memory';

export interface StorageFootprintTotal {
  readonly kind: StorageFootprintKind;
  readonly bytes: number;
  /** False when the figure is logical payload size rather than bytes on disk. */
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
    readonly transcript: number;
    readonly runtime: number;
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
  measureSessions(sessionIds: readonly string[]): Promise<readonly SessionStorageFootprint[]>;
  close(): void;
}

export interface OpenStorageFootprintReaderOptions {
  readonly contextOffload?: Pick<ContextOffloadStore, 'usage'>;
}

const SUBAGENT_WORKTREE_DIRECTORY = 'subagent-worktrees';
const SQLITE_SIDECAR_SUFFIXES = ['', '-wal', '-shm'] as const;
const SESSION_BATCH_SIZE = 100;

/**
 * Sums of logical payload bytes. `octet_length` on a TEXT column and `length`
 * on a BLOB column read the record header only, so none of these loads the
 * overflow pages that hold large payloads. Every table is scanned through an
 * existing `session_id`-leading index when a Session filter is present.
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

const USAGE_HISTORY_SOURCES = [
  { table: 'usage_llm_calls', bytes: 'octet_length(record_json)' },
  { table: 'usage_tool_invocations', bytes: 'octet_length(record_json)' },
  {
    table: 'usage_model_call_attempts',
    bytes: `octet_length(attempt_id) + COALESCE(octet_length(session_id), 0)
      + COALESCE(octet_length(logical_call_id), 0) + COALESCE(octet_length(turn_id), 0)
      + COALESCE(octet_length(connection_slug), 0) + COALESCE(octet_length(provider_id), 0)
      + COALESCE(octet_length(model_id), 0)`,
  },
] as const;

const ARTIFACT_BYTES = "COALESCE(json_extract(record_json, '$.sizeBytes'), 0)";
const HAS_WORKTREE = "json_extract(payload_json, '$.subagentWorkspace') IS NOT NULL";

/**
 * Opens a read-only footprint reader over one State Root. It shares the
 * process-local runtime.sqlite connection and adds no triggers or counters, so
 * the write path pays nothing for it (#5038). Measurements run one statement
 * at a time and yield between them rather than holding a read transaction, so
 * the totals are a close estimate, not a snapshot.
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
    const transcript = await this.#sumAll(TRANSCRIPT_SOURCES);
    const runtime = await this.#sumAll(RUNTIME_SOURCES);
    const usageHistory = await this.#sumAll(USAGE_HISTORY_SOURCES);
    const artifacts = await this.#sumAll([{ table: 'artifact_records', bytes: ARTIFACT_BYTES }]);
    const reclaimableBytes = this.#readReclaimableBytes();
    const memoryBytes = await fileSetBytes(join(this.root, LONG_TERM_MEMORY_DATABASE_NAME));
    const contextUsage = await this.contextOffload?.usage();
    const worktreeCount = await countDirectories(join(this.root, SUBAGENT_WORKTREE_DIRECTORY));
    const totals: StorageFootprintTotal[] = [
      {
        kind: 'database',
        bytes: Math.max(0, databaseBytes - transcript - runtime - usageHistory),
        exact: false,
      },
      { kind: 'transcript', bytes: transcript, exact: false },
      { kind: 'runtime', bytes: runtime, exact: false },
      { kind: 'usage_history', bytes: usageHistory, exact: false },
      { kind: 'artifacts', bytes: artifacts, exact: true },
      ...(contextUsage
        ? [{ kind: 'context_offload' as const, bytes: contextUsage.physicalBytes, exact: false }]
        : []),
      { kind: 'memory', bytes: memoryBytes, exact: true },
    ];
    return { totals, reclaimableBytes, worktreeCount };
  }

  async measureSessions(
    sessionIds: readonly string[],
  ): Promise<readonly SessionStorageFootprint[]> {
    this.#assertOpen();
    const unique = [...new Set(sessionIds)];
    const results: SessionStorageFootprint[] = [];
    for (let offset = 0; offset < unique.length; offset += SESSION_BATCH_SIZE) {
      const batch = unique.slice(offset, offset + SESSION_BATCH_SIZE);
      const transcript = this.#sumBySession(TRANSCRIPT_SOURCES, batch);
      const runtime = this.#sumBySession(RUNTIME_SOURCES, batch);
      const artifacts = this.#sumBySession(
        [{ table: 'artifact_records', bytes: ARTIFACT_BYTES }],
        batch,
      );
      const worktrees = this.#countWorktreesBySession(batch);
      for (const sessionId of batch) {
        const context = this.contextOffload
          ? (await this.contextOffload.usage(sessionId)).logicalBytes
          : undefined;
        results.push({
          sessionId,
          bytes: {
            transcript: transcript.get(sessionId) ?? 0,
            runtime: runtime.get(sessionId) ?? 0,
            artifacts: artifacts.get(sessionId) ?? 0,
            ...(context === undefined ? {} : { context }),
          },
          worktreeCount: worktrees.get(sessionId) ?? 0,
        });
      }
      await yieldToEventLoop();
    }
    return results;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.lease.close();
  }

  async #sumAll(sources: readonly SqlByteSource[]): Promise<number> {
    let total = 0;
    for (const source of sources) {
      const row = this.lease.database
        .prepare(`SELECT COALESCE(SUM(${source.bytes}), 0) AS bytes FROM ${source.table}`)
        .get() as { bytes: number | bigint };
      total += toSafeCount(row.bytes);
      await yieldToEventLoop();
    }
    return total;
  }

  #sumBySession(
    sources: readonly SqlByteSource[],
    sessionIds: readonly string[],
  ): Map<string, number> {
    const totals = new Map<string, number>();
    const placeholders = sessionIds.map(() => '?').join(', ');
    for (const source of sources) {
      const rows = this.lease.database
        .prepare(
          `SELECT session_id AS sessionId, COALESCE(SUM(${source.bytes}), 0) AS bytes
           FROM ${source.table}
           WHERE session_id IN (${placeholders})
           GROUP BY session_id`,
        )
        .all(...sessionIds) as Array<{ sessionId: string; bytes: number | bigint }>;
      for (const row of rows) {
        totals.set(row.sessionId, (totals.get(row.sessionId) ?? 0) + toSafeCount(row.bytes));
      }
    }
    return totals;
  }

  #countWorktreesBySession(sessionIds: readonly string[]): Map<string, number> {
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = this.lease.database
      .prepare(
        `SELECT owner AS sessionId, COUNT(*) AS count FROM (
           SELECT session_id AS owner FROM session_metadata
           WHERE session_id IN (${placeholders}) AND ${HAS_WORKTREE}
           UNION ALL
           SELECT subagent_parent_session_id AS owner FROM session_metadata
           WHERE subagent_parent_session_id IN (${placeholders}) AND ${HAS_WORKTREE}
         )
         GROUP BY owner`,
      )
      .all(...sessionIds, ...sessionIds) as Array<{ sessionId: string; count: number | bigint }>;
    return new Map(rows.map((row) => [row.sessionId, toSafeCount(row.count)]));
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
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try {
      total += (await stat(`${databasePath}${suffix}`)).size;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
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
