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

import type { DatabaseSync } from 'node:sqlite';

export type SqliteAutoVacuumMode = 'none' | 'full' | 'incremental';

export interface SqlitePageReclamationResult {
  readonly reclaimedPages: number;
  readonly reclaimedBytes: number;
  readonly hasMore: boolean;
}

export function readSqlitePageSize(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA page_size').get() as { page_size?: unknown } | undefined;
  const pageSize = row?.page_size;
  if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error('Invalid SQLite page_size');
  }
  return pageSize;
}

export function readSqliteFreelistPages(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA freelist_count').get() as { freelist_count?: unknown } | undefined;
  const freelistCount = row?.freelist_count;
  if (
    typeof freelistCount !== 'number' ||
    !Number.isSafeInteger(freelistCount) ||
    freelistCount < 0
  ) {
    throw new Error('Invalid SQLite freelist_count');
  }
  return freelistCount;
}

export function readSqliteAutoVacuumMode(db: DatabaseSync): SqliteAutoVacuumMode {
  const row = db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: unknown } | undefined;
  if (row?.auto_vacuum === 2) return 'incremental';
  if (row?.auto_vacuum === 1) return 'full';
  return 'none';
}

export function runBoundedIncrementalVacuum(
  db: DatabaseSync,
  maxPages: number,
): SqlitePageReclamationResult {
  if (maxPages <= 0) {
    return { reclaimedPages: 0, reclaimedBytes: 0, hasMore: false };
  }
  if (readSqliteAutoVacuumMode(db) !== 'incremental') {
    return { reclaimedPages: 0, reclaimedBytes: 0, hasMore: false };
  }
  const before = readSqliteFreelistPages(db);
  if (before === 0) {
    return { reclaimedPages: 0, reclaimedBytes: 0, hasMore: false };
  }
  const pages = Math.min(maxPages, before);
  db.exec(`PRAGMA incremental_vacuum(${pages})`);
  const after = readSqliteFreelistPages(db);
  const pageSize = readSqlitePageSize(db);
  const reclaimedPages = Math.max(0, before - after);
  return {
    reclaimedPages,
    reclaimedBytes: reclaimedPages * pageSize,
    hasMore: after > 0,
  };
}

/** Best-effort checkpoint for open maintenance loops; never blocks on readers. */
export function runPassiveWalCheckpoint(db: DatabaseSync): void {
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
}
