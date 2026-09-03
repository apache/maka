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
  authenticateInteractiveSessionTodoWriter,
  openInteractiveSessionTodoStoreForWrite,
  type InteractiveSessionTodoWriter,
} from '../session-todo-authority.js';
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

after(removeTrackedControlDirectories);

describe('interactive SessionTodo authority', () => {
  test('single-flights opens and invalidates the facade when closed', async () => {
    await withInteractiveRoot(async (capability) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const [first, second] = await Promise.all([
          openInteractiveSessionTodoStoreForWrite(owner.lease),
          openInteractiveSessionTodoStoreForWrite(owner.lease),
        ]);
        assert.equal(first, second);
        assert.equal(authenticateInteractiveSessionTodoWriter(first), first);
        await first.replaceAll('authority-session', [{ content: 'owned', status: 'pending' }]);
        assert.deepEqual(await second.readOrBootstrap('authority-session'), {
          items: [{ content: 'owned', status: 'pending' }],
        });
        first.close();
        assert.throws(() => authenticateInteractiveSessionTodoWriter(first), isInvalidLease);
        await assert.rejects(() => first.readOrBootstrap('authority-session'), isInvalidLease);
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('rejects forged leases and facades', async () => {
    await assert.rejects(
      () => openInteractiveSessionTodoStoreForWrite({} as StorageRootLease<'interactive', 'write'>),
      isInvalidLease,
    );
    assert.throws(
      () => authenticateInteractiveSessionTodoWriter({} as InteractiveSessionTodoWriter),
      isInvalidLease,
    );
  });
});

async function withInteractiveRoot(
  run: (capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-todo-authority-'));
  try {
    const capability = trackControlDirectory(
      await resolveStorageRoot({ path: join(base, 'interactive'), kind: 'interactive' }),
    );
    await run(capability);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function isInvalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}
