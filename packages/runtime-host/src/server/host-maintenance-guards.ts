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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export type HostClockDecision =
  | { readonly kind: 'ok'; readonly previous: number; readonly observedThisRun: boolean }
  | { readonly kind: 'pause'; readonly previous: number; readonly observedThisRun: boolean }
  | {
      readonly kind: 'hold';
      readonly since: number;
      readonly previous: number;
      readonly observedThisRun: boolean;
    };

/** Shares high-water and per-tick clock decisions across Host maintenance policies. */
export class HostClockGuard {
  #observedAt = 0;
  #observedThisRun = false;

  get observedAt(): number {
    return this.#observedAt;
  }

  isBehind(now: number): boolean {
    return now < this.#observedAt;
  }

  shouldClearHold(now: number, holdUntil?: number): boolean {
    return holdUntil !== undefined && now >= holdUntil;
  }

  seed(...times: readonly number[]): void {
    this.#observedAt = Math.max(this.#observedAt, ...times);
  }

  recordSettingTime(now: number): void {
    this.#observedAt = Math.max(this.#observedAt, now);
    this.#observedThisRun = true;
  }

  async decideTick(options: {
    readonly now: number;
    readonly gapThreshold: number;
    readonly checkBackwards: boolean;
    readonly readLatestSessionMetadataTime: () => Promise<number | undefined>;
  }): Promise<HostClockDecision> {
    const previous = this.#observedAt;
    const observedThisRun = this.#observedThisRun;
    this.#observedAt = Math.max(previous, options.now);
    this.#observedThisRun = true;
    const since = observedThisRun
      ? previous
      : Math.max(previous, (await options.readLatestSessionMetadataTime()) ?? 0);
    if (options.now - since > options.gapThreshold) {
      return { kind: 'hold', since, previous, observedThisRun };
    }
    if (!options.checkBackwards) {
      return { kind: 'ok', previous, observedThisRun };
    }
    if (options.now < previous) {
      return { kind: 'pause', previous, observedThisRun };
    }
    const newest = await options.readLatestSessionMetadataTime();
    return newest !== undefined && options.now < newest
      ? { kind: 'pause', previous, observedThisRun }
      : { kind: 'ok', previous, observedThisRun };
  }
}

/** Coordinates Host setting changes with an in-flight maintenance tick. */
export class SettingTickGate {
  #changing = 0;
  #ticking: Promise<boolean> | undefined;

  get changePending(): boolean {
    return this.#changing > 0;
  }

  async runTick(tick: () => Promise<boolean>): Promise<boolean> {
    if (this.changePending) return true;
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
