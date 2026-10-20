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

const CATALOG_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;

interface PendingProbe {
  revision: number;
  controller: AbortController;
  promise: Promise<ExecutorCatalogEntry>;
}

/** Instance-scoped candidates. Only a retained task Session owns workspace configuration. */
export class AcpCatalog {
  #cached?: { entry: ExecutorCatalogEntry; expires: number };
  #pending?: PendingProbe;
  #tail?: Promise<ExecutorCatalogEntry>;
  readonly #operations = new Set<Promise<ExecutorCatalogEntry>>();
  #revision = 0;
  #disposed = false;

  constructor(
    private readonly admission: AdmissionLimiter,
    private readonly probe: (signal: AbortSignal) => Promise<ExecutorCatalogEntry>,
    private readonly unavailable: () => ExecutorCatalogEntry,
  ) {}

  async get(signal: AbortSignal, refresh = false): Promise<ExecutorCatalogEntry> {
    signal.throwIfAborted();
    if (this.#disposed) return this.unavailable();
    if (refresh) this.invalidate();
    while (true) {
      signal.throwIfAborted();
      if (this.#disposed) return this.unavailable();
      const cached = this.#cached;
      if (cached && cached.expires > Date.now()) return cached.entry;
      const pending = this.#ensureProbe();
      const result = await waitForSignal(pending.promise, signal);
      signal.throwIfAborted();
      if (this.#disposed) return this.unavailable();
      // An invalidation need not have another caller to start its replacement.
      // Only superseded revisions retry; genuine failures remain terminal.
      if (pending.revision !== this.#revision) continue;
      return result;
    }
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
          const permit = await this.admission.acquire(startup);
          let entry: ExecutorCatalogEntry;
          try {
            startup.throwIfAborted();
            // probe settles only after its process and temporary directory have been disposed.
            entry = await this.probe(startup);
          } finally {
            permit.release();
          }
          if (startup.aborted || revision !== this.#revision || this.#disposed)
            return this.unavailable();
          if (entry.readiness === 'ready')
            this.#cached = { entry, expires: Date.now() + CATALOG_TTL_MS };
          return entry;
        } catch {
          return this.unavailable();
        }
      };
      const promise = run().finally(() => {
        this.#operations.delete(promise);
        if (this.#pending?.promise === promise) this.#pending = undefined;
        if (this.#tail === promise) this.#tail = undefined;
      });
      this.#pending = { revision, controller, promise };
      this.#tail = promise;
      this.#operations.add(promise);
    }
    return this.#pending;
  }

  invalidate(): void {
    this.#revision++;
    this.#cached = undefined;
    this.#pending?.controller.abort(new Error('ACP catalog invalidated'));
    this.#pending = undefined;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.invalidate();
    await Promise.allSettled(this.#operations);
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
