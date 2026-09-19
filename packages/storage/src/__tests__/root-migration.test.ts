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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  resolveStorageRoot,
  resolveStorageRootIdentity,
  tryAcquireStateRootOwner,
} from '../root-authority.js';

test('fresh roots acquire and reopen without an account home', async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), 'maka-root-no-home-'));
  t.mock.method(os, 'userInfo', () => {
    throw new Error('Account home unavailable');
  });
  syncBuiltinESMExports();
  try {
    const identity = await resolveStorageRootIdentity({ path: root, kind: 'interactive' });
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    assert.equal(identity.rootId, capability.rootId);
    await assert.rejects(tryAcquireStateRootOwner(identity as typeof capability));
    const first = await tryAcquireStateRootOwner(capability);
    assert.ok(first);
    await writeFile(join(first.hostDataDirectory, 'settings.json'), '{"kept":true}');
    await rm(first.controlDirectory, { recursive: true, force: true });
    assert.equal(await tryAcquireStateRootOwner(capability), undefined);
    await first.close();
    const second = await tryAcquireStateRootOwner(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    assert.ok(second);
    assert.equal(
      await readFile(join(second.hostDataDirectory, 'settings.json'), 'utf8'),
      '{"kept":true}',
    );
    await second.close();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
