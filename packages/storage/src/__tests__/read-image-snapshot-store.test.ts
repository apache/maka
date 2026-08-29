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
import { MAX_READ_IMAGE_BYTES } from '@maka/core/attachments';
import { ReadImageSnapshotStoreError, type ContextOffloadLimits } from '@maka/core/context-offload';
import {
  openInteractiveContextOffloadStoreForWrite,
  type InteractiveContextOffloadWriter,
} from '../context-offload-store.js';
import { createReadImageSnapshotStore } from '../read-image-snapshot-store.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);

test('derives Read image storage only from an authentic context writer', () => {
  assert.throws(
    () => createReadImageSnapshotStore({} as InteractiveContextOffloadWriter, 'session-1'),
    /authentic interactive context-offload writer/u,
  );
});

test('snapshots one stable Read image identity and authorizes reads by Session', async () => {
  await withReadImageStore(defaultLimits(), async (images, writer) => {
    const bytes = new TextEncoder().encode('image');
    const input = {
      ownerId: 'read-call-1',
      bytes,
      mimeType: 'image/png',
    };
    const snapshotting = images.snapshot(input);
    input.ownerId = 'mutated-owner';
    input.mimeType = 'image/jpeg';
    bytes.fill(0x78);

    const ref = await snapshotting;
    assert.deepEqual(ref, {
      kind: 'session_context',
      sessionId: 'session-1',
      refId: ref.refId,
    });
    assert.deepEqual(
      await images.snapshot({
        ownerId: 'read-call-1',
        bytes: new TextEncoder().encode('image'),
        mimeType: 'image/png',
      }),
      ref,
    );
    const read = await images.read(ref);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.record.owner.kind, 'read_image_snapshot');
    assert.equal(read.record.owner.ownerId, 'read-call-1');
    assert.equal(read.record.mediaType, 'image/png');
    assert.deepEqual(read.bytes, new TextEncoder().encode('image'));
    assert.deepEqual(await images.read({ ...ref, sessionId: 'session-2' }), {
      ok: false,
      reason: 'session_mismatch',
    });
    const sessionTwoImages = createReadImageSnapshotStore(writer, 'session-2');
    assert.deepEqual(await sessionTwoImages.read(ref), {
      ok: false,
      reason: 'session_mismatch',
    });

    await assert.rejects(
      images.snapshot({
        ownerId: 'read-call-1',
        bytes: new TextEncoder().encode('changed'),
        mimeType: 'image/png',
      }),
      (error) =>
        error instanceof ReadImageSnapshotStoreError && error.reason === 'identity_conflict',
    );
    await assert.rejects(
      images.snapshot({
        ownerId: 'read-call-1',
        bytes: new TextEncoder().encode('image'),
        mimeType: 'image/jpeg',
      }),
      (error) =>
        error instanceof ReadImageSnapshotStoreError && error.reason === 'identity_conflict',
    );
    await assert.rejects(
      images.snapshot({
        ownerId: 'not-an-image',
        bytes: new Uint8Array([1]),
        mimeType: 'text/plain',
      }),
      /media type must be an image/u,
    );
  });
});

test('maps configured quota failures and rejects non-image owner references', async () => {
  await withReadImageStore(
    {
      ownerMaxBytes: {
        read_image_snapshot: 4,
        tool_result_archive: 64,
      },
      sessionLogicalBytes: 64,
      workspacePhysicalBytes: 64,
    },
    async (images, writer) => {
      await assert.rejects(
        images.snapshot({
          ownerId: 'over-configured-limit',
          bytes: new Uint8Array(5),
          mimeType: 'image/png',
        }),
        (error) => error instanceof ReadImageSnapshotStoreError && error.reason === 'too_large',
      );

      const archive = await writer.put({
        sessionId: 'session-1',
        owner: { kind: 'tool_result_archive', ownerId: 'archive-1' },
        bytes: new TextEncoder().encode('{}'),
        mediaType: 'application/json',
      });
      assert.equal(archive.ok, true);
      if (!archive.ok) return;
      assert.deepEqual(
        await images.read({
          kind: 'session_context',
          sessionId: 'session-1',
          refId: archive.record.refId,
        }),
        { ok: false, reason: 'corrupt' },
      );
    },
  );
});

test('enforces the Read image product cap before touching storage', async () => {
  const limits: ContextOffloadLimits = {
    ownerMaxBytes: {
      read_image_snapshot: MAX_READ_IMAGE_BYTES + 1,
      tool_result_archive: 64,
    },
    sessionLogicalBytes: MAX_READ_IMAGE_BYTES + 1,
    workspacePhysicalBytes: MAX_READ_IMAGE_BYTES + 1,
  };
  await withReadImageStore(limits, async (images, writer) => {
    await assert.rejects(
      images.snapshot({
        ownerId: 'over-product-limit',
        bytes: new Uint8Array(MAX_READ_IMAGE_BYTES + 1),
        mimeType: 'image/png',
      }),
      (error) => error instanceof ReadImageSnapshotStoreError && error.reason === 'too_large',
    );
    assert.deepEqual(await writer.usage(), {
      references: 0,
      logicalBytes: 0,
      physicalBytes: 0,
    });
  });
});

function defaultLimits(): ContextOffloadLimits {
  return {
    ownerMaxBytes: {
      read_image_snapshot: MAX_READ_IMAGE_BYTES,
      tool_result_archive: 64,
    },
    sessionLogicalBytes: MAX_READ_IMAGE_BYTES * 2,
    workspacePhysicalBytes: MAX_READ_IMAGE_BYTES * 2,
  };
}

async function withReadImageStore(
  limits: ContextOffloadLimits,
  run: (
    images: ReturnType<typeof createReadImageSnapshotStore>,
    writer: InteractiveContextOffloadWriter,
  ) => Promise<void>,
): Promise<void> {
  await withInteractiveOwner(async (owner) => {
    const writer = await openInteractiveContextOffloadStoreForWrite(owner.lease, { limits });
    try {
      await run(createReadImageSnapshotStore(writer, 'session-1'), writer);
    } finally {
      await writer.close();
    }
  });
}

async function withInteractiveOwner(run: (owner: InteractiveRootOwner) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'maka-read-image-context-store-'));
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  try {
    await run(owner);
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}
