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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForRuntimeHostReady } from '../client/wait-for-ready.js';
import type { HostStatusResult } from '../protocol/host-status.js';

const status = (state: HostStatusResult['state']): HostStatusResult => ({
  hostEpoch: 'epoch',
  compositionId: 'interactive',
  compositionRevision: '3',
  state,
  connections: 1,
  activeOperations: 0,
  activeResidencies: 0,
});

test('storage conversion can outlast the ordinary readiness budget', async () => {
  let probes = 0;
  const started = Date.now();
  await waitForRuntimeHostReady(
    { status: async () => status(++probes === 1 ? 'upgrading_storage' : 'ready') },
    50,
  );
  assert.ok(Date.now() - started >= 200);
});

test('ordinary recovery retains its bounded readiness budget', async () => {
  await assert.rejects(
    waitForRuntimeHostReady({ status: async () => status('recovering') }, 30),
    /deadline/,
  );
});

test('storage conversion also has a finite readiness budget', async () => {
  await assert.rejects(
    waitForRuntimeHostReady({ status: async () => status('upgrading_storage') }, 50, undefined, {
      storageUpgradeTimeoutMs: 30,
    }),
    /deadline/,
  );
});

test('stops a pending ready probe when its reconnect attempt is cancelled', async () => {
  const started = deferred();
  const never = new Promise<never>(() => undefined);
  const controller = new AbortController();
  const waiting = waitForRuntimeHostReady(
    {
      status: async () => {
        started.resolve();
        return never;
      },
    },
    45_000,
    controller.signal,
  );
  await started.promise;
  const reason = new Error('closed');
  controller.abort(reason);
  await assert.rejects(waiting, (error: unknown) => error === reason);
});
