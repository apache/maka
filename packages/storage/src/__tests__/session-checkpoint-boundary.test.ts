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
import { eventWaitDeliveryKey, type EventWaitRecord } from '@maka/core/event-wait';
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
for (const failCopy of [false, true]) {
  test(`snapshot fences every event-wait mutation and releases on ${failCopy ? 'failure' : 'success'}`, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-checkpoint-waits-'));
    const owner = await tryAcquireInteractiveRootOwner(
      await resolveStorageRoot({ path: join(base, 'state'), kind: 'interactive' }),
    );
    assert.ok(owner);
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const entered = deferred();
    const release = deferred();
    let snapshot: Promise<unknown> | undefined;
    let writes: Promise<unknown>[] = [];
    try {
      const session = await stores.sessionStore.create({
        cwd: base,
        llmConnectionSlug: 'test',
        model: 'test',
        permissionMode: 'ask',
      });
      const record: EventWaitRecord = {
        schemaVersion: 1,
        waitId: 'wait-1',
        sessionId: session.id,
        goalControlLease: { goalId: 'goal-1', generation: 0 },
        sourceTurnId: 'turn-1',
        sourceToolCallId: 'call-1',
        resource: {
          providerId: 'test',
          connectionId: null,
          resourceType: 'task',
          resourceId: 'task-1',
        },
        condition: { typeId: 'terminal', version: 1, parameters: {} },
        deliveryKey: eventWaitDeliveryKey('wait-1'),
        createdAt: 10,
        updatedAt: 10,
        deadlineAt: 100,
        status: 'waiting',
      };
      const completedSource = { providerId: 'completed', connectionId: null, token: 'dispatch-1' };
      await stores.eventWaitStore.reserveSourceDispatch({
        ...completedSource,
        observedAt: 10,
        until: 40,
      });
      assert.ok(stores.snapshot);
      snapshot = stores.snapshot.runExclusive(async () => {
        entered.resolve();
        await release.promise;
        if (failCopy) throw new Error('copy failed');
      });
      // Observe failures immediately, including assertions that abort this test.
      void snapshot.catch(() => {});
      await entered.promise;
      const finished: number[] = [];
      writes = [
        stores.eventWaitStore.commit({
          sessionId: session.id,
          waitId: record.waitId,
          record,
          expectedAuthorityRevision: null,
        }),
        stores.eventWaitStore.extendSourceCooldown({
          providerId: 'cooldown',
          connectionId: null,
          observedAt: 10,
          until: 90,
        }),
        stores.eventWaitStore.reserveSourceDispatch({
          providerId: 'reserved',
          connectionId: null,
          token: 'dispatch-2',
          observedAt: 10,
          until: 50,
        }),
        stores.eventWaitStore.completeSourceDispatch({
          ...completedSource,
          observedAt: 20,
          until: 60,
        }),
      ].map((write, index) =>
        write.then((result) => {
          finished.push(index);
          return result;
        }),
      );
      await setImmediate();
      assert.deepEqual(
        finished,
        [],
        'all four mutation paths must wait for the entire private copy',
      );
      release.resolve();
      if (failCopy) await assert.rejects(snapshot, /copy failed/);
      else await snapshot;
      const results = await Promise.all(writes);
      assert.deepEqual(results.slice(1), [90, true, 60]);
      assert.equal(
        (await stores.eventWaitStore.read({ sessionId: session.id, waitId: record.waitId }))?.record
          .status,
        'waiting',
      );
      await stores.sessionStore.close?.();
      await assert.rejects(
        stores.eventWaitStore.commit({
          sessionId: session.id,
          waitId: record.waitId,
          record,
          expectedAuthorityRevision: 0,
        }),
      );
    } finally {
      release.resolve();
      await Promise.allSettled([...(snapshot ? [snapshot] : []), ...writes]);
      await stores.sessionStore.close?.();
      await owner.close();
      await rm(owner.controlDirectory, { recursive: true, force: true });
      await rm(base, { recursive: true, force: true });
    }
  });
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
