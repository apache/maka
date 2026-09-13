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

import type {
  CanonicalPermissionOutcomeReader,
  CanonicalPermissionOutcomeRecord,
} from '@maka/runtime/interaction-authority';
import type { InteractionStoreReader } from '@maka/storage/interaction-store';

export const CANONICAL_PERMISSION_OUTCOME_CACHE_CAPACITY = 256;

export interface HostCanonicalPermissionOutcomeReaderOptions {
  readonly store: Pick<InteractionStoreReader, 'readInteraction'>;
  readonly capacity?: number;
}

/** Bounded point-read view over canonical permission outcomes. */
export class HostCanonicalPermissionOutcomeReader implements CanonicalPermissionOutcomeReader {
  readonly #store: HostCanonicalPermissionOutcomeReaderOptions['store'];
  readonly #capacity: number;
  readonly #cache = new Map<string, CanonicalPermissionOutcomeRecord>();
  readonly #reads = new Map<string, Promise<CanonicalPermissionOutcomeRecord | undefined>>();

  constructor(options: HostCanonicalPermissionOutcomeReaderOptions) {
    this.#store = options.store;
    this.#capacity = options.capacity ?? CANONICAL_PERMISSION_OUTCOME_CACHE_CAPACITY;
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity < 1) {
      throw new Error('permission outcome cache capacity must be a positive safe integer');
    }
  }

  async readPermissionOutcome(
    requestId: string,
  ): Promise<CanonicalPermissionOutcomeRecord | undefined> {
    const cached = this.#cache.get(requestId);
    if (cached) {
      this.#cache.delete(requestId);
      this.#cache.set(requestId, cached);
      return cached;
    }

    const existing = this.#reads.get(requestId);
    if (existing) return await existing;

    const pending = this.#readUncached(requestId);
    this.#reads.set(requestId, pending);
    try {
      const outcome = await pending;
      if (outcome) this.#cacheOutcome(requestId, outcome);
      return outcome;
    } finally {
      if (this.#reads.get(requestId) === pending) this.#reads.delete(requestId);
    }
  }

  #cacheOutcome(requestId: string, outcome: CanonicalPermissionOutcomeRecord): void {
    this.#cache.delete(requestId);
    this.#cache.set(requestId, outcome);
    if (this.#cache.size <= this.#capacity) return;

    const leastRecentlyUsed = this.#cache.keys().next().value;
    if (leastRecentlyUsed !== undefined) this.#cache.delete(leastRecentlyUsed);
  }

  async #readUncached(requestId: string): Promise<CanonicalPermissionOutcomeRecord | undefined> {
    const record = await this.#store.readInteraction(requestId);
    if (
      !record?.outcome ||
      record.request.request.kind !== 'permission' ||
      record.outcome.outcome.kind !== 'permission_answer'
    ) {
      return undefined;
    }
    return Object.freeze({
      sessionId: record.request.sessionId,
      runId: record.request.runId,
      turnId: record.request.turnId,
      requestId: record.request.requestId,
      request: record.request.request,
      outcome: record.outcome.outcome,
    });
  }
}
