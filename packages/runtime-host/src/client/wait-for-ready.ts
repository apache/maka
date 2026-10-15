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

import type { RuntimeHostConnection } from './connection.js';
import type { HostStatusResult } from '../protocol/host-status.js';

export const STORAGE_UPGRADE_READY_TIMEOUT_MS = 30 * 60 * 1000;

export async function waitForRuntimeHostReady(
  connection: Pick<RuntimeHostConnection, 'status'>,
  timeoutMs = 75_000,
  signal?: AbortSignal,
  options: { readonly storageUpgradeTimeoutMs?: number } = {},
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new RangeError('timeoutMs must be an integer between 1 and 120000');
  }
  let normalRemaining = timeoutMs;
  let upgradeRemaining = options.storageUpgradeTimeoutMs ?? STORAGE_UPGRADE_READY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(upgradeRemaining) ||
    upgradeRemaining <= 0 ||
    upgradeRemaining > STORAGE_UPGRADE_READY_TIMEOUT_MS
  )
    throw new RangeError('Invalid storage upgrade readiness timeout');
  let upgrading: boolean = false;
  let measuredAt = Date.now();
  const accountElapsed = () => {
    const now = Date.now();
    const elapsed = Math.max(0, now - measuredAt);
    if (upgrading) upgradeRemaining -= elapsed;
    else normalRemaining -= elapsed;
    measuredAt = now;
  };
  while (true) {
    signal?.throwIfAborted();
    accountElapsed();
    const requestBudget: number = upgrading ? upgradeRemaining : normalRemaining;
    if (requestBudget <= 0)
      throw new Error('Runtime Host did not become ready before the deadline');
    const status: HostStatusResult = await abortable(
      () => connection.status(Math.max(1, Math.min(requestBudget, 5_000))),
      signal,
    );
    accountElapsed();
    if (status.state === 'ready') return;
    if (status.state === 'draining') {
      throw new Error('Runtime Host drained before becoming ready');
    }
    upgrading = status.state === 'upgrading_storage';
    const remaining = upgrading ? upgradeRemaining : normalRemaining;
    if (remaining <= 0) {
      throw new Error('Runtime Host did not become ready before the deadline');
    }
    await abortable(
      () =>
        new Promise((resolve) => setTimeout(resolve, Math.min(upgrading ? 250 : 25, remaining))),
      signal,
    );
  }
}

export function abortable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(signal.reason);
  const running = operation();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    void running.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}
