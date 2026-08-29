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
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ContextOffloadLimits } from '@maka/core/context-offload';
import {
  authenticateInteractiveContextOffloadWriter,
  openInteractiveContextOffloadStoreForWrite,
  type InteractiveContextOffloadWriter,
} from '../context-offload-store.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
  type StorageRootLease,
} from '../root-authority.js';
import { CONTEXT_OFFLOAD_DATABASE_NAME } from '../sqlite-context-offload-store.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);

test('requires authentic Storage Root leases and writer facades', async () => {
  await assert.rejects(
    () =>
      openInteractiveContextOffloadStoreForWrite({} as StorageRootLease<'interactive', 'write'>, {
        limits: testLimits(),
      }),
    invalidLease,
  );
  assert.throws(
    () => authenticateInteractiveContextOffloadWriter({} as InteractiveContextOffloadWriter),
    invalidLease,
  );
});

test('single-flights one limit-bound writer and snapshots admitted inputs', async () => {
  await withInteractiveOwner(async (owner, root) => {
    const mutableLimits = testLimits();
    const opening = openInteractiveContextOffloadStoreForWrite(owner.lease, {
      limits: mutableLimits,
    });
    const concurrentOpening = openInteractiveContextOffloadStoreForWrite(owner.lease, {
      limits: testLimits(),
    });
    const conflictingOpening = assert.rejects(
      openInteractiveContextOffloadStoreForWrite(owner.lease, {
        limits: { ...testLimits(), workspacePhysicalBytes: 63 },
      }),
      /different limits/u,
    );
    (mutableLimits.ownerMaxBytes as { tool_result_archive: number }).tool_result_archive = 0;
    (mutableLimits as { sessionLogicalBytes: number }).sessionLogicalBytes = 0;
    const [first, second] = await Promise.all([opening, concurrentOpening]);
    try {
      await conflictingOpening;
      assert.strictEqual(second, first);
      assert.strictEqual(authenticateInteractiveContextOffloadWriter(first), first);
      assert.equal((await stat(join(root, CONTEXT_OFFLOAD_DATABASE_NAME))).isFile(), true);

      const bytes = new TextEncoder().encode('safe');
      const input = {
        sessionId: 'source',
        owner: { kind: 'tool_result_archive' as const, ownerId: 'source-owner' },
        bytes,
        mediaType: 'application/json',
      };
      const putting = first.put(input);
      input.sessionId = 'mutated';
      input.owner.ownerId = 'mutated-owner';
      input.mediaType = 'text/plain';
      bytes.fill(0x78);
      const stored = await putting;
      assert.equal(stored.ok, true);
      if (!stored.ok) return;
      assert.equal(stored.record.sessionId, 'source');
      assert.equal(stored.record.owner.ownerId, 'source-owner');
      assert.equal(stored.record.mediaType, 'application/json');
      assert.deepEqual(
        await first.read({ sessionId: 'source', refId: stored.record.refId, maxBytes: 64 }),
        { ok: true, record: stored.record, bytes: new TextEncoder().encode('safe') },
      );

      const copyInput = {
        sourceSessionId: 'source',
        targetSessionId: 'target',
        references: [
          {
            sourceRefId: stored.record.refId,
            targetOwner: { kind: 'tool_result_archive' as const, ownerId: 'target-owner' },
          },
        ],
      };
      const copying = first.copyReferences(copyInput);
      copyInput.targetSessionId = 'mutated-target';
      copyInput.references[0]!.targetOwner.ownerId = 'mutated-target-owner';
      const copied = await copying;
      assert.equal(copied.ok, true);
      if (!copied.ok) return;
      assert.deepEqual(
        await first.copyReferences({
          sourceSessionId: 'source',
          targetSessionId: 'target',
          references: [
            {
              sourceRefId: stored.record.refId,
              targetOwner: { kind: 'tool_result_archive', ownerId: 'target-owner' },
            },
          ],
        }),
        copied,
      );
    } finally {
      await first.close();
    }
  });
});

test('close drains admitted work, revokes the facade, and permits a clean reopen', async () => {
  await withInteractiveOwner(async (owner) => {
    const writer = await openInteractiveContextOffloadStoreForWrite(owner.lease, {
      limits: testLimits(),
    });
    const admitted = writer.put({
      sessionId: 'session-1',
      owner: { kind: 'read_image_snapshot', ownerId: 'read-1' },
      bytes: new TextEncoder().encode('image'),
      mediaType: 'image/png',
    });
    const closing = writer.close();
    const reopening = openInteractiveContextOffloadStoreForWrite(owner.lease, {
      limits: testLimits(),
    });
    assert.equal((await admitted).ok, true);
    await closing;
    await assert.rejects(writer.usage(), invalidLease);
    assert.throws(() => authenticateInteractiveContextOffloadWriter(writer), invalidLease);

    const reopened = await reopening;
    try {
      assert.notStrictEqual(reopened, writer);
      assert.deepEqual(await reopened.usage('session-1'), {
        references: 1,
        logicalBytes: 5,
        physicalBytes: 5,
      });
    } finally {
      await reopened.close();
    }
  });
});

test('root-owner close revokes new context-offload operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-offload-authority-revoke-'));
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const writer = await openInteractiveContextOffloadStoreForWrite(owner.lease, {
    limits: testLimits(),
  });
  try {
    await owner.close();
    await assert.rejects(writer.usage(), invalidLease);
  } finally {
    await writer.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

function testLimits(): ContextOffloadLimits {
  return {
    ownerMaxBytes: {
      read_image_snapshot: 64,
      tool_result_archive: 64,
    },
    sessionLogicalBytes: 64,
    workspacePhysicalBytes: 64,
  };
}

function invalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}

async function withInteractiveOwner(
  run: (owner: InteractiveRootOwner, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-offload-authority-'));
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  try {
    await run(owner, root);
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}
