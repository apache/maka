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

import type {
  HostedExecutionAdmissionResult,
  HostedExecutionAuthority,
  HostedExecutionCompletion,
  HostedExecutionRef,
  HostedExecutionSnapshot,
} from './hosted-execution-authority.js';
import { isHostedExecutionTerminal } from './hosted-execution-authority.js';

type HostedExecutionWaitAuthority = Pick<HostedExecutionAuthority, 'reconcile' | 'subscribe'>;

type HostedExecutionConsumerAuthority = Pick<
  HostedExecutionAuthority,
  'admit' | 'reconcile' | 'subscribe'
>;

/**
 * Waits on notifications only as a wake-up hint and re-reads the canonical
 * execution projection after every wake-up.
 */
export async function waitForHostedExecutionTerminal(
  authority: HostedExecutionWaitAuthority,
  execution: HostedExecutionRef,
  initial: HostedExecutionSnapshot,
  options: {
    readonly completion?: Promise<HostedExecutionCompletion>;
    readonly abortSignal?: AbortSignal;
    readonly onReconciled?: () => void;
  } = {},
): Promise<HostedExecutionSnapshot> {
  const { completion, abortSignal, onReconciled } = options;
  throwIfAborted(abortSignal);
  let wake = deferred();
  const unsubscribe = authority.subscribe((changed) => {
    if (sameExecution(changed, execution)) wake.resolve();
  });
  const onAbort = (): void => wake.resolve();
  abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (abortSignal?.aborted) onAbort();
  try {
    let snapshot = initial;
    while (!isHostedExecutionTerminal(snapshot)) {
      throwIfAborted(abortSignal);
      const observedWake = wake;
      snapshot = await authority.reconcile(execution);
      onReconciled?.();
      if (isHostedExecutionTerminal(snapshot)) break;
      const signal = await Promise.race([
        observedWake.promise.then(() => undefined),
        ...(completion ? [completion] : []),
      ]);
      throwIfAborted(abortSignal);
      if (signal) {
        if (signal.kind === 'authority_error') {
          throw new Error(`Hosted Execution authority failed: ${signal.reason}`);
        }
        return signal.snapshot;
      }
      if (wake === observedWake) wake = deferred();
    }
    return snapshot;
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    unsubscribe();
  }
}

export async function waitForHostedExecutionIdleOrAbort(
  whenIdle: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('Hosted Execution wait was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void whenIdle.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Consumer policy for callers that must retain ownership through Host cleanup. */
export async function executeHostedExecutionToSettlement(
  authority: HostedExecutionConsumerAuthority,
  input: Parameters<HostedExecutionConsumerAuthority['admit']>[0],
): Promise<void> {
  const execution = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.runId,
  };
  const admitted: HostedExecutionAdmissionResult = await authority.admit(input);
  await waitForHostedExecutionTerminal(authority, execution, admitted.snapshot, {
    completion: admitted.completion,
  });
  await admitted.settled;
}

function sameExecution(left: HostedExecutionRef, right: HostedExecutionRef): boolean {
  return (
    left.sessionId === right.sessionId && left.turnId === right.turnId && left.runId === right.runId
  );
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let settled = false;
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Hosted Execution wait was aborted', 'AbortError');
}
