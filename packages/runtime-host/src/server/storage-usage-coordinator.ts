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
import type { InteractiveStorageFootprintReader } from '@maka/storage/storage-writer-composition';
import type { OperationOutcome, StorageUsageQueryResult } from '../protocol/index.js';
import type { StorageUsageOperationHandlerMap } from './operation-dispatcher.js';

export interface HostStorageUsageCoordinatorOptions {
  readonly footprint: InteractiveStorageFootprintReader;
  readonly now?: () => number;
}

type Failure = Extract<OperationOutcome<'storage.usage.query'>, { ok: false }>;

/** Read-only storage visibility: measures, never reclaims or deletes. */
export class HostStorageUsageCoordinator {
  readonly handlers: StorageUsageOperationHandlerMap = {
    'storage.usage.query': () => this.#queryTotals(),
    'storage.usage.sessions.query': (input) =>
      this.#run(async () => ({
        sessions: await this.#footprint.measureSessions(input.sessionIds),
      })),
  };

  readonly #footprint: InteractiveStorageFootprintReader;
  readonly #now: () => number;
  #measuring: Promise<StorageUsageQueryResult> | undefined;
  #draining = false;

  constructor(options: HostStorageUsageCoordinatorOptions) {
    this.#footprint = options.footprint;
    this.#now = options.now ?? Date.now;
  }

  beginDrain(): void {
    this.#draining = true;
  }

  #queryTotals(): Promise<OperationOutcome<'storage.usage.query'>> {
    // Requests that arrive while a measurement runs share it; the next one
    // after it settles measures again, so a refresh always reads fresh sizes.
    return this.#run(() => {
      this.#measuring ??= this.#footprint
        .measure()
        .then((footprint) => ({ measuredAt: this.#now(), ...footprint }))
        .finally(() => {
          this.#measuring = undefined;
        });
      return this.#measuring;
    });
  }

  async #run<T>(measure: () => Promise<T>): Promise<{ ok: true; result: T } | Failure> {
    if (this.#draining) {
      return { ok: false, error: { code: 'host_draining', message: 'Runtime Host is draining' } };
    }
    try {
      return { ok: true, result: await measure() };
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
}
