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
import { after, describe, test } from 'node:test';
import {
  authenticateInteractiveTaskLedgerWriter,
  openInteractiveTaskLedgerStoreForWrite,
  type InteractiveTaskLedgerWriter,
} from '../task-ledger-authority.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type StorageRootLease,
} from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

// The control directory of each resolved root lives outside that root, so a
// temporary root's removal leaves it behind; reclaim the recorded rootIds here.
after(removeTrackedControlDirectories);

const SESSION_ID = 'authority-session';

describe('interactive task ledger authority', () => {
  test('single-flights concurrent opens and uses one local observer surface', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const [first, second] = await Promise.all([
          openInteractiveTaskLedgerStoreForWrite(owner.lease),
          openInteractiveTaskLedgerStoreForWrite(owner.lease),
        ]);
        assert.equal(first, second);
        assert.equal(authenticateInteractiveTaskLedgerWriter(first), first);

        const changes: string[][] = [];
        const unsubscribe = first.subscribe((event) => changes.push(event.taskIds));
        const result = await second.create(SESSION_ID, [{ subject: 'single writer' }]);
        unsubscribe();

        assert.equal(changes.length, 1);
        assert.deepEqual(changes[0], [result.created[0]?.id]);

        first.close();
        assert.throws(() => authenticateInteractiveTaskLedgerWriter(first), isInvalidLease);
        const reopened = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
        assert.notEqual(reopened, first);
        assert.equal((await reopened.list(SESSION_ID)).length, 1);
        reopened.close();
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('rejects canonical reads and mutations after the owner releases its lease', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
      await writer.create(SESSION_ID, [{ subject: 'before close' }]);
      await owner.close();

      await assert.rejects(() => writer.list(SESSION_ID), isInvalidLease);
      await assert.rejects(
        () => writer.create(SESSION_ID, [{ subject: 'after close' }]),
        isInvalidLease,
      );
      writer.close();
    });
  });

  test('rejects forged leases and forged writer facades', async () => {
    await assert.rejects(
      () => openInteractiveTaskLedgerStoreForWrite({} as StorageRootLease<'interactive', 'write'>),
      isInvalidLease,
    );

    await withInteractiveOwner(async ({ writer }) => {
      assert.throws(
        () =>
          authenticateInteractiveTaskLedgerWriter({
            ...writer,
          } as InteractiveTaskLedgerWriter),
        isInvalidLease,
      );
    });
  });
});

async function withInteractiveOwner(
  run: (input: { root: string; writer: InteractiveTaskLedgerWriter }) => Promise<void>,
): Promise<void> {
  await withInteractiveRoot(async ({ root, capability }) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    let writer: InteractiveTaskLedgerWriter | undefined;
    try {
      writer = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
      await run({
        root,
        writer,
      });
    } finally {
      writer?.close();
      if (!owner.closed) await owner.close();
    }
  });
}

async function withInteractiveRoot(
  run: (input: {
    root: string;
    capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (base) => {
    const root = join(base, 'interactive');
    const capability = trackControlDirectory(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    await run({ root, capability });
  });
}

async function withTempDir(run: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-task-ledger-authority-'));
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function isInvalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}
