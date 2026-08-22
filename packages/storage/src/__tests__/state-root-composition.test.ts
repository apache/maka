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
import { resolveStorageRoot, tryAcquireStateRootOwner } from '../root-authority.js';
import {
  bindStateRootComposition,
  STATE_ROOT_COMPOSITION_FILE,
  StateRootCompositionError,
} from '../state-root-composition.js';

test('State Root composition binding is durable, idempotent, and exclusive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-state-root-composition-'));
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireStateRootOwner(capability);
    assert.ok(owner);
    try {
      await bindStateRootComposition(owner.lease, 'maka.interactive');
      const first = await readFile(join(root, STATE_ROOT_COMPOSITION_FILE), 'utf8');
      await bindStateRootComposition(owner.lease, 'maka.interactive');
      assert.equal(await readFile(join(root, STATE_ROOT_COMPOSITION_FILE), 'utf8'), first);
      await assert.rejects(
        () => bindStateRootComposition(owner.lease, 'maka.batch-test'),
        (error: unknown) =>
          error instanceof StateRootCompositionError && error.code === 'composition_mismatch',
      );
    } finally {
      await owner.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('State Root composition binding rejects a corrupt existing authority record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-state-root-composition-corrupt-'));
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireStateRootOwner(capability);
    assert.ok(owner);
    try {
      await writeFile(
        join(root, STATE_ROOT_COMPOSITION_FILE),
        '{"schemaVersion":1,"compositionId":"maka.interactive","extra":true}\n',
      );
      await assert.rejects(
        () => bindStateRootComposition(owner.lease, 'maka.interactive'),
        (error: unknown) =>
          error instanceof StateRootCompositionError && error.code === 'invalid_composition',
      );
    } finally {
      await owner.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
