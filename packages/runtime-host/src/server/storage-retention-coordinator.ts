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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionSessionWriter } from '@maka/storage/execution-stores';
import {
  decodeStorageRetentionQueryResult,
  type StorageRetentionQueryResult,
  type StorageRetentionSweep,
  type StorageRetentionPolicy,
} from '../protocol/storage-retention.js';
import type { StorageRetentionOperationHandlerMap } from './operation-dispatcher.js';
import type { HostSessionRetirementCoordinator } from './session-retirement-coordinator.js';
import {
  HostStorageRetentionPolicy,
  RETENTION_DAY_MS,
  retentionDeadline,
  writeRetentionDocument,
} from './storage-retention-policy.js';

export class HostStorageRetentionCoordinator {
  readonly handlers: StorageRetentionOperationHandlerMap = {
    'storage.retention.query': async () => {
      if (this.#draining)
        return { ok: false, error: { code: 'host_draining', message: 'Host draining' } };
      try {
        const policy = this.#policy.snapshot();
        const preview = await this.#preview(policy);
        return {
          ok: true,
          result: { policy, preview, lastSweep: this.#lastSweep, lastDeletion: this.#lastDeletion },
        };
      } catch {
        return {
          ok: false,
          error: { code: 'persistence_failed', message: 'Retention preview unavailable' },
        };
      }
    },
    'storage.retention.set': async (input) => {
      if (this.#draining)
        return { ok: false, error: { code: 'host_draining', message: 'Host draining' } };
      try {
        const policy = await this.#policy.set(input);
        if (!policy)
          return {
            ok: false,
            error: {
              code: 'operation_conflict',
              message: 'Retention setting changed; refresh before saving',
            },
          };
        this.#after = undefined;
        return { ok: true, result: policy };
      } catch {
        return {
          ok: false,
          error: { code: 'persistence_failed', message: 'Retention setting could not be saved' },
        };
      }
    },
  };
  readonly #policy: HostStorageRetentionPolicy;
  readonly #stores: Pick<ExecutionSessionWriter, 'listRetentionCandidates' | 'readCatalogRecord'>;
  readonly #retirement: Pick<
    HostSessionRetirementCoordinator,
    'removeForRetention' | 'estimateRetentionBytes'
  >;
  readonly #path: string;
  readonly #now: () => number;
  #latestTime = 0;
  #lastSweep: StorageRetentionSweep | null = null;
  #lastDeletion: StorageRetentionQueryResult['lastDeletion'] = null;
  #after: string | undefined;
  #revision = -1;
  #draining = false;
  private constructor(input: {
    policy: HostStorageRetentionPolicy;
    stores: Pick<ExecutionSessionWriter, 'listRetentionCandidates' | 'readCatalogRecord'>;
    retirement: Pick<
      HostSessionRetirementCoordinator,
      'removeForRetention' | 'estimateRetentionBytes'
    >;
    stateRoot: string;
    now?: () => number;
  }) {
    this.#policy = input.policy;
    this.#stores = input.stores;
    this.#retirement = input.retirement;
    this.#path = join(input.stateRoot, 'storage-retention-results.json');
    this.#now = input.now ?? Date.now;
  }
  static async open(
    input: Parameters<typeof HostStorageRetentionCoordinator.create>[0],
  ): Promise<HostStorageRetentionCoordinator> {
    const coordinator = HostStorageRetentionCoordinator.create(input);
    try {
      const state = JSON.parse(await readFile(coordinator.#path, 'utf8'));
      if (!Number.isSafeInteger(state.latestTime) || state.latestTime < 0)
        throw new Error('Invalid retention clock');
      const decoded = decodeStorageRetentionQueryResult({
        policy: input.policy.snapshot(),
        preview: { count: 0, eligibleAt: null },
        lastSweep: state.lastSweep,
        lastDeletion: state.lastDeletion,
      });
      coordinator.#latestTime = state.latestTime;
      coordinator.#lastSweep = decoded.lastSweep;
      coordinator.#lastDeletion = decoded.lastDeletion;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    return coordinator;
  }
  static create(input: {
    policy: HostStorageRetentionPolicy;
    stores: Pick<ExecutionSessionWriter, 'listRetentionCandidates' | 'readCatalogRecord'>;
    retirement: Pick<
      HostSessionRetirementCoordinator,
      'removeForRetention' | 'estimateRetentionBytes'
    >;
    stateRoot: string;
    now?: () => number;
  }): HostStorageRetentionCoordinator {
    return new HostStorageRetentionCoordinator(input);
  }
  beginDrain(): void {
    this.#draining = true;
  }
  async run(input: { maxFamilies: number }): Promise<boolean> {
    if (this.#draining) return false;
    const policy = this.#policy.snapshot();
    if (!policy.enabled || policy.enabledAt === null) return false;
    const at = this.#now();
    if (at < Math.max(this.#latestTime, policy.enabledAt)) return false;
    this.#latestTime = at;
    await this.#save();
    if (at <= policy.enabledAt + policy.days * RETENTION_DAY_MS) return false;
    if (this.#revision !== policy.revision) {
      this.#after = undefined;
      this.#revision = policy.revision;
    }
    const page = await this.#stores.listRetentionCandidates({
      cutoff: at - policy.days * RETENTION_DAY_MS,
      after: this.#after,
      limit: Math.min(input.maxFamilies, 8),
    });
    const sweep = { at, deleted: 0, busy: 0, needsReview: 0, failed: 0 };
    let bytes = 0;
    let bytesKnown = true;
    for (const id of page.sessionIds) {
      if (this.#draining) break;
      try {
        const record = await this.#stores.readCatalogRecord(id);
        const deadline = retentionDeadline(policy, record.summary.archivedAt);
        if (deadline === null || at <= deadline) continue;
        let estimated: number | undefined;
        try {
          estimated = await this.#retirement.estimateRetentionBytes(id);
        } catch {
          /* Optional estimate remains unknown. */
        }
        const result = await this.#policy.withCurrent(policy.revision, async (current) => {
          if (this.#now() < this.#latestTime) return 'kept';
          return this.#retirement.removeForRetention(
            { sessionId: id, expectedRevision: record.revision },
            current,
            at,
          );
        });
        if (result === 'removed') {
          sweep.deleted++;
          if (estimated === undefined) bytesKnown = false;
          else bytes += estimated;
        } else if (result === 'busy') sweep.busy++;
        else if (result === 'needs_review') sweep.needsReview++;
        else if (result === 'failed') sweep.failed++;
      } catch {
        sweep.failed++;
      }
    }
    this.#after = page.hasMore ? page.sessionIds.at(-1) : undefined;
    this.#lastSweep = sweep;
    if (sweep.deleted)
      this.#lastDeletion = { at, count: sweep.deleted, estimatedBytes: bytesKnown ? bytes : null };
    await this.#save();
    return page.hasMore && !this.#draining;
  }
  async #preview(policy: StorageRetentionPolicy): Promise<StorageRetentionQueryResult['preview']> {
    const { enabledAt } = policy;
    if (enabledAt === null) return { count: 0, eligibleAt: null };
    let count = 0;
    let after: string | undefined;
    do {
      const page = await this.#stores.listRetentionCandidates({
        cutoff: enabledAt,
        after,
        limit: 8,
      });
      count += page.sessionIds.length;
      after = page.hasMore ? page.sessionIds.at(-1) : undefined;
      if (after) await new Promise((resolve) => setImmediate(resolve));
    } while (after && !this.#draining);
    return { count, eligibleAt: enabledAt + policy.days * RETENTION_DAY_MS };
  }
  async #save(): Promise<void> {
    await writeRetentionDocument(this.#path, {
      latestTime: this.#latestTime,
      lastSweep: this.#lastSweep,
      lastDeletion: this.#lastDeletion,
    });
  }
}
