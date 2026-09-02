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

const DEFAULT_BACKOFF_MIN_MS = 100;
const DEFAULT_BACKOFF_MAX_MS = 5_000;
const DEFAULT_STABLE_CONNECTION_MS = 10_000;
const DEFAULT_UNSTABLE_MAX_MS = 60_000;

export interface RuntimeHostReconnectResource {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeHostReconnectBackoff {
  readonly minMs?: number;
  readonly maxMs?: number;
  readonly stableConnectionMs?: number;
  /**
   * Ceiling applied once a connection keeps failing without ever stabilizing.
   * After the jittered delay has saturated at maxMs, the failure streak keeps
   * doubling up to this bound so a persistently dying Host cannot force a
   * regeneration attempt every maxMs indefinitely. Defaults to 60_000; set it
   * equal to maxMs to keep the flat ceiling.
   */
  readonly unstableMaxMs?: number;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface RuntimeHostReconnectLifecycle<T extends RuntimeHostReconnectResource> {
  readonly closed: Promise<void>;
  readonly current: T | undefined;
  waitForCurrent(previous?: T, signal?: AbortSignal): Promise<T>;
  subscribe(listener: (current: T | undefined) => void): () => void;
  wake(): void;
  suspend(): Promise<RuntimeHostReconnectSuspension<T>>;
  quiesce(): Promise<RuntimeHostReconnectQuiescence<T>>;
  close(): Promise<void>;
}

export interface RuntimeHostReconnectSuspension<T extends RuntimeHostReconnectResource> {
  readonly current: T | undefined;
  resume(): void;
}

export interface RuntimeHostReconnectQuiescence<T extends RuntimeHostReconnectResource> {
  readonly current: T;
  resume(): void;
}

export class RuntimeHostPermanentReconnectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeHostPermanentReconnectError';
  }
}

export async function startRuntimeHostReconnectLifecycle<
  T extends RuntimeHostReconnectResource,
>(input: {
  readonly initial?: T;
  readonly connect: (signal: AbortSignal) => Promise<T>;
  readonly retryInitialFailure?: boolean;
  readonly initialSignal?: AbortSignal;
  readonly onReconnectError?: (error: Error) => void;
  readonly onFatalError?: (error: Error) => void;
  readonly backoff?: RuntimeHostReconnectBackoff;
}): Promise<RuntimeHostReconnectLifecycle<T>> {
  const lifecycle = new RuntimeHostReconnectLifecycleImpl(input);
  await lifecycle.start();
  return lifecycle;
}

interface CurrentWaiter<T> {
  readonly previous: T | undefined;
  readonly dispose: () => void;
  resolve(value: T): void;
  reject(error: Error): void;
}

class RuntimeHostReconnectLifecycleImpl<T extends RuntimeHostReconnectResource>
  implements RuntimeHostReconnectLifecycle<T>
{
  readonly closed: Promise<void>;
  readonly #initial: T | undefined;
  readonly #connect: (signal: AbortSignal) => Promise<T>;
  readonly #retryInitialFailure: boolean;
  readonly #initialSignal: AbortSignal | undefined;
  readonly #onReconnectError: ((error: Error) => void) | undefined;
  readonly #onFatalError: ((error: Error) => void) | undefined;
  readonly #minMs: number;
  readonly #maxMs: number;
  readonly #stableConnectionMs: number;
  readonly #unstableMaxMs: number;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #wait: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly #abort = new AbortController();
  readonly #listeners = new Set<(current: T | undefined) => void>();
  readonly #waiters = new Set<CurrentWaiter<T>>();
  #current: T | undefined;
  #installedAt = 0;
  #failureCount = 0;
  #closed = false;
  #quiesced = false;
  #terminalError: Error | undefined;
  #reconnectTask: Promise<void> | undefined;
  #reconnectAbort: AbortController | undefined;
  #discardTask: Promise<void> = Promise.resolve();
  #closeTask: Promise<void> | undefined;
  #resolveClosed!: () => void;
  #wakeDelay: (() => void) | undefined;
  #wakeGeneration = 0;

  constructor(input: {
    readonly initial?: T;
    readonly connect: (signal: AbortSignal) => Promise<T>;
    readonly retryInitialFailure?: boolean;
    readonly initialSignal?: AbortSignal;
    readonly onReconnectError?: (error: Error) => void;
    readonly onFatalError?: (error: Error) => void;
    readonly backoff?: RuntimeHostReconnectBackoff;
  }) {
    this.#connect = input.connect;
    this.#initial = input.initial;
    this.#retryInitialFailure = input.retryInitialFailure ?? false;
    this.#initialSignal = input.initialSignal;
    this.#onReconnectError = input.onReconnectError;
    this.#onFatalError = input.onFatalError;
    this.#minMs = requireDelay(input.backoff?.minMs ?? DEFAULT_BACKOFF_MIN_MS, 'minMs');
    this.#maxMs = requireDelay(input.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS, 'maxMs');
    this.#stableConnectionMs = requireDelay(
      input.backoff?.stableConnectionMs ?? DEFAULT_STABLE_CONNECTION_MS,
      'stableConnectionMs',
    );
    this.#unstableMaxMs = requireDelay(
      input.backoff?.unstableMaxMs ?? Math.max(DEFAULT_UNSTABLE_MAX_MS, this.#maxMs),
      'unstableMaxMs',
    );
    if (this.#maxMs < this.#minMs)
      throw new RangeError('maxMs must be greater than or equal to minMs');
    if (this.#unstableMaxMs < this.#maxMs) {
      throw new RangeError('unstableMaxMs must be greater than or equal to maxMs');
    }
    this.#random = input.backoff?.random ?? Math.random;
    this.#now = input.backoff?.now ?? Date.now;
    this.#wait = input.backoff?.wait ?? waitForDelay;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  get current(): T | undefined {
    return this.#current;
  }

  async start(): Promise<void> {
    try {
      if (this.#initial) {
        this.#install(this.#initial);
        return;
      }
      this.#initialSignal?.throwIfAborted();
      const signal = this.#initialSignal
        ? AbortSignal.any([this.#abort.signal, this.#initialSignal])
        : this.#abort.signal;
      this.#install(await this.#connect(signal));
    } catch (error) {
      const failure = asError(error);
      if (
        this.#retryInitialFailure &&
        !this.#closed &&
        !this.#abort.signal.aborted &&
        !this.#initialSignal?.aborted &&
        !(failure instanceof RuntimeHostPermanentReconnectError)
      ) {
        this.#failureCount += 1;
        notifyError(this.#onReconnectError, failure);
        this.#scheduleReconnect();
        return;
      }
      this.#failPermanently(failure);
      throw error;
    }
  }

  waitForCurrent(previous?: T, signal?: AbortSignal): Promise<T> {
    if (this.#current && this.#current !== previous) return Promise.resolve(this.#current);
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#closed)
      return Promise.reject(new Error('Runtime Host reconnect lifecycle is closed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let waiter: CurrentWaiter<T>;
      const onAbort = () => {
        this.#waiters.delete(waiter);
        reject(signal?.reason);
      };
      waiter = {
        previous,
        resolve,
        reject,
        dispose: () => signal?.removeEventListener('abort', onAbort),
      };
      this.#waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  subscribe(listener: (current: T | undefined) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  wake(): void {
    this.#wakeGeneration += 1;
    const wake = this.#wakeDelay;
    this.#wakeDelay = undefined;
    wake?.();
  }

  async suspend(): Promise<RuntimeHostReconnectSuspension<T>> {
    if (this.#closed || this.#terminalError) {
      throw new Error('Runtime Host reconnect lifecycle is closed');
    }
    if (this.#quiesced) throw new Error('Runtime Host reconnect lifecycle is already quiesced');
    this.#quiesced = true;
    this.#reconnectAbort?.abort(new Error('Runtime Host reconnect lifecycle is suspended'));
    await this.#reconnectTask?.catch(() => undefined);
    if (this.#closed || this.#terminalError) {
      this.#quiesced = false;
      throw new Error('Runtime Host reconnect lifecycle is closed');
    }
    return this.#suspension(this.#current);
  }

  async quiesce(): Promise<RuntimeHostReconnectQuiescence<T>> {
    while (!this.#current) {
      if (this.#closed || this.#terminalError) {
        throw new Error('Runtime Host reconnect lifecycle is closed');
      }
      if (this.#quiesced) {
        throw new Error('Runtime Host reconnect lifecycle is already quiesced');
      }
      await this.waitForCurrent();
    }
    if (this.#closed || this.#terminalError) {
      throw new Error('Runtime Host reconnect lifecycle is closed');
    }
    if (this.#quiesced) throw new Error('Runtime Host reconnect lifecycle is already quiesced');
    const current = this.#current;
    this.#quiesced = true;
    return this.#suspension(current) as RuntimeHostReconnectQuiescence<T>;
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#quiesced = false;
    this.#reconnectAbort?.abort();
    this.#abort.abort();
    const error = new Error('Runtime Host reconnect lifecycle is closed');
    this.#rejectWaiters(error);
    const current = this.#current;
    this.#setCurrent(undefined);
    await current?.close().catch(() => undefined);
    await this.#reconnectTask?.catch(() => undefined);
    await this.#discardTask;
    this.#resolveClosed();
  }

  #install(resource: T): void {
    if (this.#closed || this.#terminalError) {
      this.#discard(resource);
      return;
    }
    this.#installedAt = this.#now();
    this.#setCurrent(resource);
    void resource.closed.then(
      () => this.#disconnected(resource),
      () => this.#disconnected(resource),
    );
  }

  #discard(resource: T): void {
    this.#discardTask = this.#discardTask.then(() => resource.close()).catch(() => undefined);
  }

  #disconnected(resource: T): void {
    if (this.#closed || this.#terminalError || this.#current !== resource) return;
    if (this.#now() - this.#installedAt >= this.#stableConnectionMs) this.#failureCount = 0;
    this.#failureCount += 1;
    this.#setCurrent(undefined);
    if (!this.#quiesced) this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (
      this.#closed ||
      this.#quiesced ||
      this.#terminalError ||
      this.#current ||
      this.#reconnectTask
    )
      return;
    const reconnectAbort = new AbortController();
    const task = this.#reconnect(AbortSignal.any([this.#abort.signal, reconnectAbort.signal]));
    this.#reconnectAbort = reconnectAbort;
    this.#reconnectTask = task;
    const finalize = () => {
      if (this.#reconnectTask === task) {
        this.#reconnectTask = undefined;
        this.#reconnectAbort = undefined;
      }
      this.#scheduleReconnect();
    };
    void task.then(finalize, finalize);
  }

  async #reconnect(signal: AbortSignal): Promise<void> {
    let attemptedWakeGeneration = this.#wakeGeneration;
    while (!this.#closed && !this.#quiesced && !this.#terminalError && !this.#current) {
      const delayMs = reconnectDelayMs(
        this.#failureCount - 1,
        this.#minMs,
        this.#maxMs,
        this.#random,
        this.#unstableMaxMs,
      );
      const wakeGeneration = this.#wakeGeneration;
      try {
        if (delayMs > 0 && wakeGeneration === attemptedWakeGeneration) {
          await this.#waitForReconnectDelay(delayMs, signal, wakeGeneration);
        }
        attemptedWakeGeneration = this.#wakeGeneration;
        const resource = await this.#connect(signal);
        this.#install(resource);
      } catch (error) {
        if (this.#closed || this.#quiesced || signal.aborted) return;
        const failure = asError(error);
        if (failure instanceof RuntimeHostPermanentReconnectError) {
          this.#failPermanently(failure);
          return;
        }
        this.#failureCount += 1;
        notifyError(this.#onReconnectError, failure);
      }
    }
  }

  async #waitForReconnectDelay(
    delayMs: number,
    signal: AbortSignal,
    observedWakeGeneration: number,
  ): Promise<void> {
    if (this.#wakeGeneration !== observedWakeGeneration) return;
    let wake!: () => void;
    const routeAvailable = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const delayAbort = new AbortController();
    const delaySignal = AbortSignal.any([signal, delayAbort.signal]);
    this.#wakeDelay = wake;
    if (this.#wakeGeneration !== observedWakeGeneration) wake();
    try {
      await Promise.race([this.#wait(delayMs, delaySignal), routeAvailable]);
    } finally {
      if (this.#wakeDelay === wake) this.#wakeDelay = undefined;
      delayAbort.abort();
    }
  }

  #suspension(current: T | undefined): RuntimeHostReconnectSuspension<T> {
    let active = true;
    return {
      current,
      resume: () => {
        if (!active) return;
        active = false;
        if (!this.#quiesced || this.#closed || this.#terminalError) return;
        this.#quiesced = false;
        this.#scheduleReconnect();
      },
    };
  }

  #setCurrent(current: T | undefined): void {
    if (this.#current === current) return;
    this.#current = current;
    for (const listener of this.#listeners) {
      try {
        listener(current);
      } catch {
        // A lifecycle observer cannot invalidate the connection it observes.
      }
    }
    if (current) {
      for (const waiter of [...this.#waiters]) {
        if (waiter.previous === current) continue;
        this.#waiters.delete(waiter);
        waiter.dispose();
        waiter.resolve(current);
      }
    }
  }

  #failPermanently(error: Error): void {
    if (this.#terminalError) return;
    this.#terminalError = error;
    this.#abort.abort();
    this.#rejectWaiters(error);
    notifyError(this.#onFatalError, error);
    this.#resolveClosed();
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters) {
      waiter.dispose();
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

function notifyError(listener: ((error: Error) => void) | undefined, error: Error): void {
  try {
    listener?.(error);
  } catch {
    // Diagnostics cannot invalidate connection recovery.
  }
}

function reconnectDelayMs(
  attempt: number,
  minMs: number,
  maxMs: number,
  random: () => number,
  unstableMaxMs: number,
): number {
  if (attempt <= 0 || minMs === 0) return 0;
  const exponential = minMs * 2 ** Math.min(attempt - 1, 30);
  // maxMs keeps binding until the natural doubling leaves the ceiling band;
  // only a streak that saturates the regular ladder escalates toward
  // unstableMaxMs.
  const ceiling = exponential >= 2 * maxMs ? unstableMaxMs : maxMs;
  const sample = random();
  const bounded = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.min(ceiling, Math.max(1, Math.round(exponential * (0.8 + bounded * 0.4))));
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function requireDelay(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 120_000) {
    throw new RangeError(`${label} must be an integer between 0 and 120000`);
  }
  return value;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
