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

import { scopedKeysOverlap } from './preparation/claims.js';

export type FilesystemLeaseMode = 'read' | 'write';
export type FilesystemLeaseScope = 'exact' | 'tree';

export interface FilesystemLeaseRequest {
  /** Platform-normalized coordination key. This is not a backend path. */
  readonly key: string;
  readonly mode: FilesystemLeaseMode;
  readonly scope: FilesystemLeaseScope;
}

export interface FilesystemLeaseCoordinator {
  withLease<Result>(
    request: FilesystemLeaseRequest,
    signal: AbortSignal | undefined,
    effect: () => Promise<Result>,
  ): Promise<Result>;

  withLeases<Result>(
    requests: readonly FilesystemLeaseRequest[],
    signal: AbortSignal | undefined,
    effect: () => Promise<Result>,
  ): Promise<Result>;
}

type WaiterState = 'queued' | 'active' | 'settled';

interface Waiter<Result> {
  readonly sequence: number;
  readonly requests: readonly FilesystemLeaseRequest[];
  readonly signal?: AbortSignal;
  readonly effect: () => Promise<Result>;
  state: WaiterState;
  resolve(value: Result): void;
  reject(error: unknown): void;
  removeAbortListener?: () => void;
}

export function filesystemLeaseRequestsConflict(
  a: FilesystemLeaseRequest,
  b: FilesystemLeaseRequest,
): boolean {
  if (a.mode !== 'write' && b.mode !== 'write') return false;
  return scopedKeysOverlap(a.key, a.scope, b.key, b.scope);
}

export function filesystemLeaseRequestSetsConflict(
  a: readonly FilesystemLeaseRequest[],
  b: readonly FilesystemLeaseRequest[],
): boolean {
  return a.some((left) => b.some((right) => filesystemLeaseRequestsConflict(left, right)));
}

export function normalizeFilesystemLeaseRequests(
  requests: readonly FilesystemLeaseRequest[],
): readonly FilesystemLeaseRequest[] {
  const unique = new Map<string, FilesystemLeaseRequest>();
  for (const request of requests) {
    if (request.key.length === 0) throw new Error('Filesystem lease key must not be empty.');
    const identity = `${request.key}\u0000${request.mode}\u0000${request.scope}`;
    if (!unique.has(identity)) unique.set(identity, Object.freeze({ ...request }));
  }
  return Object.freeze(
    [...unique.values()].sort(
      (a, b) =>
        compareStrings(a.key, b.key) ||
        compareStrings(a.mode, b.mode) ||
        compareStrings(a.scope, b.scope),
    ),
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function createFilesystemLeaseCoordinator(): FilesystemLeaseCoordinator {
  let nextSequence = 0;
  const queued: Waiter<unknown>[] = [];
  const active = new Set<Waiter<unknown>>();

  const removeQueued = (waiter: Waiter<unknown>): void => {
    const index = queued.indexOf(waiter);
    if (index >= 0) queued.splice(index, 1);
  };

  const drain = (): void => {
    for (const candidate of [...queued]) {
      if (candidate.state !== 'queued') continue;
      const conflictsWithActive = [...active].some((current) =>
        filesystemLeaseRequestSetsConflict(current.requests, candidate.requests),
      );
      if (conflictsWithActive) continue;
      const conflictsWithEarlier = queued.some(
        (earlier) =>
          earlier !== candidate &&
          earlier.state === 'queued' &&
          earlier.sequence < candidate.sequence &&
          filesystemLeaseRequestSetsConflict(earlier.requests, candidate.requests),
      );
      if (conflictsWithEarlier) continue;

      removeQueued(candidate);
      if (candidate.signal?.aborted) {
        candidate.removeAbortListener?.();
        candidate.removeAbortListener = undefined;
        candidate.state = 'settled';
        candidate.reject(abortReason(candidate.signal));
        continue;
      }

      candidate.state = 'active';
      active.add(candidate);
      candidate.removeAbortListener?.();
      candidate.removeAbortListener = undefined;
      void Promise.resolve()
        .then(candidate.effect)
        .then(
          (value) => settle(candidate, { status: 'fulfilled', value }),
          (reason: unknown) => settle(candidate, { status: 'rejected', reason }),
        );
    }
  };

  const settle = <Result>(waiter: Waiter<Result>, outcome: PromiseSettledResult<Result>): void => {
    active.delete(waiter as Waiter<unknown>);
    waiter.removeAbortListener?.();
    waiter.removeAbortListener = undefined;
    waiter.state = 'settled';
    drain();
    if (outcome.status === 'fulfilled') waiter.resolve(outcome.value);
    else waiter.reject(outcome.reason);
  };

  const withLeases = <Result>(
    requests: readonly FilesystemLeaseRequest[],
    signal: AbortSignal | undefined,
    effect: () => Promise<Result>,
  ): Promise<Result> => {
    signal?.throwIfAborted();
    const normalized = normalizeFilesystemLeaseRequests(requests);
    if (normalized.length === 0) return Promise.resolve().then(effect);

    return new Promise<Result>((resolve, reject) => {
      const waiter: Waiter<Result> = {
        sequence: nextSequence++,
        requests: normalized,
        ...(signal ? { signal } : {}),
        effect,
        state: 'queued',
        resolve,
        reject,
      };
      if (signal) {
        const onAbort = (): void => {
          if (waiter.state !== 'queued') return;
          removeQueued(waiter as Waiter<unknown>);
          waiter.removeAbortListener?.();
          waiter.removeAbortListener = undefined;
          waiter.state = 'settled';
          drain();
          waiter.reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
      queued.push(waiter as Waiter<unknown>);
      drain();
    });
  };

  return {
    withLease(request, signal, effect) {
      return withLeases([request], signal, effect);
    },
    withLeases,
  };
}

/** Default namespace shared by every builtin filesystem owner in this process. */
export const processFilesystemLeases = createFilesystemLeaseCoordinator();
