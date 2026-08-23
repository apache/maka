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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { openStorageWriterComposition } from '../storage-writer-composition.js';
import {
  resolveStorageRoot,
  runWithStorageRootLease,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

// The control directory of each resolved root lives outside that root, so a
// temporary root's removal leaves it behind; reclaim the recorded rootIds here.
after(removeTrackedControlDirectories);

test('storage writer composition rejects reuse until close completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-storage-composition-'));
  try {
    const capability = trackControlDirectory(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      const first = await openStorageWriterComposition(owner.lease);
      await assert.rejects(openStorageWriterComposition(owner.lease));

      const closing = first.close();
      await assert.rejects(openStorageWriterComposition(owner.lease));
      await closing;

      const reopened = await openStorageWriterComposition(owner.lease);
      await reopened.execution.sessionStore.list();
      await reopened.close();
    } finally {
      await owner.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('opening a second storage writer composition creates a usable lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-storage-composition-failure-'));
  try {
    const capability = trackControlDirectory(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      const first = await openStorageWriterComposition(owner.lease);
      await first.close();
      const second = await openStorageWriterComposition(owner.lease);
      await second.execution.sessionStore.list();
      await second.usage.telemetry.logs({ range: 'all' }, 0, 1);
      await second.close();
    } finally {
      await owner.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed close keeps the lease unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-storage-composition-close-failure-'));
  try {
    const capability = trackControlDirectory(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      const composition = await openStorageWriterComposition(owner.lease);
      const operationalState = await runWithStorageRootLease(
        owner.lease,
        'interactive',
        'write',
        async (storageRoot) => acquireOperationalStateDatabase(storageRoot),
      );
      operationalState.database.close();
      operationalState.close();

      await assert.rejects(composition.close(), AggregateError);
      const [reopen] = await Promise.allSettled([openStorageWriterComposition(owner.lease)]);
      if (reopen.status === 'fulfilled') await reopen.value.close();
      assert.equal(reopen.status, 'rejected');
    } finally {
      await owner.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed runtime-policy hook rolls back before reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-storage-composition-hook-failure-'));
  try {
    const capability = trackControlDirectory(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      const failure = new Error('runtime-policy hook failed');
      await assert.rejects(
        openStorageWriterComposition(owner.lease, {
          afterRuntimePolicyOpened: () => {
            throw failure;
          },
        }),
        (error) => error === failure,
      );

      const reopened = await openStorageWriterComposition(owner.lease);
      await reopened.execution.sessionStore.list();
      await reopened.projectCatalog.list();
      await reopened.close();
    } finally {
      await owner.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
