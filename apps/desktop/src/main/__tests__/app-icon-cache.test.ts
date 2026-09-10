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
import { windowsTaskbarIconCachePath, writeWindowsTaskbarIconCache } from '../app-icon-cache.js';

test('the rebuilt taskbar icon lands where Windows is told to look', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-app-icon-'));
  try {
    // The encoded ICO, whatever it holds: this is about the path handed to
    // Electron and the bytes reaching that path, not about the container.
    const bytes = Buffer.from([0, 1, 2, 3]);
    const path = writeWindowsTaskbarIconCache(root, bytes);
    assert.equal(path, join(root, 'app-icon-cache', 'taskbar.ico'));
    assert.equal(path, windowsTaskbarIconCachePath(root));
    assert.ok(path, 'a writable cache has to name the file it wrote');
    assert.deepEqual(await readFile(path), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unwritable cache reports back instead of naming a broken file', async (t) => {
  const reported = t.mock.method(console, 'error', () => undefined);
  const root = await mkdtemp(join(tmpdir(), 'maka-app-icon-'));
  try {
    // A file where the cache directory has to go, so `mkdir` cannot make it.
    await writeFile(join(root, 'app-icon-cache'), 'in the way');

    // null and not a path: the caller's fallback is the PNG master, and a
    // taskbar on the packaged tile beats an icon that decodes to nothing.
    assert.equal(writeWindowsTaskbarIconCache(root, Buffer.from([0])), null);
    assert.equal(
      reported.mock.callCount(),
      1,
      'a cache failure has to be reported, not swallowed into a silent null',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
