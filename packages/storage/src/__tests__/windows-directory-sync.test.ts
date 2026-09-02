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
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncDirectory } from '../stable-storage.js';
import {
  syncWindowsDirectory,
  WINDOWS_DIRECTORY_OPEN_FLAG,
  WINDOWS_DIRECTORY_WRITE_THROUGH_FLAG,
  windowsDirectoryOpenFlags,
} from '../windows-directory-sync.js';

test('windowsDirectoryOpenFlags includes backup semantics and write-through (#3898)', () => {
  const flags = windowsDirectoryOpenFlags();
  assert.equal(
    (flags & WINDOWS_DIRECTORY_OPEN_FLAG) >>> 0,
    WINDOWS_DIRECTORY_OPEN_FLAG,
  );
  assert.equal(
    (flags & WINDOWS_DIRECTORY_WRITE_THROUGH_FLAG) >>> 0,
    WINDOWS_DIRECTORY_WRITE_THROUGH_FLAG,
  );
});

test('syncDirectory synchronizes a directory on POSIX', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-sync-directory-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'payload.txt'), 'data');
  await syncDirectory(directory);
});

test('syncWindowsDirectory flushes a directory handle on Windows', {
  skip: process.platform !== 'win32' ? 'Windows-only directory durability contract' : false,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-win-sync-directory-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'payload.txt'), 'data');
  await syncWindowsDirectory(directory);
  await syncDirectory(directory);
});
