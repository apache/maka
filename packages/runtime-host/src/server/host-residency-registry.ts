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

import type { OperationResidency } from './operation-dispatcher.js';

const RESIDENCY_LABEL_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/**
 * Residencies answer two different questions and the kinds must not be
 * conflated:
 *
 * - `drain` residencies mark real work in flight. They block idle exit and
 *   must settle before a graceful close completes.
 * - `idle` residencies only block idle exit. A marker such as
 *   process-retention is not work: it must not stall a drain or count as
 *   activity that blocks a maintenance probe.
 */
export type HostResidencyKind = 'drain' | 'idle';

export interface HostResidencySnapshot {
  readonly label: string;
  readonly count: number;
}

interface HostResidencyCounts {
  total: number;
  drain: number;
}

export class HostResidencyRegistry {
  readonly #counts = new Map<string, HostResidencyCounts>();
  readonly #drainWaiters = new Set<{
    readonly excludedLabel: string | undefined;
    readonly resolve: () => void;
  }>();
  #activeCount = 0;
  #drainCount = 0;

  /** Residencies of either kind keep the process alive against idle exit. */
  get activeCount(): number {
    return this.#activeCount;
  }

  /** Only drain-kind residencies block maintenance probes and graceful close. */
  get drainCount(): number {
    return this.#drainCount;
  }

  acquire(label: string, kind: HostResidencyKind = 'drain'): OperationResidency {
    requireResidencyLabel(label);
    this.#activeCount += 1;
    if (kind === 'drain') this.#drainCount += 1;
    const counts = this.#counts.get(label) ?? { total: 0, drain: 0 };
    counts.total += 1;
    if (kind === 'drain') counts.drain += 1;
    this.#counts.set(label, counts);
    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        this.#release(label, kind);
      },
    };
  }

  snapshot(): readonly HostResidencySnapshot[] {
    return [...this.#counts]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([label, counts]) => Object.freeze({ label, count: counts.total }));
  }

  waitForEmpty(): Promise<void> {
    return this.#waitForDrainEmptyExcept(undefined);
  }

  waitForEmptyExcept(excludedLabel: string): Promise<void> {
    requireResidencyLabel(excludedLabel);
    return this.#waitForDrainEmptyExcept(excludedLabel);
  }

  #release(label: string, kind: HostResidencyKind): void {
    const counts = this.#counts.get(label);
    if (counts === undefined || counts.total === 0 || this.#activeCount === 0) {
      throw new Error('Runtime Host residency underflow');
    }
    counts.total -= 1;
    if (kind === 'drain') {
      counts.drain -= 1;
      this.#drainCount -= 1;
    }
    this.#activeCount -= 1;
    if (counts.total === 0) this.#counts.delete(label);
    for (const waiter of this.#drainWaiters) {
      if (!this.#isDrainEmptyExcept(waiter.excludedLabel)) continue;
      this.#drainWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  #waitForDrainEmptyExcept(excludedLabel: string | undefined): Promise<void> {
    if (this.#isDrainEmptyExcept(excludedLabel)) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.add({ excludedLabel, resolve }));
  }

  #isDrainEmptyExcept(excludedLabel: string | undefined): boolean {
    for (const [label, counts] of this.#counts) {
      if (counts.drain > 0 && label !== excludedLabel) return false;
    }
    return true;
  }
}

function requireResidencyLabel(label: string): void {
  if (!RESIDENCY_LABEL_PATTERN.test(label) || label.length > 128) {
    throw new TypeError('Runtime Host residency label is invalid');
  }
}
