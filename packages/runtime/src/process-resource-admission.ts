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

export type ProcessResourceAdmissionMode = 'shared' | 'exclusive';
export type ProcessResourceAdmissionState = 'queued' | 'active' | 'released' | 'aborted';

export interface ProcessResourceAdmissionTransition {
  readonly process_admission_mode: ProcessResourceAdmissionMode;
  readonly process_admission_state: ProcessResourceAdmissionState;
  readonly process_admission_sequence: number;
  readonly process_admission_owner_id?: string;
  readonly reused_owner?: boolean;
}

export interface ProcessResourceAdmissionSnapshot {
  readonly queued: readonly {
    readonly sequence: number;
    readonly mode: ProcessResourceAdmissionMode;
  }[];
  readonly activeShared: number;
  readonly activeExclusive: boolean;
}

export interface ProcessResourceAdmissionCoordinator {
  withShared<Result>(
    signal: AbortSignal | undefined,
    effect: () => Promise<Result>,
  ): Promise<Result>;
  withExclusive<Result>(
    signal: AbortSignal | undefined,
    effect: () => Promise<Result>,
  ): Promise<Result>;
  /** Read-only diagnostics; resource identities are deliberately absent. */
  inspect(): ProcessResourceAdmissionSnapshot;
}

export interface ProcessResourceAdmissionCoordinatorOptions {
  /** Best-effort tracing hook. Observer failures never affect correctness. */
  readonly onTransition?: (transition: ProcessResourceAdmissionTransition) => void;
}

type WaiterState = 'queued' | 'active' | 'settled';

interface Waiter<Result> {
  readonly sequence: number;
  readonly mode: ProcessResourceAdmissionMode;
  readonly signal?: AbortSignal;
  readonly effect: () => Promise<Result>;
  state: WaiterState;
  readonly resolve: (value: Result | PromiseLike<Result>) => void;
  readonly reject: (reason?: unknown) => void;
  removeAbortListener?: () => void;
}

interface AdmissionOwner {
  readonly id: string;
  readonly sequence: number;
  readonly mode: ProcessResourceAdmissionMode;
  active: boolean;
  references: number;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

export class ProcessResourceAdmissionUpgradeError extends Error {
  override readonly name = 'ProcessResourceAdmissionUpgradeError';
  readonly code = 'process_admission_upgrade_not_allowed';

  constructor() {
    super('A shared process admission owner cannot be upgraded to exclusive');
  }
}

/**
 * Create a writer-fair FIFO shared/exclusive process admission coordinator.
 * Explicit none() operations do not call this coordinator at all.
 */
export function createProcessResourceAdmissionCoordinator(
  options: ProcessResourceAdmissionCoordinatorOptions = {},
): ProcessResourceAdmissionCoordinator {
  let nextSequence = 0;
  const queued: Waiter<unknown>[] = [];
  const activeShared = new Set<Waiter<unknown>>();
  let activeExclusive: Waiter<unknown> | undefined;
  const ownerStorage = new AsyncLocalStorage<AdmissionOwner>();

  const emit = (transition: ProcessResourceAdmissionTransition): void => {
    try {
      options.onTransition?.(transition);
    } catch {
      // Tracing is observational. It must never strand or reject an admission.
    }
  };

  const withMode = <Result>(
    mode: ProcessResourceAdmissionMode,
    signal: AbortSignal | undefined,
    effect: () => Promise<Result>,
  ): Promise<Result> => {
    // Pre-aborted work never executes, including a compatible reentrant call.
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    const currentOwner = ownerStorage.getStore();
    if (currentOwner?.active) {
      if (currentOwner.mode === 'shared' && mode === 'exclusive') {
        return Promise.reject(new ProcessResourceAdmissionUpgradeError());
      }
      currentOwner.references += 1;
      emit({
        process_admission_mode: mode,
        process_admission_state: 'active',
        process_admission_sequence: currentOwner.sequence,
        process_admission_owner_id: currentOwner.id,
        reused_owner: true,
      });
      return runReentrant(currentOwner, effect);
    }

    let resolve!: (value: Result | PromiseLike<Result>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<Result>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    const waiter: Waiter<Result> = {
      sequence: nextSequence++,
      mode,
      ...(signal ? { signal } : {}),
      effect,
      state: 'queued',
      resolve,
      reject,
    };
    queued.push(waiter as Waiter<unknown>);
    emit({
      process_admission_mode: mode,
      process_admission_state: 'queued',
      process_admission_sequence: waiter.sequence,
    });
    listenForQueuedAbort(waiter);
    drain();
    return result;
  };

  const runReentrant = async <Result>(
    owner: AdmissionOwner,
    effect: () => Promise<Result>,
  ): Promise<Result> => {
    try {
      return await ownerStorage.run(owner, effect);
    } finally {
      releaseOwnerReference(owner);
    }
  };

  const listenForQueuedAbort = <Result>(waiter: Waiter<Result>): void => {
    if (!waiter.signal) return;
    const listener = () => cancelQueued(waiter);
    waiter.signal.addEventListener('abort', listener, { once: true });
    waiter.removeAbortListener = () => waiter.signal?.removeEventListener('abort', listener);
    // Abort dispatch is synchronous, but the signal may have changed between
    // the preflight check and listener registration.
    if (waiter.signal.aborted) cancelQueued(waiter);
  };

  const removeAbortListener = (waiter: Waiter<unknown>): void => {
    waiter.removeAbortListener?.();
    waiter.removeAbortListener = undefined;
  };

  const cancelQueued = <Result>(waiter: Waiter<Result>): void => {
    if (waiter.state !== 'queued') return;
    const index = queued.indexOf(waiter as Waiter<unknown>);
    if (index < 0) return;
    queued.splice(index, 1);
    removeAbortListener(waiter as Waiter<unknown>);
    waiter.state = 'settled';
    emit({
      process_admission_mode: waiter.mode,
      process_admission_state: 'aborted',
      process_admission_sequence: waiter.sequence,
    });
    drain();
    waiter.reject(abortReason(waiter.signal));
  };

  const drain = (): void => {
    if (activeExclusive) return;
    if (activeShared.size > 0) {
      while (!activeExclusive && queued[0]?.mode === 'shared') startHead();
      return;
    }
    if (queued[0]?.mode === 'exclusive') {
      startHead();
      return;
    }
    while (!activeExclusive && queued[0]?.mode === 'shared') startHead();
  };

  const startHead = (): void => {
    const waiter = queued.shift();
    if (!waiter || waiter.state !== 'queued') return;
    if (waiter.signal?.aborted) {
      removeAbortListener(waiter);
      waiter.state = 'settled';
      emit({
        process_admission_mode: waiter.mode,
        process_admission_state: 'aborted',
        process_admission_sequence: waiter.sequence,
      });
      drain();
      waiter.reject(abortReason(waiter.signal));
      return;
    }
    removeAbortListener(waiter);
    waiter.state = 'active';
    if (waiter.mode === 'shared') activeShared.add(waiter);
    else activeExclusive = waiter;

    const owner = createOwner(waiter);
    emit({
      process_admission_mode: waiter.mode,
      process_admission_state: 'active',
      process_admission_sequence: waiter.sequence,
      process_admission_owner_id: owner.id,
    });
    void runActive(waiter, owner);
  };

  const runActive = async (waiter: Waiter<unknown>, owner: AdmissionOwner): Promise<void> => {
    let outcome: PromiseSettledResult<unknown>;
    try {
      const value = await ownerStorage.run(owner, waiter.effect);
      outcome = { status: 'fulfilled', value };
    } catch (reason) {
      outcome = { status: 'rejected', reason };
    } finally {
      releaseOwnerReference(owner);
    }

    // A root effect can start nested work without awaiting it. Keep the root
    // holder active until every nested owner reference has really settled.
    await owner.settled;
    finishActive(waiter, owner, outcome);
  };

  const finishActive = (
    waiter: Waiter<unknown>,
    owner: AdmissionOwner,
    outcome: PromiseSettledResult<unknown>,
  ): void => {
    if (waiter.mode === 'shared') activeShared.delete(waiter);
    else if (activeExclusive === waiter) activeExclusive = undefined;
    waiter.state = 'settled';
    emit({
      process_admission_mode: waiter.mode,
      process_admission_state: 'released',
      process_admission_sequence: waiter.sequence,
      process_admission_owner_id: owner.id,
    });
    // Release, then offer the queue one drain opportunity, then settle the
    // outward promise. Callers can never observe settlement while still held.
    drain();
    if (outcome.status === 'fulfilled') waiter.resolve(outcome.value);
    else waiter.reject(outcome.reason);
  };

  const createOwner = (waiter: Waiter<unknown>): AdmissionOwner => {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return {
      id: `process-admission-${waiter.sequence}`,
      sequence: waiter.sequence,
      mode: waiter.mode,
      active: true,
      references: 1,
      settled,
      settle,
    };
  };

  const releaseOwnerReference = (owner: AdmissionOwner): void => {
    if (!owner.active || owner.references <= 0) return;
    owner.references -= 1;
    if (owner.references !== 0) return;
    // Flip active before resolving so stale AsyncLocalStorage descendants
    // cannot reuse this owner after its last real effect completed.
    owner.active = false;
    owner.settle();
  };

  return {
    withShared: (signal, effect) => withMode('shared', signal, effect),
    withExclusive: (signal, effect) => withMode('exclusive', signal, effect),
    inspect: () => ({
      queued: queued.map(({ sequence, mode }) => ({ sequence, mode })),
      activeShared: activeShared.size,
      activeExclusive: activeExclusive !== undefined,
    }),
  };
}

function abortReason(signal: AbortSignal | undefined): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  return Object.assign(new Error('Process resource admission was aborted before it started'), {
    name: 'AbortError',
  });
}

/** One process lifetime owner shared by every production Runtime Host path. */
export const processResourceAdmissions = createProcessResourceAdmissionCoordinator();
