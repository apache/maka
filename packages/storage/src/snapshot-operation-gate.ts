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

import { AsyncLocalStorage } from 'node:async_hooks';

/** Normal operations remain concurrent; an explicit snapshot drains and fences them. */
export class SnapshotOperationGate {
  readonly #active = new Set<Promise<unknown>>();
  readonly #context = new AsyncLocalStorage<{ active: boolean }>();
  #barrier: Promise<void> | undefined;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#context.getStore()?.active) return operation();
    const barrier = this.#barrier;
    const task = barrier ? barrier.then(operation) : operation();
    return this.#track(task);
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#context.getStore()?.active) {
      return Promise.reject(new Error('Cannot nest an execution snapshot boundary'));
    }
    // Register the barrier synchronously, before draining existing operations.
    const previous = [...this.#active];
    const precedingBarrier = this.#barrier;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#barrier = barrier;
    const task = (async () => {
      await precedingBarrier;
      await Promise.allSettled(previous);
      const context = { active: true };
      try {
        return await this.#context.run(context, operation);
      } finally {
        context.active = false;
        release();
        if (this.#barrier === barrier) this.#barrier = undefined;
      }
    })();
    return this.#track(task);
  }

  #track<T>(task: Promise<T>): Promise<T> {
    this.#active.add(task);
    void task.finally(() => this.#active.delete(task)).catch(() => {});
    return task;
  }
}
