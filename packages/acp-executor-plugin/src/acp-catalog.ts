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

import type { ExecutorCatalogEntry } from '@maka/core/executor-catalog';
import type { AdmissionLimiter } from '@maka/runtime/admission-limiter';

const PROBE_TIMEOUT_MS = 30_000;
const RETRY_COOLDOWN_MS = 60_000;

interface PendingProbe {
  revision: number;
  controller: AbortController;
  promise: Promise<ExecutorCatalogEntry>;
}

export interface AcpCatalogStore {
  load(): Promise<ExecutorCatalogEntry | undefined>;
  save(entry: ExecutorCatalogEntry | undefined): Promise<void>;
}

/** Public candidates come only from neutral discovery; task capabilities remain Session-owned. */
export class AcpCatalog {
  #cached?: ExecutorCatalogEntry;
  #pending?: PendingProbe;
  #tail?: Promise<ExecutorCatalogEntry>;
  #revision = 0;
  #disposed = false;
  #hydration?: Promise<void>;
  #writes: Promise<void> = Promise.resolve();
  #failure?: { entry: ExecutorCatalogEntry; retryAt: number };

  constructor(
    private readonly admission: AdmissionLimiter,
    private readonly probe: (
      signal: AbortSignal,
      holdAdmission: (until: Promise<void>) => void,
    ) => Promise<ExecutorCatalogEntry>,
    private readonly unavailable: () => ExecutorCatalogEntry,
    private readonly drain: () => Promise<void> = async () => {},
    private readonly store?: AcpCatalogStore,
  ) {}

  async get(signal: AbortSignal, refresh = false): Promise<ExecutorCatalogEntry> {
    signal.throwIfAborted();
    if (this.#disposed) return this.unavailable();
    await waitForSignal(this.#hydrate(), signal);
    if (refresh) {
      this.#cancelProbe();
      this.#failure = undefined;
    }
    let force = refresh;
    while (true) {
      signal.throwIfAborted();
      if (this.#disposed) return this.unavailable();
      const cached = this.#cached;
      if (cached && !force) return this.#failure ? { ...cached, refreshFailed: true } : cached;
      if (!force && this.#failure && Date.now() < this.#failure.retryAt) return this.#failure.entry;
      const pending = this.#ensureProbe();
      const result = await waitForSignal(pending.promise, signal);
      signal.throwIfAborted();
      if (this.#disposed) return this.unavailable();
      // An invalidation need not have another caller to start its replacement.
      // Only superseded revisions retry; genuine failures remain terminal.
      if (pending.revision !== this.#revision) {
        force = !!this.#pending;
        continue;
      }
      return result;
    }
  }

  #hydrate(): Promise<void> {
    if (!this.#hydration) {
      const revision = this.#revision;
      this.#hydration = (async () => {
        const entry = await this.store?.load();
        if (revision !== this.#revision || !entry) return;
        this.#cached = entry;
      })().catch(() => {
        // An optional cache must not prevent fresh discovery.
      });
    }
    return this.#hydration;
  }

  #save(entry: ExecutorCatalogEntry | undefined): void {
    if (!this.store) return;
    const snapshot = entry ? structuredClone(entry) : undefined;
    // Serialize writes and invalidation so a slow old write cannot resurrect a
    // deleted snapshot. Every successful probe refreshes the executable binding.
    this.#writes = this.#writes
      .then(async () => {
        await this.store!.save(snapshot);
      })
      .catch(() => {
        // Keep the in-memory catalog usable; a later refresh can retry.
      });
  }

  #ensureProbe(): PendingProbe {
    if (!this.#pending) {
      const revision = this.#revision;
      const controller = new AbortController();
      const startup = AbortSignal.any([controller.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
      const previous = this.#tail;
      const run = async () => {
        try {
          // A refresh must drain the superseded process before starting its replacement.
          await previous;
          startup.throwIfAborted();
          // Failed cleanup may still own the previous permit. Retry it before
          // acquiring another permit, including when the budget is only one.
          await this.drain();
          startup.throwIfAborted();
          const permit = await this.admission.acquire(startup);
          let retained = false;
          let entry: ExecutorCatalogEntry;
          try {
            startup.throwIfAborted();
            entry = await this.probe(startup, (until) => {
              retained = true;
              void until.then(
                () => permit.release(),
                () => permit.release(),
              );
            });
          } finally {
            if (!retained) permit.release();
          }
          if (controller.signal.aborted || revision !== this.#revision || this.#disposed)
            return this.unavailable();
          if (startup.aborted) return this.#acceptProbe(this.unavailable());
          return this.#acceptProbe(entry);
        } catch {
          // A real timeout is retryable; cancellation/supersession is not a failure.
          if (!controller.signal.aborted && revision === this.#revision && !this.#disposed)
            return this.#acceptProbe(this.unavailable());
          return this.unavailable();
        }
      };
      const promise = run().finally(() => {
        if (this.#pending?.promise === promise) this.#pending = undefined;
        if (this.#tail === promise) this.#tail = undefined;
      });
      this.#pending = { revision, controller, promise };
      this.#tail = promise;
    }
    return this.#pending;
  }

  #acceptProbe(entry: ExecutorCatalogEntry): ExecutorCatalogEntry {
    if (entry.readiness === 'ready') {
      this.#failure = undefined;
      this.#cached = entry;
      this.#save(entry);
      return entry;
    }
    if (entry.readiness === 'authentication_required') {
      // A known account failure must not expose the previous account's choices.
      this.#cached = undefined;
      this.#hydration = Promise.resolve();
      this.#save(undefined);
    }
    this.#failure = { entry, retryAt: Date.now() + RETRY_COOLDOWN_MS };
    return this.#cached ? { ...this.#cached, refreshFailed: true } : entry;
  }

  invalidate(): void {
    this.#cached = undefined;
    this.#failure = undefined;
    this.#cancelProbe();
    this.#hydration = Promise.resolve();
    this.#save(undefined);
  }

  #cancelProbe(): void {
    this.#revision++;
    this.#pending?.controller.abort(new Error('ACP catalog invalidated'));
    this.#pending = undefined;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#cancelProbe();
    // Each replacement awaits its predecessor, including cancelled probes.
    await this.#tail;
    await this.#hydration;
    await this.#writes;
    this.#cached = undefined;
  }
}

/** A caller can stop waiting without cancelling a probe shared by other drafts. */
async function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}
