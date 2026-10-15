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

import { stat, statfs } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import {
  acquireOperationalStateDatabase,
  assertOperationalStateDatabaseClosed,
  resolveOperationalStateDatabasePath,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import { COLD_STORAGE_AGE_MS } from './cold-storage-schema.js';
import {
  RUNTIME_COMPRESSION_POLICY,
  RUNTIME_COMPRESSIBLE_KINDS,
  RUNTIME_PAYLOAD_MAX_BYTES,
  RUNTIME_PAYLOAD_PREFIX,
  runtimePayloadBytesSql,
} from './runtime-payload-codec.js';
import {
  assertStorageRootLeaseActive,
  assertStorageRootLease,
  runWithStorageRootLease,
  type StorageRootLease,
} from './root-authority.js';
import { createSqliteRuntimeStore } from './sqlite-runtime-store.js';
import type {
  RuntimeTranscriptQueries,
  RuntimeTranscriptTurnsRequest,
  RuntimeTranscriptTurn,
} from './runtime-transcript-query.js';

const BATCH_BYTES = 1024 * 1024;
const MAX_RECLAIM_PAGES = 64;

export type RuntimeAutoVacuumMode = 0 | 1 | 2;

export interface RuntimePageReclaimResult {
  reclaimedPages: number;
  hasMore: boolean;
  busy: boolean;
  autoVacuumMode?: RuntimeAutoVacuumMode;
  pauseReason?: 'inactive' | 'conversion_required' | 'low_space' | 'wal_limit';
}

/** Read-only worker adapter; the composing Host retains its root owner until the worker exits. */
export function openColdRuntimeTranscriptStore(databasePath: string): RuntimeTranscriptQueries & {
  close(): void;
  projectTranscriptTurns<T>(
    sessionId: string,
    request: RuntimeTranscriptTurnsRequest,
    project: (turn: RuntimeTranscriptTurn) => T,
  ): Promise<T[]>;
  listSessionsWithRuntimeEventText(
    sessionIds: readonly string[],
    terms: readonly string[],
  ): Promise<string[]>;
} {
  return createSqliteRuntimeStore(databasePath, { readOnly: true });
}

export type RuntimeStorageCodec = (
  mode: 'encode' | 'decode',
  values: readonly string[],
) => Promise<readonly { json: string | null; error?: string }[]>;

interface Candidate {
  event_id: string;
  session_id: string;
  bytes: number;
  last_content_write_at: number;
  activity_version: number;
  payload_json: string;
  checked_policy?: string | null;
}

export interface ColdStorageBatchResult {
  scanned: number;
  changed: number;
  rawBytes: number;
  storedBytes: number;
  inputBytes: number;
  skipped: number;
  failures: number;
  busy: boolean;
  hasMore: boolean;
  pauseReason?: 'inactive' | 'writer_disabled' | 'low_space' | 'wal_limit';
}

export interface ColdRuntimeStorageInput {
  lease: StorageRootLease<'interactive', 'write'>;
  codec: RuntimeStorageCodec;
  canRun: () => boolean;
  isProtected: (sessionId: string) => boolean;
  now?: () => number;
  minimumFreeBytes?: number;
  maximumWalBytes?: number;
}

/** One lane of optional physical work; the caller retains root ownership and supplies its worker. */
export class ColdRuntimeStorage {
  readonly #lease: OperationalStateDatabaseLease;
  #closed = false;
  #draining = false;
  #running = false;
  #cursor: [number, string, string] = [-1, '', ''];
  #mode: 'encode' | 'decode' = 'encode';

  static open(input: ColdRuntimeStorageInput): Promise<ColdRuntimeStorage> {
    return runWithStorageRootLease(
      input.lease,
      'interactive',
      'write',
      async () => new ColdRuntimeStorage(input),
    );
  }

  private constructor(private readonly input: ColdRuntimeStorageInput) {
    assertStorageRootLeaseActive(input.lease, 'interactive', 'write');
    this.#lease = acquireOperationalStateDatabase(input.lease.canonicalPath);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await runWithStorageRootLease(this.input.lease, 'interactive', 'write', async () => {
      if (this.#closed) throw new Error('Cold storage is closed');
      this.#lease.transaction('write', () =>
        this.#lease.database
          .prepare(`
        UPDATE runtime_storage_policy SET writer_enabled = ?, epoch = epoch + 1 WHERE singleton = 1
      `)
          .run(enabled ? 1 : 0),
      );
      this.#cursor = [-1, '', ''];
    });
  }

  beginDrain(): void {
    this.#draining = true;
  }

  close(): void {
    this.beginDrain();
    this.#closed = true;
    this.#lease.close();
  }

  async compressBatch(
    options: { maxItems?: number; maxBytes?: number } = {},
  ): Promise<ColdStorageBatchResult> {
    return runWithStorageRootLease(this.input.lease, 'interactive', 'write', () =>
      this.#batch('encode', options),
    );
  }

  /** Recovery is explicit maintenance, never a side effect of reading. It first stops this writer. */
  async restoreBatch(
    options: { maxItems?: number; maxBytes?: number } = {},
  ): Promise<ColdStorageBatchResult> {
    return runWithStorageRootLease(this.input.lease, 'interactive', 'write', async () => {
      if (this.#policy().writer_enabled === 1) await this.setEnabled(false);
      return this.#batch('decode', options);
    });
  }

  /** Reclaims only already-free pages. Cooling applies to content compression, not these pages. */
  async reclaimFreePages(input: { readonly maxPages: number }): Promise<RuntimePageReclaimResult> {
    if (!Number.isSafeInteger(input.maxPages) || input.maxPages < 1)
      throw new Error('Invalid runtime page reclamation limit');
    const maxPages = Math.min(input.maxPages, MAX_RECLAIM_PAGES);
    return runWithStorageRootLease(this.input.lease, 'interactive', 'write', async () => {
      const result: RuntimePageReclaimResult = {
        reclaimedPages: 0,
        hasMore: false,
        busy: false,
      };
      if (!this.#allowed()) return { ...result, pauseReason: 'inactive' };
      if (this.#running) return { ...result, busy: true };
      const db = this.#lease.database;
      result.autoVacuumMode = readAutoVacuumMode(db);
      if (result.autoVacuumMode === 0) return { ...result, pauseReason: 'conversion_required' };
      if (result.autoVacuumMode !== 2 || readFreePages(db) === 0) return result;
      this.#running = true;
      try {
        const space = await statfs(this.input.lease.canonicalPath);
        const wal = await stat(`${this.#lease.databasePath}-wal`).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          },
        );
        if (space.bavail * space.bsize < (this.input.minimumFreeBytes ?? 64 * 1024 * 1024))
          return { ...result, pauseReason: 'low_space' };
        if ((wal?.size ?? 0) > (this.input.maximumWalBytes ?? 64 * 1024 * 1024))
          return { ...result, pauseReason: 'wal_limit' };
        if (!this.#allowed()) return { ...result, pauseReason: 'inactive' };
        const reclaimed = this.#lease.tryMaintenanceWrite(() => {
          if (!this.#allowed() || readAutoVacuumMode(db) !== 2) return result;
          const before = readFreePages(db);
          // Never pass zero: SQLite interprets it as reclaiming the entire freelist.
          if (before === 0) return result;
          db.exec(`PRAGMA incremental_vacuum(${Math.min(maxPages, before)})`);
          const after = readFreePages(db);
          return {
            ...result,
            reclaimedPages: before - after,
            hasMore: after > 0 && after < before,
          };
        });
        if (reclaimed === null) return { ...result, busy: true };
        // PASSIVE does not wait on readers. Actual DB/WAL files are measured separately.
        if (reclaimed.value.reclaimedPages > 0) db.exec('PRAGMA wal_checkpoint(PASSIVE)');
        return reclaimed.value;
      } finally {
        this.#running = false;
      }
    });
  }

  async inspect(): Promise<{
    encodedRecords: number;
    logicalBytes: number;
    physicalPayloadBytes: number;
    pageBytes: number;
    freePageBytes: number;
    databaseBytes: number;
    walBytes: number;
    allocatedDatabaseBytes: number;
    allocatedWalBytes: number;
    writerEnabled: boolean;
    autoVacuumMode: RuntimeAutoVacuumMode;
  }> {
    await assertStorageRootLease(this.input.lease, 'interactive', 'write');
    const db = this.#lease.database;
    const records = db
      .prepare(`SELECT count(*) AS records,
      coalesce(sum(${runtimePayloadBytesSql('payload_json')}), 0) AS raw_bytes,
      coalesce(sum(length(CAST(payload_json AS BLOB))), 0) AS stored_bytes
      FROM runtime_events WHERE substr(payload_json, 1, ?) = ?
    `)
      .get(RUNTIME_PAYLOAD_PREFIX.length, RUNTIME_PAYLOAD_PREFIX) as {
      records: number;
      raw_bytes: number;
      stored_bytes: number;
    };
    const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    const free = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number })
      .freelist_count;
    const database = await stat(this.#lease.databasePath);
    const wal = await stat(`${this.#lease.databasePath}-wal`).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      },
    );
    return {
      encodedRecords: records.records,
      logicalBytes: records.raw_bytes,
      physicalPayloadBytes: records.stored_bytes,
      pageBytes: pageSize * pageCount,
      freePageBytes: pageSize * free,
      databaseBytes: database.size,
      walBytes: wal?.size ?? 0,
      allocatedDatabaseBytes: database.blocks * 512,
      allocatedWalBytes: (wal?.blocks ?? 0) * 512,
      writerEnabled: this.#policy().writer_enabled === 1,
      autoVacuumMode: readAutoVacuumMode(db),
    };
  }

  #policy(): { writer_enabled: number; epoch: number } {
    return this.#lease.database
      .prepare('SELECT writer_enabled, epoch FROM runtime_storage_policy WHERE singleton = 1')
      .get() as { writer_enabled: number; epoch: number };
  }

  #allowed(): boolean {
    return !this.#closed && !this.#draining && this.input.canRun();
  }

  async #batch(
    mode: 'encode' | 'decode',
    options: { maxItems?: number; maxBytes?: number },
  ): Promise<ColdStorageBatchResult> {
    const result: ColdStorageBatchResult = {
      scanned: 0,
      changed: 0,
      rawBytes: 0,
      storedBytes: 0,
      inputBytes: 0,
      skipped: 0,
      failures: 0,
      busy: false,
      hasMore: false,
    };
    if (this.#running) return { ...result, busy: true, hasMore: true };
    if (!this.#allowed()) return { ...result, pauseReason: 'inactive' };
    if (this.#mode !== mode) {
      this.#mode = mode;
      this.#cursor = [-1, '', ''];
    }
    const maxItems = Math.min(16, options.maxItems ?? 16);
    const maxBytes = Math.min(RUNTIME_PAYLOAD_MAX_BYTES, options.maxBytes ?? BATCH_BYTES);
    if (
      !Number.isSafeInteger(maxItems) ||
      maxItems < 1 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    )
      throw new Error('Invalid cold storage batch budget');
    const policy = this.#policy();
    if (mode === 'encode' && policy.writer_enabled !== 1)
      return { ...result, pauseReason: 'writer_disabled' };
    const cursorBefore = [...this.#cursor] as [number, string, string];
    this.#running = true;
    try {
      const space = await statfs(this.input.lease.canonicalPath);
      const wal = await stat(`${this.#lease.databasePath}-wal`).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        },
      );
      if (space.bavail * space.bsize < (this.input.minimumFreeBytes ?? 64 * 1024 * 1024))
        return { ...result, pauseReason: 'low_space' };
      if ((wal?.size ?? 0) > (this.input.maximumWalBytes ?? 64 * 1024 * 1024))
        return { ...result, pauseReason: 'wal_limit' };
      if (!this.#allowed()) return { ...result, pauseReason: 'inactive' };
      const now = this.input.now ?? Date.now;
      const candidates = this.#lease.transaction('read', () => {
        const prefix = `substr(e.payload_json, 1, ${RUNTIME_PAYLOAD_PREFIX.length})`;
        const clause =
          mode === 'encode'
            ? `e.event_kind IN (${RUNTIME_COMPRESSIBLE_KINDS.map((kind) => `'${kind}'`).join(', ')})
             AND ${prefix} <> '${RUNTIME_PAYLOAD_PREFIX}'
             AND length(CAST(e.payload_json AS BLOB)) BETWEEN 1024 AND ${RUNTIME_PAYLOAD_MAX_BYTES}`
            : `${prefix} = '${RUNTIME_PAYLOAD_PREFIX}'`;
        const index = mode === 'encode' ? 'runtime_cold_candidates' : 'runtime_encoded_candidates';
        const pastSession = this.#cursor[2] === '\uffff';
        const parameters =
          mode === 'encode'
            ? [now() - COLD_STORAGE_AGE_MS, this.#cursor[0], this.#cursor[1]]
            : [this.#cursor[0], this.#cursor[1]];
        // Seek the age index, then one Session's event index. A global join/order
        // would repeatedly inspect/sort the large payload corpus for each tiny batch.
        const session = this.#lease.database
          .prepare(`SELECT a.* FROM session_content_activity a
          WHERE ${mode === 'encode' ? 'a.last_content_write_at <= ? AND' : ''}
            (a.last_content_write_at, a.session_id) ${pastSession ? '>' : '>='} (?, ?)
            AND EXISTS (SELECT 1 FROM runtime_events e INDEXED BY ${index}
              WHERE e.session_id = a.session_id AND ${clause})
          ORDER BY a.last_content_write_at, a.session_id LIMIT 1
        `)
          .get(...parameters) as
          | Pick<Candidate, 'session_id' | 'last_content_write_at' | 'activity_version'>
          | undefined;
        if (!session) {
          this.#cursor = [-1, '', ''];
          return [];
        }
        const sameSession =
          session.session_id === this.#cursor[1] &&
          session.last_content_write_at === this.#cursor[0];
        if (this.input.isProtected(session.session_id)) {
          this.#cursor = [session.last_content_write_at, session.session_id, '\uffff'];
          result.skipped += 1;
          result.hasMore = true;
          return [];
        }
        const rows = this.#lease.database
          .prepare(`SELECT e.event_id, e.session_id,
          ${runtimePayloadBytesSql('e.payload_json')} AS bytes,
          c.policy AS checked_policy
          FROM runtime_events e INDEXED BY ${index}
          LEFT JOIN runtime_compression_checks c ON c.event_id = e.event_id
          WHERE e.session_id = ? AND e.event_id > ? AND ${clause}
          ORDER BY e.event_id LIMIT 64
        `)
          .iterate(session.session_id, sameSession ? this.#cursor[2] : '');
        const selected: Candidate[] = [];
        let bytes = 0;
        let visited = 0;
        result.hasMore = true;
        for (const stored of rows) {
          const row = {
            ...stored,
            ...session,
            event_id: String(stored.event_id),
            bytes: Number(stored.bytes),
          } as Omit<Candidate, 'payload_json'>;
          // One large record may exceed the soft batch budget. The scheduler charges
          // its actual bytes; the format/read limit remains the independent hard cap.
          if (selected.length === maxItems || (selected.length > 0 && bytes + row.bytes > maxBytes))
            break;
          result.scanned += 1;
          visited += 1;
          this.#cursor = [row.last_content_write_at, row.session_id, row.event_id];
          if (
            this.input.isProtected(row.session_id) ||
            (mode === 'encode' && row.checked_policy === RUNTIME_COMPRESSION_POLICY)
          ) {
            result.skipped += 1;
            continue;
          }
          if (
            !Number.isSafeInteger(row.bytes) ||
            row.bytes < 1 ||
            row.bytes > RUNTIME_PAYLOAD_MAX_BYTES
          )
            throw new Error('Invalid encoded RuntimeEvent byte budget');
          const record = this.#lease.database
            .prepare('SELECT payload_json FROM runtime_events WHERE event_id = ?')
            .get(row.event_id) as { payload_json: string };
          selected.push({ ...row, payload_json: record.payload_json });
          bytes += row.bytes;
          if (selected.length === maxItems || bytes >= maxBytes) break;
        }
        if (visited === 0)
          this.#cursor = [session.last_content_write_at, session.session_id, '\uffff'];
        return selected;
      });
      if (candidates.length === 0) return result;
      result.inputBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
      const prepared = await this.input.codec(
        mode,
        candidates.map((candidate) => candidate.payload_json),
      );
      if (prepared.length !== candidates.length)
        throw new Error('Storage worker returned an incomplete batch');
      for (const [index, candidate] of candidates.entries()) {
        const encoded = prepared[index]!;
        if (encoded.error) {
          result.failures += 1;
          continue;
        }
        // Space may have changed during computation; decoding can expand both DB and WAL.
        const remainingSpace = await statfs(this.input.lease.canonicalPath);
        if (
          remainingSpace.bavail * remainingSpace.bsize <
          (this.input.minimumFreeBytes ?? 64 * 1024 * 1024) + candidate.bytes * 3
        ) {
          result.hasMore = false;
          result.pauseReason = 'low_space';
          this.#cursor = cursorBefore;
          break;
        }
        if (!this.#allowed() || this.input.isProtected(candidate.session_id)) {
          result.skipped += 1;
          continue;
        }
        const published = this.#lease.tryMaintenanceWrite(() => {
          const current = this.#policy();
          if (current.epoch !== policy.epoch || current.writer_enabled !== policy.writer_enabled)
            return false;
          const row = this.#lease.database
            .prepare(`SELECT e.payload_json, a.last_content_write_at, a.activity_version
            FROM runtime_events e JOIN session_content_activity a ON a.session_id = e.session_id WHERE e.event_id = ?
          `)
            .get(candidate.event_id) as
            | Pick<Candidate, 'payload_json' | 'last_content_write_at' | 'activity_version'>
            | undefined;
          if (
            !row ||
            row.payload_json !== candidate.payload_json ||
            row.activity_version !== candidate.activity_version ||
            row.last_content_write_at !== candidate.last_content_write_at ||
            (mode === 'encode' && row.last_content_write_at > now() - COLD_STORAGE_AGE_MS) ||
            !this.#allowed() ||
            this.input.isProtected(candidate.session_id)
          )
            return false;
          if (encoded.json === null) {
            if (mode === 'decode')
              throw new Error('Storage worker did not restore RuntimeEvent bytes');
            this.#lease.database
              .prepare(`INSERT OR REPLACE INTO runtime_compression_checks
              (event_id, session_id, policy) VALUES (?, ?, ?)
            `)
              .run(candidate.event_id, candidate.session_id, RUNTIME_COMPRESSION_POLICY);
            return false;
          }
          return (
            this.#lease.database
              .prepare(
                'UPDATE runtime_events SET payload_json = ? WHERE event_id = ? AND payload_json = ?',
              )
              .run(encoded.json, candidate.event_id, candidate.payload_json).changes === 1
          );
        });
        if (published === null) {
          result.busy = true;
          result.hasMore = false;
          this.#cursor = cursorBefore;
          break;
        }
        if (published.value) {
          result.changed += 1;
          result.rawBytes += candidate.bytes;
          result.storedBytes += Buffer.byteLength(encoded.json!);
        } else result.skipped += 1;
      }
      return result;
    } finally {
      this.#running = false;
    }
  }
}

export { COLD_STORAGE_AGE_MS } from './cold-storage-schema.js';
export { encodeRuntimePayloadJson, decodeRuntimePayloadJson } from './runtime-payload-codec.js';
export { RUNTIME_PAYLOAD_MAX_BYTES } from './runtime-payload-codec.js';

function readAutoVacuumMode(db: OperationalStateDatabaseLease['database']): RuntimeAutoVacuumMode {
  const mode = db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum;
  if (mode !== 0 && mode !== 1 && mode !== 2) throw new Error('Invalid SQLite auto-vacuum mode');
  return mode;
}

function readFreePages(db: OperationalStateDatabaseLease['database']): number {
  const pages = db.prepare('PRAGMA freelist_count').get()?.freelist_count;
  if (typeof pages !== 'number' || !Number.isSafeInteger(pages) || pages < 0)
    throw new Error('Invalid SQLite freelist count');
  return pages;
}

/** Physical rewrite under the Root owner, with all process-local repositories closed. */
export async function reclaimColdRuntimeStorageSpace(
  lease: StorageRootLease<'interactive', 'write'>,
  options: {
    readonly enableIncrementalVacuum?: boolean;
    readonly signal?: AbortSignal;
    readonly onPhase?: (phase: 'rebuilding' | 'verifying') => void;
    readonly minimumFreeBytes?: number;
    readonly auxiliaryThreads?: number;
  } = {},
): Promise<{
  busy: boolean;
  autoVacuumModeBefore: RuntimeAutoVacuumMode;
  autoVacuumModeAfter: RuntimeAutoVacuumMode;
  convertedToIncremental: boolean;
  auxiliaryThreads: number;
  rebuildMs: number;
  verificationMs: number;
  databaseBytesBefore: number;
  databaseBytesAfter: number;
  allocatedBytesBefore: number;
  allocatedBytesAfter: number;
  filesystemAvailableBytesBefore: number;
  filesystemAvailableBytesAfter: number;
}> {
  return runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
    options.signal?.throwIfAborted();
    if (
      options.auxiliaryThreads !== undefined &&
      (!Number.isSafeInteger(options.auxiliaryThreads) ||
        options.auxiliaryThreads < 0 ||
        options.auxiliaryThreads > 8)
    )
      throw new Error('SQLite auxiliary threads must be between 0 and 8');
    assertOperationalStateDatabaseClosed(root);
    const databasePath = resolveOperationalStateDatabasePath(root);
    const before = await stat(databasePath);
    const space = await statfs(root);
    const validation = acquireOperationalStateDatabase(root, {
      schemaMigration: 'require_current',
    });
    let mode: RuntimeAutoVacuumMode;
    try {
      mode = readAutoVacuumMode(validation.database);
    } finally {
      validation.close();
    }
    const needsRewrite = !options.enableIncrementalVacuum || mode === 0;
    if (
      needsRewrite &&
      space.bavail * space.bsize <
        Math.max(before.size * 2 + 64 * 1024 * 1024, options.minimumFreeBytes ?? 0)
    )
      throw Object.assign(new Error('Insufficient free disk space for SQLite VACUUM'), {
        code: 'insufficient_disk_space',
      });
    options.signal?.throwIfAborted();
    const work = await new Promise<{
      busy: boolean;
      autoVacuumModeBefore: RuntimeAutoVacuumMode;
      autoVacuumModeAfter: RuntimeAutoVacuumMode;
      auxiliaryThreads: number;
      rebuildMs: number;
      verificationMs: number;
    }>((resolve, reject) => {
      let result:
        | {
            busy: boolean;
            autoVacuumModeBefore: RuntimeAutoVacuumMode;
            autoVacuumModeAfter: RuntimeAutoVacuumMode;
            auxiliaryThreads: number;
            rebuildMs: number;
            verificationMs: number;
          }
        | undefined;
      let workerError: Error | undefined;
      const worker = new Worker(new URL('./cold-storage-vacuum-worker.js', import.meta.url), {
        workerData: {
          databasePath,
          enableIncrementalVacuum: options.enableIncrementalVacuum,
          auxiliaryThreads: options.auxiliaryThreads,
        },
      });
      const abort = () => {
        // Keep the Root operation alive until the native worker actually exits.
        // A process shutdown can force termination if native VACUUM has not yielded.
        void worker.terminate();
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      worker.on(
        'message',
        (
          message:
            | NonNullable<typeof result>
            | { phase: 'rebuilding' | 'verifying' }
            | { error: { message: string; code?: string; errcode?: number } },
        ) => {
          if ('phase' in message) options.onPhase?.(message.phase);
          else if ('error' in message)
            workerError = Object.assign(new Error(message.error.message), message.error);
          else result = message;
        },
      );
      worker.on('error', (error) => {
        workerError =
          error instanceof Error ? error : new Error('Storage worker failed', { cause: error });
      });
      worker.on('exit', (code) => {
        options.signal?.removeEventListener('abort', abort);
        if (options.signal?.aborted) reject(options.signal.reason);
        else if (workerError) reject(workerError);
        else if (code === 0 && result !== undefined) resolve(result);
        else reject(new Error(`Cold storage reclaim worker exited (${code})`));
      });
    });
    const after = await stat(databasePath);
    const remaining = await statfs(root);
    return {
      ...work,
      convertedToIncremental: work.autoVacuumModeBefore !== 2 && work.autoVacuumModeAfter === 2,
      databaseBytesBefore: before.size,
      databaseBytesAfter: after.size,
      allocatedBytesBefore: before.blocks * 512,
      allocatedBytesAfter: after.blocks * 512,
      filesystemAvailableBytesBefore: space.bavail * space.bsize,
      filesystemAvailableBytesAfter: remaining.bavail * remaining.bsize,
    };
  });
}
