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

import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import { runWithStorageRootLease, type StorageRootLease } from './root-authority.js';

export interface RuntimePageReclamation {
  reclaimFreePages(input: { readonly maxPages: number }): Promise<{
    readonly reclaimedPages: number;
    readonly hasMore: boolean;
  }>;
}

/** Uses the process-local operational owner; older NONE databases remain report-only. */
export function openRuntimePageReclamation(
  rootLease: StorageRootLease<'interactive', 'write'>,
): RuntimePageReclamation {
  return Object.freeze({
    reclaimFreePages: ({ maxPages }: { readonly maxPages: number }) => {
      if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
        throw new Error('Runtime page reclamation limit must be a positive safe integer');
      }
      return runWithStorageRootLease(rootLease, 'interactive', 'write', async (root) => {
        const databaseLease = acquireOperationalStateDatabase(root, {
          schemaMigration: 'require_current',
        });
        try {
          return reclaimFreePages(databaseLease, maxPages);
        } finally {
          databaseLease.close();
        }
      });
    },
  });
}

function reclaimFreePages(
  lease: OperationalStateDatabaseLease,
  maxPages: number,
): { readonly reclaimedPages: number; readonly hasMore: boolean } {
  // An idle tick and an older NONE database must never acquire a write lock.
  const eligible = lease.transaction('read', () => {
    const mode = readPragma(lease, 'auto_vacuum');
    if (mode !== 2) return false;
    return readPragma(lease, 'freelist_count') > 0;
  });
  if (!eligible) return { reclaimedPages: 0, hasMore: false };

  const result = lease.transaction('write', () => {
    const before = readPragma(lease, 'freelist_count');
    // incremental_vacuum(0) would reclaim every page, so stop if the list emptied.
    if (before === 0) return { reclaimedPages: 0, hasMore: false };
    lease.database.exec(`PRAGMA incremental_vacuum(${Math.min(maxPages, before)})`);
    const after = readPragma(lease, 'freelist_count');
    return { reclaimedPages: before - after, hasMore: after > 0 && after < before };
  });
  // PASSIVE does not wait for other readers; it runs after the write commits.
  if (result.reclaimedPages > 0) lease.database.exec('PRAGMA wal_checkpoint(PASSIVE)');
  return result;
}

function readPragma(lease: OperationalStateDatabaseLease, name: 'auto_vacuum' | 'freelist_count') {
  const row = lease.database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid SQLite ${name}`);
  }
  return value;
}
