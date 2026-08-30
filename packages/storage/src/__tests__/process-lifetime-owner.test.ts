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

import { strict as assert } from 'node:assert';
import { fork } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { acquireProcessLifetimeOwner } from '../process-lifetime-owner.js';

test('claims an owner only after its process exits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-process-lifetime-owner-'));
  const child = fork(
    new URL('./fixtures/process-lifetime-owner-holder.js', import.meta.url),
    [root],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  const observer = await acquireProcessLifetimeOwner(root);
  const competingObserver = await acquireProcessLifetimeOwner(root);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await observer.close().catch(() => undefined);
    await competingObserver.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const reference = await waitForReference(t, child);
  assert.equal(await observer.tryClaimReleased(reference), undefined);

  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));

  const claims = await Promise.all([
    observer.tryClaimReleased(reference),
    competingObserver.tryClaimReleased(reference),
  ]);
  const acquired = claims.filter((claim) => claim !== undefined);
  assert.equal(acquired.length, 1);
  await acquired[0]?.retire();
});

test('releases its owner reference on graceful close', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-process-lifetime-owner-'));
  const owner = await acquireProcessLifetimeOwner(root);
  const observer = await acquireProcessLifetimeOwner(root);
  t.after(async () => {
    await owner.close().catch(() => undefined);
    await observer.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(await observer.tryClaimReleased(owner.reference), undefined);
  await owner.close();
  const claim = await observer.tryClaimReleased(owner.reference);
  assert.ok(claim);
  await claim.retire();
});

test('retires an unreferenced owner file after an unclean process exit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-process-lifetime-owner-'));
  const child = fork(
    new URL('./fixtures/process-lifetime-owner-holder.js', import.meta.url),
    [root],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  const deadReference = await waitForReference(t, child);
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));

  const successor = await acquireProcessLifetimeOwner(root);
  t.after(() => successor.close());
  await successor.retireUnreferencedReleasedOwners(new Set());
  const files = await readdir(join(root, 'owners'));
  assert.deepEqual(files, [`${successor.reference.slice('lock-v1:'.length)}.lease`]);
  assert.equal(files.includes(`${deadReference.slice('lock-v1:'.length)}.lease`), false);
});

test('rejects owner references outside its versioned namespace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-process-lifetime-owner-'));
  const owner = await acquireProcessLifetimeOwner(root);
  t.after(async () => {
    await owner.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(owner.tryClaimReleased('../other'), /Invalid process lifetime owner/);
});

async function waitForReference(t: TestContext, child: ReturnType<typeof fork>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'reference' in message &&
        typeof message.reference === 'string'
      ) {
        resolve(message.reference);
      } else {
        reject(new Error(`Unexpected child message: ${String(message)}`));
      }
    };
    child.once('message', onMessage);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`Owner exited before acquisition (${String(code)}, ${signal})`));
    });
    t.after(() => child.off('message', onMessage));
  });
}
