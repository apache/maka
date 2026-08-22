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
import { afterEach, test } from 'node:test';
import {
  defaultRuntimeHostDiagnosticTarget,
  runIfDefaultRuntimeHostCurrent,
  runOnDefaultRuntimeHost,
} from '../../renderer/default-runtime-host-operation.js';

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test('binds a default Host operation and its diagnostics to one authoritative identity', async () => {
  const host = { profileId: 'profile-b', hostId: 'host-b' };
  (globalThis as { window?: unknown }).window = {
    maka: {
      runtimeHostProfiles: {
        getDefaultHost: async () => host,
      },
    },
  };
  let operatedOn: unknown;
  const error = await runOnDefaultRuntimeHost(async (boundHost) => {
    operatedOn = boundHost;
    throw new Error('Host B failed');
  }).catch((caught: unknown) => caught);

  assert.deepEqual(operatedOn, host);
  assert.equal(error instanceof Error ? error.message : '', 'Host B failed');
  assert.deepEqual(defaultRuntimeHostDiagnosticTarget(error), { profileId: 'profile-b' });
});

test('does not invent Host authority when resolving the default Host fails', async () => {
  (globalThis as { window?: unknown }).window = {
    maka: {
      runtimeHostProfiles: {
        getDefaultHost: async () => {
          throw new Error('No default Host');
        },
      },
    },
  };
  const error = await runOnDefaultRuntimeHost(async () => undefined).catch(
    (caught: unknown) => caught,
  );

  assert.equal(defaultRuntimeHostDiagnosticTarget(error), undefined);
});

test('discards a projection completion from a Host that is no longer the default', async () => {
  const hostA = { profileId: 'profile-a', hostId: 'host-a' };
  const hostB = { profileId: 'profile-b', hostId: 'host-b' };
  let defaultHost = hostA;
  (globalThis as { window?: unknown }).window = {
    maka: {
      runtimeHostProfiles: {
        getDefaultHost: async () => defaultHost,
      },
    },
  };
  let markAStarted!: () => void;
  const aStarted = new Promise<void>((resolve) => {
    markAStarted = resolve;
  });
  let resolveA!: (value: string) => void;
  const aResult = new Promise<string>((resolve) => {
    resolveA = resolve;
  });
  const committed: string[] = [];

  const pendingA = runOnDefaultRuntimeHost(async () => {
    markAStarted();
    return aResult;
  }).then((result) =>
    runIfDefaultRuntimeHostCurrent(result.host, () => {
      committed.push(result.value);
    }),
  );
  await aStarted;

  defaultHost = hostB;
  const resultB = await runOnDefaultRuntimeHost(async () => 'Host B');
  assert.equal(
    await runIfDefaultRuntimeHostCurrent(resultB.host, () => {
      committed.push(resultB.value);
    }),
    true,
  );

  resolveA('Host A');
  assert.equal(await pendingA, false);
  assert.deepEqual(committed, ['Host B']);
});
