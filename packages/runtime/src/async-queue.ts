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

/**
 * AsyncEventQueue — single-producer, single-consumer FIFO with async iteration.
 *
 * Use case: backends (AiSdkBackend / FakeBackend) need to surface
 * events from multiple internal callsites — the SDK stream loop AND the
 * `canUseTool` callback that fires in parallel from the SDK subprocess.
 * Both callsites push into the same queue; `send()` returns the queue's
 * async iterator so the SessionManager can drain in order.
 *
 * Semantics:
 * - `push(item)` is non-blocking; resolves the next waiter or buffers.
 * - `close()` signals end-of-stream; the iterator drains buffered items then
 *   completes.
 * - `error(err)` rejects the next/current waiter and marks the queue errored;
 *   subsequent `next()` calls re-throw.
 * - One consumer only. Multiple consumers will race on `next()`.
 *
 * Seq-ack boundary: the consumer loop acks each event AFTER fully processing it
 * via `ackConsumed()` (see AiSdkBackend.drain — the generator's pull IS the
 * ack). Producers use `pushAndWaitUntilConsumed()` for one exact event, or
 * `waitUntilConsumedThroughCurrent()` for everything already enqueued. Both are
 * event-driven and fail closed if the consumer detaches or the queue errors
 * before the boundary is consumed.
 */

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private waiters: Array<{
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: Error) => void;
  }> = [];
  private closed = false;
  private err: Error | null = null;
  /** Monotonic count of events accepted by push(). */
  pushedCount = 0;
  /** Monotonic count of events the consumer has fully processed. */
  consumedCount = 0;
  /** Set when the consumer abandoned the stream; progress waiters must not block on it. */
  consumerDetached = false;
  private progressWaiters: Array<() => void> = [];

  push(item: T): void {
    if (!this.canEnqueue()) return;
    this.enqueue(item);
  }

  /**
   * Enqueue one item and resolve only after the consumer has fully processed
   * that exact sequence. Unlike `push()`, an enqueue rejected by queue state is
   * observable by the producer.
   */
  pushAndWaitUntilConsumed(item: T): Promise<void> {
    if (this.err) return Promise.reject(this.err);
    if (this.consumerDetached) return Promise.reject(consumerDetachedError());
    if (this.closed) return Promise.reject(queueClosedError());
    const sequence = this.enqueue(item);
    return this.waitUntilConsumed(sequence);
  }

  /**
   * Wait through the producer boundary captured at call time. Items enqueued
   * later do not extend the wait.
   */
  waitUntilConsumedThroughCurrent(): Promise<void> {
    return this.waitUntilConsumed(this.pushedCount);
  }

  private canEnqueue(): boolean {
    return !this.closed && !this.err && !this.consumerDetached;
  }

  private enqueue(item: T): number {
    const sequence = ++this.pushedCount;
    const w = this.waiters.shift();
    if (w) {
      w.resolve({ value: item, done: false });
    } else {
      this.buf.push(item);
    }
    this.wake();
    return sequence;
  }

  private async waitUntilConsumed(sequence: number): Promise<void> {
    while (this.consumedCount < sequence) {
      if (this.err) throw this.err;
      if (this.consumerDetached) throw consumerDetachedError();
      await this.waitForProgress();
    }
  }

  /** Consumer-side ack: one event has been fully processed (not just received). */
  ackConsumed(): void {
    this.consumedCount += 1;
    this.wake();
  }

  /** The consumer stopped pulling; wake waiters so they can observe it. */
  noteConsumerDetached(): void {
    if (this.consumerDetached) return;
    this.consumerDetached = true;
    this.wake();
  }

  /** Resolves on the next push/ack/close/error/wake — a condition-variable wait. */
  waitForProgress(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.progressWaiters.push(resolve);
    });
  }

  /** Wake all progress waiters so they re-check their condition. */
  wake(): void {
    if (this.progressWaiters.length === 0) return;
    const waiters = this.progressWaiters;
    this.progressWaiters = [];
    for (const resolve of waiters) resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.resolve({ value: undefined as unknown as T, done: true });
    }
    this.wake();
  }

  error(err: Error): void {
    if (this.closed) return;
    this.err = err;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.reject(err);
    }
    this.wake();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.err) return Promise.reject(this.err);
        const item = this.buf.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
    };
  }
}

function queueClosedError(): Error {
  return new Error('cannot enqueue: async event queue is closed');
}

function consumerDetachedError(): Error {
  return new Error('event consumer detached before the queue boundary was consumed');
}
