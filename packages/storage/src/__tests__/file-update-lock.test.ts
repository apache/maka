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

import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { withProcessLifetimeFileUpdateLock } from '../process-lifetime-file-update-lock.js';

test('releases a file update lock when its process is killed', async (t) => {
  await assertKilledHolderCanBeRecovered(t, []);
});

test('recovers a supervised legacy directory lock when its process is killed', async (t) => {
  await assertKilledHolderCanBeRecovered(t, ['legacy']);
});

async function assertKilledHolderCanBeRecovered(
  t: TestContext,
  args: readonly string[],
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-file-update-lock-'));
  const targetPath = join(root, 'state');
  const child = fork(
    new URL('./fixtures/file-update-lock-holder.js', import.meta.url),
    [targetPath, ...args],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    child.once('message', (message) => {
      if (message === 'locked') resolve();
      else reject(new Error(`Unexpected child message: ${String(message)}`));
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`Lock holder exited before acquisition (${String(code)}, ${signal})`));
    });
  });

  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));

  let entered = false;
  await withProcessLifetimeFileUpdateLock(
    targetPath,
    async () => {
      entered = true;
    },
    2_000,
  );
  assert.equal(entered, true);
}
