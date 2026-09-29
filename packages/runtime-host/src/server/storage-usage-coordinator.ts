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

import { generalizedErrorMessage } from '@maka/core/redaction';
import type {
  InteractiveStorageFootprintReader,
  StorageFootprint,
} from '@maka/storage/storage-writer-composition';
import type {
  OperationOutcome,
  StorageUsageQueryInput,
  StorageUsageQueryResult,
} from '../protocol/index.js';
import type { StorageUsageOperationHandlerMap } from './operation-dispatcher.js';

/**
 * State Root totals scan whole tables, so they are shared for a short while.
 * Per-Session figures are index lookups and are always read fresh.
 */
export const STORAGE_USAGE_TOTALS_TTL_MS = 15_000;

interface MeasuredTotals {
  readonly measuredAt: number;
  readonly footprint: StorageFootprint;
}

export interface HostStorageUsageCoordinatorOptions {
  readonly footprint: InteractiveStorageFootprintReader;
  readonly now?: () => number;
}

/** Read-only storage visibility: measures, never reclaims or deletes. */
export class HostStorageUsageCoordinator {
  readonly handlers: StorageUsageOperationHandlerMap = {
    'storage.usage.query': (input) => this.#query(input),
  };

  readonly #footprint: InteractiveStorageFootprintReader;
  readonly #now: () => number;
  #totals: MeasuredTotals | undefined;
  #measuring: Promise<MeasuredTotals> | undefined;
  #draining = false;

  constructor(options: HostStorageUsageCoordinatorOptions) {
    this.#footprint = options.footprint;
    this.#now = options.now ?? Date.now;
  }

  beginDrain(): void {
    this.#draining = true;
  }

  async #query(input: StorageUsageQueryInput): Promise<OperationOutcome<'storage.usage.query'>> {
    if (this.#draining) {
      return { ok: false, error: { code: 'host_draining', message: 'Runtime Host is draining' } };
    }
    try {
      const [totals, sessions] = await Promise.all([
        this.#readTotals(),
        input.sessionIds ? this.#footprint.measureSessions(input.sessionIds) : undefined,
      ]);
      const result: StorageUsageQueryResult = {
        measuredAt: totals.measuredAt,
        totals: totals.footprint.totals,
        reclaimableBytes: totals.footprint.reclaimableBytes,
        worktreeCount: totals.footprint.worktreeCount,
        ...(sessions ? { sessions } : {}),
      };
      return { ok: true, result };
    } catch (error) {
      console.error(
        `[runtime-host] storage usage could not be measured: ${generalizedErrorMessage(error)}`,
      );
      return {
        ok: false,
        error: { code: 'persistence_failed', message: 'Storage usage could not be measured' },
      };
    }
  }

  #readTotals(): Promise<MeasuredTotals> {
    const cached = this.#totals;
    if (cached && this.#now() - cached.measuredAt < STORAGE_USAGE_TOTALS_TTL_MS) {
      return Promise.resolve(cached);
    }
    // Concurrent readers share one scan instead of each walking the tables.
    this.#measuring ??= this.#footprint
      .measure()
      .then((footprint) => {
        const measured = { measuredAt: this.#now(), footprint };
        this.#totals = measured;
        return measured;
      })
      .finally(() => {
        this.#measuring = undefined;
      });
    return this.#measuring;
  }
}
