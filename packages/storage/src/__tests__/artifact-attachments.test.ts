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
import { type StorageRef } from '@maka/core/events';
import {
  createArtifactAttachmentResourceReader,
  createAttachmentByteReader,
  createReadImageSnapshotter,
} from '../artifact-attachments.js';
import { createSqliteArtifactStore as createArtifactStore } from '../artifact-store.js';

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
});

function sessionFileRef(relativePath: string, sessionId = 'session-1'): StorageRef {
  return { kind: 'session_file', sessionId, relativePath };
}

async function withStore(
  run: (store: ReturnType<typeof createArtifactStore>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-attachment-'));
  const store = createArtifactStore(root);
  try {
    await run(store);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
}
