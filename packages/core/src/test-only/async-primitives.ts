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
 * Async primitives every suite in this repository needs and each one used to
 * define for itself. They carry no product semantics: a test that reaches for
 * them is arranging timing, not asserting behaviour, so a single definition is
 * enough and 66 copies of `deferred` alone were 66 chances to differ on
 * unhandled rejections or timer cleanup.
 */

export interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

/**
 * A promise whose settlement the caller owns. `T` defaults to `void` so
 * `deferred()` keeps the argument-free `resolve()` the void-typed copies used.
 */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Monotonic identifier factory: `nextId()()` yields `id-1`, `id-2`, … */
export function nextId(prefix = 'id'): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

/**
 * Reject with `message` when `promise` outlives `timeoutMs`. The timer is
 * cleared on every outcome, so a settled promise never holds the event loop
 * open — the copies that only unref'd theirs left the timer to expire.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export interface WaitForOptions {
  /** Wall-clock budget. Omit to bound the wait by `attempts` alone. */
  timeoutMs?: number;
  /** Poll-count budget. Omit to bound the wait by `timeoutMs` alone. */
  attempts?: number;
  /** Delay between polls. Omit to yield with `setImmediate` instead. */
  pollMs?: number;
  /** Failure message. */
  message?: string;
}

/**
 * Poll `predicate` until it holds, or throw once the budget is spent.
 *
 * The copies this replaces expressed their budget two ways — a wall-clock
 * deadline or a poll count — and neither is derivable from the other: under
 * load `100 attempts × setImmediate` and `1_000ms` diverge in opposite
 * directions. Both are kept so every call site can pass what it had.
 *
 * The predicate is always evaluated once more before the throw, which is what
 * the copies ending in `assert.ok(predicate())` did. A wait that would have
 * passed under any copy still passes here.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: WaitForOptions = {},
): Promise<void> {
  const { timeoutMs, attempts, pollMs, message = 'condition was not met' } = options;
  const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  const limit = attempts ?? Number.POSITIVE_INFINITY;
  // `await` on a plain boolean still yields a microtask, and for a synchronous
  // predicate that tick is observable: it lets a pending render flush before
  // the result is read, so a TUI wait returns one frame early and the next
  // keystroke lands on a screen that has not settled. A synchronous predicate
  // is therefore read without yielding.
  for (let attempt = 0; attempt < limit && Date.now() < deadline; attempt += 1) {
    const outcome = predicate();
    if (outcome === true || (outcome !== false && (await outcome))) return;
    await (pollMs === undefined
      ? new Promise<void>((resolve) => setImmediate(resolve))
      : new Promise<void>((resolve) => setTimeout(resolve, pollMs)));
  }
  const last = predicate();
  if (last === true || (last !== false && (await last))) return;
  throw new Error(message);
}
