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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
} from '@maka/storage/root-authority';
import { forceTerminateRegisteredRuntimeHostWithDependencies } from '../client/registered-host-termination.js';
import { writeHostRegistration } from '../control/registration.js';
import {
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostRegistration,
} from '../protocol/index.js';

test('forced termination remains bound to the registered Host identity', async (t) => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-host-termination-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const capability = await resolveStorageRoot({ path: rootPath, kind: 'interactive' });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const identity = {
    rootPath,
    rootId: capability.rootId,
    hostEpoch: 'expected-epoch',
    pid: 4242,
  };
  const registration: HostRegistration = {
    kind: 'maka-runtime-host',
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId: capability.rootId,
    hostEpoch: identity.hostEpoch,
    endpoint: join(rootPath, 'runtime-host.sock'),
    protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
    protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: 'maka.interactive',
    compositionRevision: 'test',
    lifecycleMode: 'ephemeral',
    state: 'ready',
    pid: identity.pid,
    createdAt: new Date(0).toISOString(),
  };
  let alive = true;
  let terminated = 0;
  let replaceBeforeSignal = false;
  let stillOwnsProcess = true;
  let releaseOwnershipBeforeSignal = false;
  const dependencies = {
    isProcessAlive: () => alive,
    settleMs: 0,
    terminateProcess: async (options: { beforeSignal?: () => boolean | Promise<boolean> }) => {
      if (replaceBeforeSignal) {
        await writeHostRegistration(controlDirectory, { ...registration, hostEpoch: 'successor' });
      }
      if (releaseOwnershipBeforeSignal) stillOwnsProcess = false;
      if (options.beforeSignal && !(await options.beforeSignal())) return false;
      terminated += 1;
      alive = false;
      return true;
    },
  };

  await writeHostRegistration(controlDirectory, registration);
  replaceBeforeSignal = true;
  assert.equal(
    await forceTerminateRegisteredRuntimeHostWithDependencies(
      identity,
      () => stillOwnsProcess,
      dependencies,
    ),
    false,
  );
  assert.equal(terminated, 0);

  await writeHostRegistration(controlDirectory, registration);
  replaceBeforeSignal = false;
  releaseOwnershipBeforeSignal = true;
  assert.equal(
    await forceTerminateRegisteredRuntimeHostWithDependencies(
      identity,
      () => stillOwnsProcess,
      dependencies,
    ),
    false,
  );
  assert.equal(terminated, 0);

  stillOwnsProcess = true;
  releaseOwnershipBeforeSignal = false;
  assert.equal(
    await forceTerminateRegisteredRuntimeHostWithDependencies(
      identity,
      () => stillOwnsProcess,
      dependencies,
    ),
    true,
  );
  assert.equal(terminated, 1);
});
