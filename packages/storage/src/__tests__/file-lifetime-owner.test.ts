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
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tryAcquireFileLifetimeOwner } from '../file-lifetime-owner.js';

test('a file lifetime owner fails closed and recovers after owner death', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-file-lifetime-owner-'));
  const path = join(root, 'nested', 'publication.lease');
  const holder = fork(
    new URL('./fixtures/file-lifetime-owner-holder.js', import.meta.url),
    [path],
    {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  t.after(async () => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    holder.once('message', (message) => {
      if (message === 'owned') resolve();
      else reject(new Error(`Unexpected file owner message: ${String(message)}`));
    });
    holder.once('error', reject);
    holder.once('exit', (code, signal) => {
      reject(new Error(`File owner exited before acquisition (${String(code)}, ${signal})`));
    });
  });

  assert.equal(await tryAcquireFileLifetimeOwner(path), undefined);

  holder.kill('SIGKILL');
  await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
  const successor = await tryAcquireFileLifetimeOwner(path);
  assert.ok(successor);
  await Promise.all([successor.close(), successor.close()]);
});
