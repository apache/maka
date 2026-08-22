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
 * DeliveryAckQueue — single-consumer FIFO with per-entry delivery acknowledgement.
 *
 * Contract difference vs ./async-queue.ts:
 * - `push(value)` returns `Promise<void>` that resolves ONLY when the consumer
 *   has yielded the value (backpressure). The consumer's `for await` loop
 *   drives the resolution via the finally-block in consume().
 * - No pushedCount/consumedCount counters or waitForProgress() — this queue
 *   does not track progress; it only ensures ordered delivery.
 * - `fail(error: unknown)` accepts any error type (not just Error).
 *
 * Use case: runtime-kernel's SessionEvent stream, where each event must be
 * fully processed (written to the run ledger) before the next is enqueued.
 */

export class DeliveryAckQueueClosed extends Error {
  constructor() {
    super('Delivery ack queue closed');
    this.name = 'DeliveryAckQueueClosed';
  }
}

export function isDeliveryAckQueueClosed(error: unknown): boolean {
  return error instanceof DeliveryAckQueueClosed;
}

interface DeliveryAckQueueEntry<T> {
  value: T;
  delivered: () => void;
  rejected: (error: unknown) => void;
}

export class DeliveryAckQueue<T> implements AsyncIterable<T> {
  private readonly values: Array<DeliveryAckQueueEntry<T>> = [];
  private readonly waiters: Array<{
    resolve: (entry: DeliveryAckQueueEntry<T> | undefined) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.consume()[Symbol.asyncIterator]();
  }

  push(value: T): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new DeliveryAckQueueClosed());
    return new Promise<void>((resolve, reject) => {
      const entry = { value, delivered: resolve, rejected: reject };
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(entry);
        return;
      }
      this.values.push(entry);
    });
  }

  fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error;
    for (const value of this.values.splice(0)) value.rejected(error);
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const closed = new DeliveryAckQueueClosed();
    for (const value of this.values.splice(0)) value.rejected(closed);
    for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined);
  }

  private async *consume(): AsyncIterable<T> {
    while (true) {
      const entry = await this.nextEntry();
      if (!entry) return;
      try {
        yield entry.value;
      } finally {
        entry.delivered();
      }
    }
  }

  private nextEntry(): Promise<DeliveryAckQueueEntry<T> | undefined> {
    if (this.values.length > 0) {
      const next = this.values.shift()!;
      return Promise.resolve(next);
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise<DeliveryAckQueueEntry<T> | undefined>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}
