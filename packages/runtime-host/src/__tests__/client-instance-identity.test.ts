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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadOrCreateRuntimeHostClientInstanceId } from '../client/index.js';

test('Client instance identity converges across concurrent startup and survives restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-host-client-identity-'));
  const path = join(root, 'profile', 'runtime-host-client.json');
  try {
    const identities = await Promise.all(
      Array.from({ length: 8 }, () => loadOrCreateRuntimeHostClientInstanceId(path)),
    );
    assert.equal(new Set(identities).size, 1);
    assert.equal(await loadOrCreateRuntimeHostClientInstanceId(path), identities[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Client instance identity rejects an invalid persisted document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-host-client-identity-invalid-'));
  const path = join(root, 'runtime-host-client.json');
  try {
    await writeFile(path, '{"schemaVersion":1,"clientInstanceId":""}\n');
    await assert.rejects(loadOrCreateRuntimeHostClientInstanceId(path), /Invalid clientInstanceId/);
    assert.equal(await readFile(path, 'utf8'), '{"schemaVersion":1,"clientInstanceId":""}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
