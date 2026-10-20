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
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createSqliteArtifactStoreWriteAuthority } from '../artifact-store.js';
import { createArtifactAttachmentResourceReader } from '../artifact-attachments.js';

const SOURCE = 'source-session-0000-0000-0000-000000000001';
const TARGET = 'target-session-0000-0000-0000-000000000002';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function withStore(
  body: (input: {
    readonly root: string;
    readonly store: ReturnType<typeof createSqliteArtifactStoreWriteAuthority>['store'];
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-recall-material-'));
  const authority = createSqliteArtifactStoreWriteAuthority(root);
  try {
    await body({ root, store: authority.store });
  } finally {
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** One copy, the way recall's material fetch performs it. */
async function bringIntoSession(
  store: ReturnType<typeof createSqliteArtifactStoreWriteAuthority>['store'],
  materialId: string,
): Promise<string> {
  const copied = await store.copyConversationArtifacts({
    sourceSessionId: SOURCE,
    targetSessionId: TARGET,
    turnIds: [],
    includeArtifactIds: [materialId],
    existingTarget: 'reuse_verified',
  });
  const id = copied.artifactIds.get(materialId);
  assert.ok(id, 'the material was not copied');
  return id;
}

describe('bringing a recalled material into the asking Session', () => {
  /**
   * The copy is what makes the answer durable: a tool result holds its file as
   * a ref and every later turn re-materializes it, so a ref into another
   * Session would break the moment that Session was cleaned up.
   */
  test('a copied material is readable from the asking Session and outlives its source', async () => {
    await withStore(async ({ store }) => {
      const created = await store.create({
        sessionId: SOURCE,
        turnId: 'upload',
        name: 'screenshot.png',
        kind: 'image',
        mimeType: 'image/png',
        content: PNG,
        source: 'user_upload',
      });
      const reader = createArtifactAttachmentResourceReader({ artifactStore: store });
      const signal = new AbortController().signal;

      // Before the copy the asking Session cannot read it at all.
      await assert.rejects(
        () => reader.readAttachmentResource(TARGET, created.id, signal),
        /not found in this Session/u,
      );

      const copiedId = await bringIntoSession(store, created.id);
      const content = await reader.readAttachmentResource(TARGET, copiedId, signal);
      assert.deepEqual(content, {
        kind: 'image',
        mimeType: 'image/png',
        ref: { kind: 'session_file', sessionId: TARGET, relativePath: copiedId },
      });

      // The source Session going away leaves the asking Session's copy intact.
      await store.purgeSessionArtifacts(SOURCE);
      const afterPurge = await reader.readAttachmentResource(TARGET, copiedId, signal);
      assert.deepEqual(afterPurge, content, 'the copy must survive its source');
    });
  });

  /**
   * The copy id is derived from the two Sessions and the source id, so opening
   * the same material again reuses the copy. Without that, every open would
   * add another few megabytes.
   */
  test('opening the same material again reuses the copy', async () => {
    await withStore(async ({ root, store }) => {
      const created = await store.create({
        sessionId: SOURCE,
        turnId: 'upload',
        name: 'screenshot.png',
        kind: 'image',
        mimeType: 'image/png',
        content: PNG,
        source: 'user_upload',
      });

      const first = await bringIntoSession(store, created.id);
      const second = await bringIntoSession(store, created.id);
      assert.equal(second, first, 'a second open must not mint a second copy');

      const files = await readdir(join(root, 'artifacts', TARGET));
      assert.equal(files.length, 1, `expected one copy, found ${files.join()}`);
    });
  });

  test('a material already in the asking Session needs no copy', async () => {
    await withStore(async ({ root, store }) => {
      const created = await store.create({
        sessionId: TARGET,
        turnId: 'upload',
        name: 'local.png',
        kind: 'image',
        mimeType: 'image/png',
        content: PNG,
        source: 'user_upload',
      });
      const reader = createArtifactAttachmentResourceReader({ artifactStore: store });
      const content = await reader.readAttachmentResource(
        TARGET,
        created.id,
        new AbortController().signal,
      );
      assert.equal((content as { kind: string }).kind, 'image');
      const files = await readdir(join(root, 'artifacts', TARGET));
      assert.equal(files.length, 1, 'reading a local material must not duplicate it');
    });
  });

  /** What the host refuses before copying, stated against the real records. */
  test('the store records the facts the fetch gate checks', async () => {
    await withStore(async ({ store }) => {
      const upload = await store.create({
        sessionId: SOURCE,
        turnId: 'upload',
        name: 'screenshot.png',
        kind: 'image',
        mimeType: 'image/png',
        content: PNG,
        source: 'user_upload',
      });
      const toolResult = await store.create({
        sessionId: SOURCE,
        turnId: 'turn-1',
        name: 'output.txt',
        kind: 'file',
        content: 'tool output',
        source: 'tool_result',
      });
      const pdf = await store.create({
        sessionId: SOURCE,
        turnId: 'upload',
        name: 'contract.pdf',
        kind: 'pdf',
        mimeType: 'application/pdf',
        content: Buffer.from('%PDF-1.4'),
        source: 'user_upload',
      });

      assert.equal((await store.getInSession(SOURCE, upload.id)).record?.source, 'user_upload');
      assert.equal((await store.getInSession(SOURCE, toolResult.id)).record?.source, 'tool_result');
      assert.equal((await store.getInSession(SOURCE, pdf.id)).record?.kind, 'pdf');
      // An id from another Session reads as absent rather than as someone
      // else's record, which is what the gate relies on.
      assert.equal((await store.getInSession(TARGET, upload.id)).record, null);
    });
  });
});
