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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createSettingsStore } from '../settings-store.js';
import {
  openStableNativeLockFile,
  tryAcquireNativeFileLock,
  releaseNativeFileLock,
} from '../native-file-lock.js';

test('pet and Desktop settings instances share one read-modify-write authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'settings-pet-race-'));
  try {
    const desktop = createSettingsStore(root),
      pet = createSettingsStore(root);
    await desktop.get();
    await Promise.all([
      pet.update({ personalization: { selectedPetId: 'test.pet', petMode: 'assistant' } }),
      desktop.update({ appearance: { theme: 'dark' } }),
    ]);
    const persisted = await createSettingsStore(root).get();
    assert.equal(persisted.personalization.selectedPetId, 'test.pet');
    assert.equal(persisted.personalization.petMode, 'assistant');
    assert.equal(persisted.appearance.theme, 'dark');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('settings writers respect the cross-process native lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'settings-pet-lock-'));
  try {
    const store = createSettingsStore(root);
    await store.get();
    const lock = await openStableNativeLockFile(join(root, 'settings.json.lock'));
    assert.equal(tryAcquireNativeFileLock(lock), true);
    let completed = false;
    const write = store.update({ appearance: { theme: 'dark' } }).then(() => {
      completed = true;
    });
    try {
      await delay(40);
      assert.equal(completed, false, 'settings mutation must wait for the shared lock');
    } finally {
      releaseNativeFileLock(lock);
      await lock.close();
      await write;
    }
    assert.equal((await store.get()).appearance.theme, 'dark');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a separate Host process waits for the Desktop writer and preserves its patch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'settings-pet-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const desktop = createSettingsStore(root);
  await desktop.update({ appearance: { theme: 'dark' } });
  const lock = await openStableNativeLockFile(join(root, 'settings.json.lock'));
  assert.equal(tryAcquireNativeFileLock(lock), true);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import { createSettingsStore } from ${JSON.stringify(new URL('../settings-store.js', import.meta.url).href)};
    process.send('started');
    await createSettingsStore(${JSON.stringify(root)}).update({personalization:{selectedPetId:'child.pet',petMode:'assistant'}});
    process.send('committed');
    process.disconnect();
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let stderr = '',
    committed = false;
  child.stderr!.on('data', (bytes) => {
    stderr += bytes;
  });
  child.on('message', (message) => {
    if (message === 'committed') committed = true;
  });
  const exit = once(child, 'exit');
  try {
    await once(child, 'message');
    await delay(40);
    assert.equal(committed, false);
  } finally {
    releaseNativeFileLock(lock);
    await lock.close();
  }
  const [code] = await exit;
  assert.equal(code, 0, stderr);
  const saved = await desktop.get();
  assert.equal(saved.personalization.selectedPetId, 'child.pet');
  assert.equal(saved.appearance.theme, 'dark');
});
