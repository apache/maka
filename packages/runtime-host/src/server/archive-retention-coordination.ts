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

/** Tracks the Host's wall-clock high-water mark used by retention sweeps. */
export class ArchiveRetentionClockGuard {
  #observedAt = 0;
  #observedThisRun = false;

  get observedAt(): number {
    return this.#observedAt;
  }

  observe(now: number): { readonly previous: number; readonly observedThisRun: boolean } {
    const previous = this.#observedAt;
    const observedThisRun = this.#observedThisRun;
    this.#observedAt = Math.max(previous, now);
    this.#observedThisRun = true;
    return { previous, observedThisRun };
  }

  /** Seed the high-water mark from persisted Host observations. */
  seed(...times: readonly number[]): void {
    this.#observedAt = Math.max(this.#observedAt, ...times);
  }

  /** Record a setting change's time while retaining the high-water mark. */
  recordSettingTime(now: number): void {
    this.#observedAt = Math.max(this.#observedAt, now);
    this.#observedThisRun = true;
  }

  isBehind(now: number): boolean {
    return now < this.#observedAt;
  }

  hasForwardJump(now: number, since: number, threshold: number): boolean {
    return now - since > threshold;
  }
}

/** Coordinates setting changes with a retention tick already in progress. */
export class ArchiveRetentionTickGate {
  #changing = 0;
  #ticking: Promise<boolean> | undefined;

  get changePending(): boolean {
    return this.#changing > 0;
  }

  async runTick(tick: () => Promise<boolean>): Promise<boolean> {
    const inFlight = tick();
    this.#ticking = inFlight;
    try {
      return await inFlight;
    } finally {
      if (this.#ticking === inFlight) this.#ticking = undefined;
    }
  }

  async runSettingChange<T>(change: () => Promise<T>): Promise<T> {
    this.#changing += 1;
    try {
      await this.#ticking?.catch(() => undefined);
      return await change();
    } finally {
      this.#changing -= 1;
    }
  }
}
