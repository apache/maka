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
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import { openInteractiveExecutionStoresForWrite } from '../execution-stores.js';
import { exportSessionBundleState } from '../session-bundle-policy.js';
import { runWithContextValueMutation } from '../context-value-mutation-gate.js';
import type { SessionSnapshotStatePreparer } from '../quiescent-session-snapshot.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test('live state export fences managed-context maintenance through its private copy', {
  timeout: 10_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-checkpoint-maintenance-'));
  const root = join(base, 'state');
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  assert.ok(owner);
  const release = deferred();
  const entered = deferred();
  const originalMkdir = fs.promises.mkdir;
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  let maintenance: Promise<void> | undefined;
  let capture: Promise<unknown> | undefined;
  try {
    const session = await stores.sessionStore.create({
      cwd: base,
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const destinationRoot = join(base, 'snapshot');
    fs.promises.mkdir = (async (...args: Parameters<typeof originalMkdir>) => {
      if (args[0].toString().startsWith(`${destinationRoot}.`)) {
        entered.resolve();
        await release.promise;
      }
      return originalMkdir(...args);
    }) as typeof originalMkdir;
    syncBuiltinESMExports();
    capture = exportSessionBundleState({
      stateRoot: owner.lease.canonicalPath,
      configRoot: owner.lease.canonicalPath,
      allowShared: true,
      destinationRoot,
      sessionId: session.id,
      lease: owner.lease,
    });
    await entered.promise;
    let maintenanceEntered = false;
    maintenance = runWithContextValueMutation(owner.lease.canonicalPath, async () => {
      maintenanceEntered = true;
    });
    await setImmediate();
    assert.equal(
      maintenanceEntered,
      false,
      'maintenance cannot enter while the private copy is active',
    );
    release.resolve();
    await Promise.all([maintenance, capture]);
    assert.equal(maintenanceEntered, true);
  } finally {
    fs.promises.mkdir = originalMkdir;
    syncBuiltinESMExports();
    release.resolve();
    await maintenance;
    await capture;
    await stores.sessionStore.close?.();
    await owner.close();
    await rm(owner.controlDirectory, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});
test('snapshot preparer cannot be retained past its selected-provider boundary or group close', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-checkpoint-scope-'));
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: join(base, 'state'), kind: 'interactive' }),
  );
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  try {
    assert.ok(stores.snapshot);
    let retained: SessionSnapshotStatePreparer | undefined;
    await stores.snapshot.runExclusive(async (state) => {
      retained = state;
    });
    assert.ok(retained);
    await assert.rejects(
      retained.prepareState({
        makaSessionId: 'any',
        destinationRoot: join(base, 'invalid'),
        cancellation: { signal: new AbortController().signal },
      }),
      /authentic|capability|Expected/,
    );
    await stores.sessionStore.close?.();
    await assert.rejects(stores.snapshot.runExclusive(async () => {}));
  } finally {
    await stores.sessionStore.close?.();
    await owner.close();
    await rm(owner.controlDirectory, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});
