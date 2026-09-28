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

import type { InteractiveArtifactStoreWriter } from '@maka/storage/artifact-stores';
import type { InteractiveContextOffloadWriter } from '@maka/storage/context-offload-store';

const ACTIVE_DELAY_MS = 100;
const IDLE_DELAY_MS = 60_000;
const MAX_BATCH_ITEMS = 64;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;

interface MaintenanceLane {
  readonly name: string;
  readonly run: () => Promise<boolean>;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
  failures: number;
}

/** Physical cleanup is optional work, admitted only after the Host publishes Ready. */
export class HostStorageMaintenance {
  readonly #lanes: MaintenanceLane[];
  readonly #onError: (name: string, error: unknown) => void;
  #started = false;
  #draining = false;

  constructor(input: {
    artifacts: Pick<InteractiveArtifactStoreWriter, 'reclaimUpgradeResidue'>;
    contextOffload?: Pick<InteractiveContextOffloadWriter, 'collectGarbage'>;
    onError: (name: string, error: unknown) => void;
  }) {
    this.#onError = input.onError;
    let after: string | undefined;
    this.#lanes = [
      {
        name: 'artifact upgrade cleanup',
        failures: 0,
        run: async () => {
          const result = await input.artifacts.reclaimUpgradeResidue({
            after,
            maxPaths: MAX_BATCH_ITEMS,
          });
          after = result.nextAfter ?? undefined;
          if (result.failedPaths > 0) {
            this.#report(
              'artifact upgrade cleanup',
              new Error(`${result.failedPaths} paths remain pending`),
            );
          }
          return result.nextAfter !== null;
        },
      },
    ];
    const context = input.contextOffload;
    if (context)
      this.#lanes.push({
        name: 'context garbage collection',
        failures: 0,
        run: async () =>
          (
            await context.collectGarbage({
              olderThan: Date.now(),
              maxBlobs: MAX_BATCH_ITEMS,
              maxBytes: MAX_BATCH_BYTES,
            })
          ).hasMore,
      });
  }

  start(): void {
    if (this.#started || this.#draining) return;
    this.#started = true;
    for (const lane of this.#lanes) this.#schedule(lane, ACTIVE_DELAY_MS);
  }

  beginDrain(): void {
    this.#draining = true;
    for (const lane of this.#lanes) clearTimeout(lane.timer);
  }

  async close(): Promise<void> {
    this.beginDrain();
    await Promise.all(this.#lanes.map((lane) => lane.pending));
  }

  #schedule(lane: MaintenanceLane, delay: number): void {
    if (this.#draining) return;
    lane.timer = setTimeout(() => {
      lane.pending = this.#run(lane);
    }, delay);
    lane.timer.unref();
  }

  async #run(lane: MaintenanceLane): Promise<void> {
    if (this.#draining) return;
    let delay: number;
    try {
      const more = await lane.run();
      lane.failures = 0;
      delay = more ? ACTIVE_DELAY_MS : IDLE_DELAY_MS;
    } catch (error) {
      lane.failures = Math.min(lane.failures + 1, 7);
      delay = Math.min(IDLE_DELAY_MS, 1000 * 2 ** (lane.failures - 1));
      this.#report(lane.name, error);
    }
    this.#schedule(lane, delay);
  }

  #report(name: string, error: unknown): void {
    try {
      this.#onError(name, error);
    } catch {
      // Diagnostics must not terminate a maintenance lane or poison Host readiness.
    }
  }
}
