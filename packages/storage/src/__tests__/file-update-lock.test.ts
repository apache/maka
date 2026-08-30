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

test('keeps the authority lease held by an inherited package-switch descriptor', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-inherited-file-update-lock-'));
  const targetPath = join(root, 'state');
  const holder = fork(
    new URL('./fixtures/file-update-lock-holder.js', import.meta.url),
    [targetPath, 'inherit'],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  let inheritorPid: number | undefined;
  t.after(async () => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    if (inheritorPid !== undefined) killIfRunning(inheritorPid);
    await rm(root, { recursive: true, force: true });
  });
  inheritorPid = await new Promise<number>((resolve, reject) => {
    holder.once('message', (message) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'locked' &&
        'inheritorPid' in message &&
        typeof message.inheritorPid === 'number'
      ) {
        resolve(message.inheritorPid);
      } else reject(new Error(`Unexpected child message: ${String(message)}`));
    });
    holder.once('error', reject);
  });

  holder.kill('SIGKILL');
  await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
  await assert.rejects(
    withProcessLifetimeFileUpdateLock(targetPath, async () => undefined, 150),
    /locked by another process/u,
  );

  killIfRunning(inheritorPid);
  await waitForExit(inheritorPid);
  await withProcessLifetimeFileUpdateLock(targetPath, async () => undefined, 2_000);
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

function killIfRunning(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Inherited lock holder ${pid} did not exit`);
}
