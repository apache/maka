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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  startWorkHubCoordinationLifecycle,
  type WorkHubCoordinationHostChange,
} from '../../renderer/workhub-coordination-lifecycle.js';

test('WorkHub resolves on open and ready Host changes, then stops on feature disable', () => {
  let hostChange: ((event: WorkHubCoordinationHostChange) => void) | undefined;
  let availabilityChange: (() => void) | undefined;
  const calls: string[] = [];
  const stop = startWorkHubCoordinationLifecycle({
    resolve: () => {
      calls.push('resolve');
      return Promise.resolve('coordination-session');
    },
    subscribeHostChanges(handler) {
      hostChange = handler;
      return () => calls.push('unsubscribe-hosts');
    },
    subscribeAvailabilityChanges(handler) {
      availabilityChange = handler;
      return () => calls.push('unsubscribe-availability');
    },
    onResolving: () => calls.push('resolving'),
    onResolved: (sessionId) => calls.push(`resolved:${sessionId}`),
    reportFailure: () => calls.push('failure'),
  });

  assert.deepEqual(calls, ['resolving', 'resolve']);
  hostChange?.({ isDefault: false, readiness: 'ready' });
  hostChange?.({ isDefault: true, readiness: 'reconnecting' });
  assert.deepEqual(calls, ['resolving', 'resolve', 'resolving']);

  availabilityChange?.();
  assert.deepEqual(calls, ['resolving', 'resolve', 'resolving']);

  hostChange?.({ isDefault: true, readiness: 'ready' });
  assert.deepEqual(calls, ['resolving', 'resolve', 'resolving', 'resolving', 'resolve']);

  stop();
  assert.deepEqual(calls, [
    'resolving',
    'resolve',
    'resolving',
    'resolving',
    'resolve',
    'unsubscribe-hosts',
    'unsubscribe-availability',
  ]);
  hostChange?.({ isDefault: true, readiness: 'ready' });
  availabilityChange?.();
  assert.equal(calls.at(-1), 'unsubscribe-availability');
});

test('WorkHub reports an unavailable default Host instead of holding the loading state', () => {
  let hostChange: ((event: WorkHubCoordinationHostChange) => void) | undefined;
  let availabilityChange: (() => void) | undefined;
  const calls: string[] = [];
  let manualRetry: (() => void) | undefined;
  const stop = startWorkHubCoordinationLifecycle({
    resolve: () => {
      calls.push('resolve');
      return new Promise<string>(() => undefined);
    },
    subscribeHostChanges(handler) {
      hostChange = handler;
      return () => undefined;
    },
    subscribeAvailabilityChanges(handler) {
      availabilityChange = handler;
      return () => undefined;
    },
    onResolving: () => calls.push('resolving'),
    onResolved: () => calls.push('resolved'),
    reportFailure: (error, retry) => {
      calls.push(`failure:${error instanceof Error ? error.message : String(error)}`);
      manualRetry = retry;
    },
  });

  // Connecting is still on its way to an answer and keeps the loading state.
  hostChange?.({ isDefault: true, readiness: 'connecting' });
  assert.deepEqual(calls, ['resolving', 'resolve', 'resolving']);

  hostChange?.({ isDefault: true, readiness: 'unavailable' });
  assert.deepEqual(calls, [
    'resolving',
    'resolve',
    'resolving',
    'resolving',
    'failure:The default Runtime Host is unavailable',
  ]);

  // A revoked generation that reported a failure stays reopenable, by the
  // Retry control and by an availability change alike.
  availabilityChange?.();
  assert.equal(calls.at(-1), 'resolve');
  hostChange?.({ isDefault: true, readiness: 'unavailable', removed: true });
  assert.equal(calls.at(-1), 'failure:The default Runtime Host is unavailable');
  manualRetry?.();
  assert.equal(calls.at(-1), 'resolve');
  stop();
});

test('WorkHub exposes a retry and automatically retries when model availability changes', async () => {
  let hostChange: ((event: WorkHubCoordinationHostChange) => void) | undefined;
  let availabilityChange: (() => void) | undefined;
  const failures: unknown[] = [];
  let manualRetry: (() => void) | undefined;
  let resolveAttempts = 0;
  const failure = new Error('offline');
  const stop = startWorkHubCoordinationLifecycle({
    resolve: () => {
      resolveAttempts += 1;
      return resolveAttempts < 3
        ? Promise.reject(failure)
        : Promise.resolve('coordination-session');
    },
    subscribeHostChanges(handler) {
      hostChange = handler;
      return () => undefined;
    },
    subscribeAvailabilityChanges(handler) {
      availabilityChange = handler;
      return () => undefined;
    },
    onResolving: () => undefined,
    onResolved: (sessionId) => failures.push(sessionId),
    reportFailure: (error, retry) => {
      failures.push(error);
      manualRetry = retry;
    },
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(failures, [failure]);

  manualRetry?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(failures, [failure, failure]);

  availabilityChange?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(failures, [failure, failure, 'coordination-session']);

  availabilityChange?.();
  hostChange?.({ isDefault: false, readiness: 'ready' });
  assert.equal(resolveAttempts, 3);
  stop();
});

test('WorkHub ignores a stale Host resolution that settles after a newer Host', async () => {
  let hostChange: ((event: WorkHubCoordinationHostChange) => void) | undefined;
  const pending: Array<(sessionId: string) => void> = [];
  const resolved: string[] = [];
  const stop = startWorkHubCoordinationLifecycle({
    resolve: () => new Promise<string>((resolve) => pending.push(resolve)),
    subscribeHostChanges(handler) {
      hostChange = handler;
      return () => undefined;
    },
    subscribeAvailabilityChanges: () => () => undefined,
    onResolving: () => undefined,
    onResolved: (sessionId) => resolved.push(sessionId),
    reportFailure: (error) => assert.fail(error instanceof Error ? error.message : String(error)),
  });

  hostChange?.({ isDefault: true, readiness: 'ready' });
  pending[1]?.('host-b-coordination');
  await Promise.resolve();
  pending[0]?.('host-a-coordination');
  await Promise.resolve();

  assert.deepEqual(resolved, ['host-b-coordination']);
  stop();
});

test('selecting an unready default Host revokes the old scope and invalidates its resolve', async () => {
  let hostChange: ((event: WorkHubCoordinationHostChange) => void) | undefined;
  const pending: Array<(sessionId: string) => void> = [];
  const calls: string[] = [];
  const stop = startWorkHubCoordinationLifecycle({
    resolve: () => new Promise<string>((resolve) => pending.push(resolve)),
    subscribeHostChanges(handler) {
      hostChange = handler;
      return () => undefined;
    },
    subscribeAvailabilityChanges: () => () => undefined,
    onResolving: () => calls.push('revoked'),
    onResolved: (sessionId) => calls.push(`resolved:${sessionId}`),
    reportFailure: (error) => assert.fail(error instanceof Error ? error.message : String(error)),
  });

  hostChange?.({ isDefault: true, readiness: 'reconnecting' });
  pending[0]?.('old-host-coordination');
  await Promise.resolve();

  assert.deepEqual(calls, ['revoked', 'revoked']);
  stop();
});
