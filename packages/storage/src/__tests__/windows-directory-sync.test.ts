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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncDirectory } from '../stable-storage.js';

async function directoryWithPayload(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'payload.txt'), 'data');
  return directory;
}

test('syncDirectory synchronizes a directory on POSIX', {
  skip: process.platform === 'win32' ? 'POSIX-only path' : false,
}, async (t) => {
  const directory = await directoryWithPayload(t, 'maka-sync-directory-');
  await syncDirectory(directory);
});

test('syncDirectory flushes a directory handle on Windows', {
  skip: process.platform !== 'win32' ? 'Windows-only directory durability contract' : false,
}, async (t) => {
  const directory = await directoryWithPayload(t, 'maka-win-sync-directory-');

  // This is the assertion that the Windows recovery lane actually exercises:
  // `FlushFileBuffers` requires GENERIC_WRITE, so a read-only directory open
  // fails here with EPERM. Reopening read/write must not throw.
  await syncDirectory(directory);

  // The directory entry must survive a flush and stay readable afterwards.
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(directory, 'payload.txt'), 'utf8'), 'data');
});
