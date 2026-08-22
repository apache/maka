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

type CompletionOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: unknown };

type CompletionWaiter<T> = (outcome: CompletionOutcome<T>) => void;

export type CompletionWaitResult = 'settled' | 'delay' | 'abort';
export type CompletionSignalWaitResult = Exclude<CompletionWaitResult, 'delay'>;

/** A deferred completion whose bounded waits can detach before it settles. */
export class CompletionLatch<T> {
  private readonly waiters = new Set<CompletionWaiter<T>>();
  private outcome: CompletionOutcome<T> | undefined;

  resolve(value: T): void {
    this.settle({ status: 'fulfilled', value });
  }

  reject(error: unknown): void {
    this.settle({ status: 'rejected', error });
  }

  join(): Promise<T> {
    if (this.outcome) return outcomeValue(this.outcome);
    return new Promise<T>((resolve, reject) => {
      this.waiters.add((outcome) => {
        if (outcome.status === 'fulfilled') resolve(outcome.value);
        else reject(outcome.error);
      });
    });
  }

  wait(delayMs: number, signal?: AbortSignal): Promise<CompletionWaitResult> {
    return this.waitInternal(delayMs, signal);
  }

  waitFor(signal?: AbortSignal): Promise<CompletionSignalWaitResult> {
    return this.waitInternal(undefined, signal);
  }

  private waitInternal(
    delayMs: undefined,
    signal?: AbortSignal,
  ): Promise<CompletionSignalWaitResult>;
  private waitInternal(delayMs: number, signal?: AbortSignal): Promise<CompletionWaitResult>;
  private waitInternal(
    delayMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<CompletionWaitResult> {
    if (this.outcome) return outcomeResult(this.outcome);
    if (signal?.aborted) return Promise.resolve('abort');

    return new Promise<CompletionWaitResult>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.delete(onCompletion);
      };
      const complete = (result: CompletionWaitResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = () => complete('abort');
      const onCompletion: CompletionWaiter<T> = (outcome) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (outcome.status === 'fulfilled') resolve('settled');
        else reject(outcome.error);
      };
      if (delayMs !== undefined) timer = setTimeout(() => complete('delay'), delayMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(onCompletion);
    });
  }

  private settle(outcome: CompletionOutcome<T>): void {
    if (this.outcome) return;
    this.outcome = outcome;
    for (const waiter of this.waiters) waiter(outcome);
    this.waiters.clear();
  }
}

function outcomeValue<T>(outcome: CompletionOutcome<T>): Promise<T> {
  return outcome.status === 'fulfilled'
    ? Promise.resolve(outcome.value)
    : Promise.reject(outcome.error);
}

function outcomeResult<T>(outcome: CompletionOutcome<T>): Promise<CompletionWaitResult> {
  return outcome.status === 'fulfilled'
    ? Promise.resolve('settled')
    : Promise.reject(outcome.error);
}
