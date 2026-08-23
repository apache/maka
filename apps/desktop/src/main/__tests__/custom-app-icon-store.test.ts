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
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  customAppIconDirectory,
  listCustomAppIconIds,
  removeCustomAppIcon,
  resolveCustomAppIconPath,
} from '../custom-app-icon-store.js';

const ID = 'a'.repeat(32);

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'maka-icon-'));
}

test('an imported id resolves inside the directory the app owns', () => {
  assert.equal(
    resolveCustomAppIconPath('/user-data', ID),
    join('/user-data', 'app-icons', `${ID}.png`),
  );
});

/**
 * The id IS the file name, so this is the boundary that decides whether a
 * settings file can name a path. Core normalizes the same shape, but a second
 * gate here is what makes the store safe to call from anywhere.
 */
test('an id that is not 32 hex characters never reaches the filesystem', () => {
  for (const bad of [
    '../../../etc/passwd',
    `..${'a'.repeat(30)}`,
    'A'.repeat(32),          // uppercase is outside the generated alphabet
    'a'.repeat(31),
    'a'.repeat(33),
    '',
    'a/b',
  ]) {
    assert.throws(() => resolveCustomAppIconPath('/user-data', bad), /custom icon id/);
  }
});

test('listing reports imported ids and ignores everything else in the directory', async () => {
  const root = await scratch();
  const dir = customAppIconDirectory(root);
  await mkdir(dir, { recursive: true });
  const other = 'b'.repeat(32);
  await writeFile(join(dir, `${ID}.png`), 'x');
  await writeFile(join(dir, `${other}.png`), 'x');
  // Neither of these is artwork this store wrote, so neither may be offered.
  await writeFile(join(dir, 'notes.txt'), 'x');
  await writeFile(join(dir, 'not-an-id.png'), 'x');

  assert.deepEqual(await listCustomAppIconIds(root), [ID, other].sort());
});

test('listing an app that never imported anything is empty, not an error', async () => {
  assert.deepEqual(await listCustomAppIconIds(await scratch()), []);
});

test('removing is idempotent, so a double click cannot fail the second time', async () => {
  const root = await scratch();
  await mkdir(customAppIconDirectory(root), { recursive: true });
  await writeFile(resolveCustomAppIconPath(root, ID), 'x');

  await removeCustomAppIcon({ id: ID, userDataPath: root });
  await removeCustomAppIcon({ id: ID, userDataPath: root });
  assert.deepEqual(await readdir(customAppIconDirectory(root)), []);
});
