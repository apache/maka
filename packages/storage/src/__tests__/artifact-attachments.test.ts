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
import { describe, test } from 'node:test';
import { MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';
import type { ReadImageSnapshotReader } from '@maka/core/context-offload';
import { type StorageRef } from '@maka/core/events';
import {
  createArtifactAttachmentResourceReader,
  createAttachmentByteReader,
  createReadImageSnapshotPlanner,
  createReadImageSnapshotter,
} from '../artifact-attachments.js';
import {
  createSqliteArtifactStoreWriteAuthority,
  type ArtifactAuthorityStore,
} from '../artifact-store.js';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('artifact attachment authority', () => {
  test('reads only live user-uploaded text within the invoking Session', async () => {
    await withStore(async (store) => {
      await store.create({
        id: 'notes-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'notes.txt',
        kind: 'file',
        content: 'attachment marker',
        mimeType: 'text/plain',
        source: 'user_upload',
        now: 1,
      });
      const reader = createArtifactAttachmentResourceReader({ artifactStore: store });
      const signal = new AbortController().signal;

      assert.deepEqual(await reader.readAttachmentResource('session-1', 'notes-1', signal), {
        kind: 'text',
        text: 'attachment marker',
      });
      await assert.rejects(
        reader.readAttachmentResource('session-2', 'notes-1', signal),
        /not found in this Session/,
      );
      await store.delete('notes-1');
      await assert.rejects(
        reader.readAttachmentResource('session-1', 'notes-1', signal),
        /not found in this Session/,
      );
    });
  });

  test('resolves a live session ref and never forwards tombstoned bytes', async () => {
    await withStore(async (store) => {
      await store.create({
        id: 'image-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'image.png',
        kind: 'image',
        content: png,
        now: 1,
      });
      const reader = createAttachmentByteReader({
        artifactStore: store,
        sessionId: 'session-1',
      });
      assert.deepEqual(await reader(sessionFileRef('image-1')), {
        ok: true,
        bytes: Buffer.from(png),
      });
      await store.delete('image-1');
      assert.deepEqual(await reader(sessionFileRef('image-1')), {
        ok: false,
        reason: 'deleted',
      });
      assert.deepEqual(await reader(sessionFileRef('image-1', 'other-session')), {
        ok: false,
        reason: 'session_mismatch',
      });
    });
  });

  test('rejects unsupported refs and applies the shared byte limit inside authority', async () => {
    await withStore(async (store) => {
      await store.create({
        id: 'large-image',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'large.png',
        kind: 'image',
        content: new Uint8Array(MAX_ATTACHMENT_BYTES + 1).fill(0x89),
        now: 1,
      });
      const reader = createAttachmentByteReader({
        artifactStore: store,
        sessionId: 'session-1',
      });

      assert.deepEqual(await reader({ kind: 'workspace_file', relativePath: 'image.png' }), {
        ok: false,
        reason: 'unsupported_ref_kind',
      });
      assert.deepEqual(await reader(sessionFileRef('large-image')), {
        ok: false,
        reason: 'too_large',
      });
      const unavailableReader = createAttachmentByteReader({
        artifactStore: store,
        sessionId: 'session-1',
        readImageSnapshotsUnavailable: true,
      });
      assert.deepEqual(await unavailableReader(sessionContextRef('ref-1')), {
        ok: false,
        reason: 'unavailable',
      });
    });
  });

  test('routes durable context refs through the Session-bound snapshot reader', async () => {
    await withStore(async (store) => {
      const reads: string[] = [];
      const readImageSnapshots: ReadImageSnapshotReader = {
        async read(ref) {
          reads.push(ref.refId);
          if (ref.refId === 'missing') return { ok: false, reason: 'not_found' };
          return {
            ok: true,
            record: {
              refId: ref.refId,
              sessionId: ref.sessionId,
              owner: { kind: 'read_image_snapshot', ownerId: 'owner-1' },
              blobId: 'a'.repeat(64),
              sizeBytes: png.byteLength,
              mediaType: 'image/png',
              createdAt: 1,
            },
            bytes: png,
          };
        },
      };
      const reader = createAttachmentByteReader({
        artifactStore: store,
        sessionId: 'session-1',
        readImageSnapshots,
      });

      assert.deepEqual(await reader(sessionContextRef('ref-1')), {
        ok: true,
        bytes: png,
      });
      assert.deepEqual(await reader(sessionContextRef('missing')), {
        ok: false,
        reason: 'not_found',
      });
      assert.deepEqual(await reader(sessionContextRef('ref-2', 'other-session')), {
        ok: false,
        reason: 'session_mismatch',
      });
      assert.deepEqual(reads, ['ref-1', 'missing']);
    });
  });

  test('passes through real store not-found and unsupported-mime failures', async () => {
    await withStore(async (store) => {
      const reader = createAttachmentByteReader({
        artifactStore: store,
        sessionId: 'session-1',
      });
      assert.deepEqual(await reader(sessionFileRef('missing')), {
        ok: false,
        reason: 'not_found',
      });

      await store.create({
        id: 'unknown-binary',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'unknown.bin',
        kind: 'file',
        content: Uint8Array.from([0, 1, 2, 3]),
        now: 1,
      });
      assert.deepEqual(await reader(sessionFileRef('unknown-binary')), {
        ok: false,
        reason: 'unsupported_mime',
      });
    });
  });

  test('snapshotter rejects provider-unsafe images before publication', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        createReadImageSnapshotter(store)({
          sessionId: 'session-1',
          turnId: 'turn-1',
          name: 'large.png',
          bytes: new Uint8Array(5 * 1024 * 1024 + 1),
          mimeType: 'image/png',
        }),
        /Image exceeds the 5MB model input limit/,
      );
      assert.deepEqual(await store.list('session-1'), []);
    });
  });

  test('snapshotter reuses one content-addressed artifact for the same turn image', async () => {
    await withStore(async (store) => {
      const snapshot = createReadImageSnapshotter(store);
      const input = {
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'Tool Result image',
        bytes: Uint8Array.from([1, 2, 3]),
        mimeType: 'image/png',
      };

      const first = await snapshot(input);
      const repeated = await snapshot(input);

      assert.deepEqual(repeated, first);
      assert.equal((await store.list('session-1')).length, 1);
    });
  });

  test('keeps a durable projection image live when a user requests deletion', async () => {
    await withStore(async (store) => {
      const ref = await createReadImageSnapshotter(store)({
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'Tool Result image',
        bytes: png,
        mimeType: 'image/png',
      });

      assert.deepEqual(await store.deleteUserArtifactInSession('session-1', ref.relativePath), {
        kind: 'protected',
      });
      assert.deepEqual(await store.readBinary(ref.relativePath), {
        ok: true,
        base64: Buffer.from(png).toString('base64'),
        mimeType: 'image/png',
      });
    });
  });

  test('planner derives the final ref without publishing before commit', async () => {
    await withStore(async (store) => {
      const bytes = png.slice();
      const input = {
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'Tool Result image',
        bytes,
        mimeType: 'image/png',
      };
      const plan = createReadImageSnapshotPlanner(store)(input);

      assert.deepEqual(await store.list('session-1'), []);
      bytes[0] = 0;
      input.name = 'mutated after prepare';
      await Promise.all([plan.persist(), plan.persist()]);
      const published = await store.list('session-1');
      assert.deepEqual(
        published.map((artifact) => artifact.id),
        [plan.ref.relativePath],
      );
      assert.equal(published[0]?.name, 'Tool Result image');
      assert.deepEqual(await store.readBinary(plan.ref.relativePath), {
        ok: true,
        base64: Buffer.from(png).toString('base64'),
        mimeType: 'image/png',
      });
    });
  });
  test('retraction reclaims only what the retracting plan published', async () => {
    await withStore(async (store) => {
      const input = {
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'Tool Result image',
        bytes: png.slice(),
        mimeType: 'image/png',
      };
      const deleted: string[] = [];
      // The id is derived from the bytes, so a second projection for the same
      // image in the same Turn gets the first one's record back. Retracting the
      // second must not delete the artifact the first one committed.
      const owned = {
        create: (createInput: Parameters<typeof store.create>[0]) => store.create(createInput),
        createOwned: async (createInput: Parameters<typeof store.create>[0]) => {
          const existing = createInput.id
            ? await store.getInSession(createInput.sessionId, createInput.id)
            : undefined;
          const record = await store.create(createInput);
          return { record, publishedByThisCall: !existing?.record };
        },
      };
      const planner = createReadImageSnapshotPlanner(owned, async (_sessionId, artifactId) => {
        deleted.push(artifactId);
        await store.delete(artifactId);
      });

      const first = planner(input);
      await first.persist();
      const second = planner(input);
      await second.persist();
      assert.equal(second.ref.relativePath, first.ref.relativePath);

      await second.retract();

      assert.deepEqual(deleted, []);
      assert.equal((await store.readBinary(first.ref.relativePath)).ok, true);

      await first.retract();

      assert.deepEqual(deleted, [first.ref.relativePath]);
      assert.equal((await store.readBinary(first.ref.relativePath)).ok, false);
    });
  });
});

function sessionFileRef(relativePath: string, sessionId = 'session-1'): StorageRef {
  return { kind: 'session_file', sessionId, relativePath };
}

function sessionContextRef(refId: string, sessionId = 'session-1'): StorageRef {
  return { kind: 'session_context', sessionId, refId };
}

async function withStore(run: (store: ArtifactAuthorityStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-attachment-'));
  const authority = createSqliteArtifactStoreWriteAuthority(root);
  try {
    await authority.recover();
    const { store } = authority;
    await run(store);
  } finally {
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}
