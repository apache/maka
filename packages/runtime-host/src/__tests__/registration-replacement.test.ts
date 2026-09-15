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
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readHostRegistration, writeHostRegistration } from '../control/registration.js';
import {
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostRegistration,
} from '../protocol/index.js';

for (const failure of ['transient', 'persistent', 'unrelated'] as const) {
  test(`registration replacement preserves the old snapshot across ${failure} rename failure`, async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'maka-registration-retry-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const registration: HostRegistration = {
      kind: 'maka-runtime-host',
      schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
      rootId: 'a'.repeat(64),
      hostEpoch: 'registration-test',
      endpoint: 'test-endpoint',
      protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
      protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
      compositionId: 'maka.interactive',
      compositionRevision: '1',
      state: 'ready',
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    await writeHostRegistration(root, registration);
    const originalRename = fs.rename;
    const expected = Object.assign(new Error('injected rename failure'), {
      code: failure === 'unrelated' ? 'ENOSPC' : 'EPERM',
    });
    let calls = 0;
    const replacement = { ...registration, state: 'draining' as const };
    const rename = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      calls++;
      assert.deepEqual(
        await readHostRegistration(root),
        registration,
        'no unlink of the old registration before replacement',
      );
      if (failure !== 'transient' || calls < 3) throw expected;
      return originalRename(...args);
    });
    syncBuiltinESMExports();
    try {
      if (failure === 'transient' && process.platform === 'win32') {
        await writeHostRegistration(root, replacement);
        assert.equal(calls, 3);
        assert.deepEqual(await readHostRegistration(root), replacement);
      } else {
        await assert.rejects(
          writeHostRegistration(root, replacement),
          (error) => error === expected,
        );
        assert.deepEqual(await readHostRegistration(root), registration);
        assert.equal(calls, process.platform === 'win32' && failure === 'persistent' ? 6 : 1);
      }
      assert.deepEqual(await fs.readdir(root), ['registration.json']);
    } finally {
      rename.mock.restore();
      syncBuiltinESMExports();
    }
  });
}
