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

import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireOperationalStateDatabase } from './operational-state-store.js';
import {
  reclaimColdRuntimeStorageSpace,
  type RuntimeAutoVacuumMode,
} from './cold-runtime-storage.js';
import { publishMarkerFile, readBoundedMarkerFile } from './marker-file.js';
import { runWithStorageRootLease, type StorageRootLease } from './root-authority.js';

const ATTEMPT_FILE = '.runtime-storage-upgrade.json';
const RETRY_DELAY_MS = 60 * 60 * 1000;

export type RuntimeStorageUpgradeResult =
  | { readonly kind: 'current'; readonly mode: 2 }
  | { readonly kind: 'converted'; readonly mode: 2 }
  | {
      readonly kind: 'deferred';
      readonly mode: RuntimeAutoVacuumMode;
      readonly reason: 'recent_attempt' | 'low_space' | 'busy' | 'failed';
    };

/** One startup-only physical upgrade. It does not change the Session content clock. */
export async function upgradeRuntimeStorageAtStartup(
  lease: StorageRootLease<'interactive', 'write'>,
  options: {
    readonly signal?: AbortSignal;
    readonly now?: () => number;
    readonly onPhase?: (phase: 'preparing' | 'rebuilding' | 'verifying' | undefined) => void;
    readonly minimumFreeBytes?: number;
  } = {},
): Promise<RuntimeStorageUpgradeResult> {
  return runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
    options.signal?.throwIfAborted();
    // Host remains the sole schema-migration authority. Close the initialization
    // connection before the worker opens the database for its physical rewrite.
    const initialization = acquireOperationalStateDatabase(root);
    let mode: RuntimeAutoVacuumMode;
    try {
      const value = initialization.database.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum;
      if (value !== 0 && value !== 1 && value !== 2)
        throw new Error('Invalid SQLite auto-vacuum mode');
      mode = value;
    } finally {
      initialization.close();
    }
    const marker = join(root, ATTEMPT_FILE);
    const pending = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (mode === 2 && !pending) {
      return { kind: 'current', mode };
    }
    const now = options.now?.() ?? Date.now();
    if (mode !== 2)
      try {
        const attempt: unknown = JSON.parse(
          await readBoundedMarkerFile({
            path: marker,
            maxBytes: 1024,
            invalidFile: () => new Error('Invalid runtime storage upgrade marker'),
          }),
        );
        if (
          typeof attempt === 'object' &&
          attempt !== null &&
          'rootId' in attempt &&
          attempt.rootId === lease.rootId &&
          'startedAt' in attempt &&
          typeof attempt.startedAt === 'number' &&
          Number.isSafeInteger(attempt.startedAt) &&
          attempt.startedAt >= 0 &&
          'status' in attempt &&
          attempt.status === 'failed' &&
          now - attempt.startedAt < RETRY_DELAY_MS
        )
          return { kind: 'deferred', mode, reason: 'recent_attempt' };
      } catch {
        // SQLite's mode is authoritative. A missing/damaged retry hint must
        // not prevent future attempts; publication still enforces safe access.
      }
    const publishAttempt = (status: 'running' | 'failed') =>
      publishMarkerFile({
        root,
        markerFile: ATTEMPT_FILE,
        contents: JSON.stringify({ rootId: lease.rootId, startedAt: now, status }),
        maxBytes: 1024,
        publication: 'replace',
        invalidFile: () => new Error('Invalid runtime storage upgrade marker'),
      });
    try {
      await publishAttempt('running');
    } catch {
      return { kind: 'deferred', mode, reason: 'failed' };
    }
    options.onPhase?.('preparing');
    try {
      const result = await reclaimColdRuntimeStorageSpace(lease, {
        enableIncrementalVacuum: true,
        signal: options.signal,
        onPhase: options.onPhase,
        minimumFreeBytes: options.minimumFreeBytes,
      });
      if (result.busy) {
        await publishAttempt('failed').catch(() => undefined);
        return { kind: 'deferred', mode: result.autoVacuumModeAfter, reason: 'busy' };
      }
      await unlink(marker);
      return { kind: 'converted', mode: 2 };
    } catch (error) {
      options.signal?.throwIfAborted();
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      const errcode = error instanceof Error && 'errcode' in error ? error.errcode : undefined;
      if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || errcode === 11 || errcode === 26)
        throw error;
      await publishAttempt('failed').catch(() => undefined);
      return {
        kind: 'deferred',
        mode,
        reason: code === 'insufficient_disk_space' ? 'low_space' : 'failed',
      };
    } finally {
      options.onPhase?.(undefined);
    }
  });
}
