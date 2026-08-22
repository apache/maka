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
import { describe, test } from 'node:test';
import {
  authenticateInteractiveArtifactStoreWriter,
  openInteractiveArtifactStoreForWrite,
  type InteractiveArtifactStoreWriter,
} from '../artifact-stores.js';
import { ARTIFACT_WRITER_LOCK_FILE } from '../artifact-storage-layout.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type StorageRootLease,
} from '../root-authority.js';

describe('interactive artifact store authority', () => {
  test('requires authentic leases and writer facades', async () => {
    await assert.rejects(
      () =>
        openInteractiveArtifactStoreForWrite(
          {} as unknown as StorageRootLease<'interactive', 'write'>,
        ),
      invalidLease,
    );

    assert.throws(
      () =>
        authenticateInteractiveArtifactStoreWriter({} as unknown as InteractiveArtifactStoreWriter),
      invalidLease,
    );
  });

  test('returns one authenticated writer per lease and preserves mutation operations', async () => {
    await withInteractiveOwner(async (owner, root, track) => {
      const [first, second] = await Promise.all([
        openInteractiveArtifactStoreForWrite(owner.lease),
        openInteractiveArtifactStoreForWrite(owner.lease),
      ]);
      track(first);
      track(second);

      assert.strictEqual(first, second);
      assert.strictEqual(authenticateInteractiveArtifactStoreWriter(first), first);
      await first.recover();
      await first.create(artifactInput('deleted', 'delete me'));
      const deleted = await first.deleteUserArtifactInSession('session-1', 'deleted');

      assert.strictEqual(await openInteractiveArtifactStoreForWrite(owner.lease), first);
      assert.equal(deleted.kind, 'deleted');
      const page = await first.listPage('session-1', { offset: 0, limit: 1 });
      assert.equal(page.total, 1);
      assert.equal(page.records[0]?.status, 'deleted');
      assert.deepEqual(await first.getInSession('session-1', 'deleted'), {
        revision: page.revision,
        record: page.records[0],
      });
      assert.deepEqual(await first.readTextInSession('session-1', 'deleted'), {
        ok: false,
        reason: 'deleted',
      });
      assert.deepEqual(await first.readTextInSession('other-session', 'deleted'), {
        ok: false,
        reason: 'not_found',
      });
      await assert.rejects(() => stat(join(root, ARTIFACT_WRITER_LOCK_FILE)), { code: 'ENOENT' });

      first.close();
      const reopened = track(await openInteractiveArtifactStoreForWrite(owner.lease));
      assert.notStrictEqual(reopened, first);
      assert.equal((await reopened.getInSession('session-1', 'deleted')).record?.status, 'deleted');
    });
  });

  test('root close revokes new facade operations after draining an in-flight write', async () => {
    await withTemporaryRoot('interactive', async (root, track) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const writer = track(await openInteractiveArtifactStoreForWrite(owner.lease));
      await writer.recover();
      const accepted = writer.create(
        artifactInput('accepted', new Uint8Array(8 * 1024 * 1024).fill(0x62)),
      );

      await owner.close();
      assert.equal((await accepted).id, 'accepted');
      await assert.rejects(
        () => writer.listPage('session-1', { offset: 0, limit: 1 }),
        invalidLease,
      );
    });
  });

  test('snapshots create inputs and makes user deletion idempotent', async () => {
    await withInteractiveOwner(async (owner, _root, track) => {
      const writer = track(await openInteractiveArtifactStoreForWrite(owner.lease));
      await writer.recover();
      const bytes = Uint8Array.from([0x73, 0x61, 0x66, 0x65]);
      const createInput = artifactInput('accepted', bytes);
      const created = writer.create(createInput);
      createInput.id = 'mutated';
      createInput.sessionId = 'mutated-session';
      createInput.content = 'mutated';
      bytes.fill(0x78);

      const record = await created;
      assert.equal(record.id, 'accepted');
      assert.deepEqual(await writer.readTextInSession('session-1', 'accepted'), {
        ok: true,
        text: 'safe',
      });

      const deleted = writer.deleteUserArtifactInSession('session-1', record.id);
      assert.equal((await deleted).kind, 'deleted');
      assert.equal(
        (await writer.deleteUserArtifactInSession('session-1', record.id)).kind,
        'deleted',
      );
      assert.equal((await writer.getInSession('session-1', 'accepted')).record?.status, 'deleted');
    });
  });
});

function artifactInput(id: string, content: string | Uint8Array) {
  return {
    id,
    sessionId: 'session-1',
    turnId: 'turn-1',
    name: `${id}.txt`,
    kind: 'file' as const,
    content,
    now: 1,
  };
}

function invalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}

async function withInteractiveOwner(
  run: (
    owner: NonNullable<Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>>,
    root: string,
    track: TrackArtifactWriter,
  ) => Promise<void>,
): Promise<void> {
  await withTemporaryRoot('interactive', async (root, track) => {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      await run(owner, root, track);
    } finally {
      await owner.close();
    }
  });
}

async function withTemporaryRoot(
  kind: 'interactive',
  run: (root: string, track: TrackArtifactWriter) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `maka-artifact-${kind}-`));
  const writers = new Set<{ close(): void }>();
  const track: TrackArtifactWriter = (writer) => {
    writers.add(writer);
    return writer;
  };
  try {
    await run(root, track);
  } finally {
    for (const writer of [...writers].reverse()) writer.close();
    await rm(root, { recursive: true, force: true });
  }
}

type TrackArtifactWriter = <T extends { close(): void }>(writer: T) => T;
