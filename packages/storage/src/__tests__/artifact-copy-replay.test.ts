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
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ArtifactRecord } from '@maka/core/artifacts';
import {
  createSqliteArtifactStoreWriteAuthority,
  type ArtifactAuthorityStore,
  type ConversationArtifactCopyInput,
} from '../artifact-store.js';
import { createSqliteArtifactMetadataRepository } from '../sqlite-artifact-metadata.js';

const copyInput: ConversationArtifactCopyInput = {
  sourceSessionId: 'source',
  targetSessionId: 'target',
  turnIds: [],
  includeArtifactIds: ['attachment'],
  existingTarget: 'reuse_verified',
};
const conflict = /already exists with different metadata or content/;

test('verified artifact copy replays after reopen and concurrent writers without rewriting', async () => {
  await withStores(async (root, openStore) => {
    const first = openStore();
    await createSource(first, Buffer.alloc(2 * 1024 * 1024 + 7, 42));
    const second = openStore();
    const [copy, concurrent] = await Promise.all([
      first.copyConversationArtifacts(copyInput),
      second.copyConversationArtifacts(copyInput),
    ]);
    assert.deepEqual(copy, concurrent);
    const original = await targetRecord(first);
    const file = join(root, 'artifacts', original.relativePath);
    const before = await stat(file);
    first.close();
    second.close();
    const reopened = openStore();
    assert.deepEqual(await reopened.copyConversationArtifacts(copyInput), copy);
    assert.deepEqual(await targetRecord(reopened), original);
    const after = await stat(file);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ctimeMs, before.ctimeMs);
    assert.equal((await reopened.listPage('target', { offset: 0, limit: 10 })).total, 1);
    // Other conversation-copy consumers keep their strict no-existing-target contract.
    await assert.rejects(
      reopened.copyConversationArtifacts({ ...copyInput, existingTarget: undefined }),
      /Artifact target already exists/,
    );
  });
});

test('verified copy rejects conflicting ownership and every retained metadata field', async () => {
  await withStores(async (root, openStore) => {
    const store = openStore();
    await createSource(store);
    await store.copyConversationArtifacts(copyInput);
    const original = await targetRecord(store);
    const metadata = createSqliteArtifactMetadataRepository(root);
    try {
      const variants: Partial<ArtifactRecord>[] = [
        { sessionId: 'foreign' },
        { turnId: 'other-upload' },
        { name: 'different.txt' },
        { kind: 'diff' },
        { mimeType: 'application/json' },
        { source: 'tool_result' },
        { sizeBytes: original.sizeBytes + 1 },
        { createdAt: original.createdAt + 1 },
        { summary: 'different summary' },
        { deepResearchRole: 'report' },
      ];
      for (const patch of variants) {
        const changed = { ...original, ...patch };
        changed.relativePath = `${changed.sessionId}/${changed.id}-${changed.name}`;
        metadata.applyChanges({ upserts: [changed] });
        await assert.rejects(store.copyConversationArtifacts(copyInput), conflict);
        assert.deepEqual(
          metadata.readAll().find((r) => r.id === original.id),
          changed,
        );
        assert.equal(
          await readFile(join(root, 'artifacts', original.relativePath), 'utf8'),
          'requirements',
        );
        metadata.applyChanges({ upserts: [original] });
      }
      assert.deepEqual(await targetRecord(store), original);
      await store.copyConversationArtifacts(copyInput);
    } finally {
      metadata.close();
    }
  });
});

for (const changedSide of ['source', 'target'] as const) {
  test(`verified copy rejects changed, truncated, extended or missing ${changedSide} payload without replacing it`, async () => {
    await withStores(async (root, openStore) => {
      const store = openStore();
      const source = await createSource(store);
      await store.copyConversationArtifacts(copyInput);
      const target = await targetRecord(store);
      const changed = changedSide === 'source' ? source : target;
      const path = join(root, 'artifacts', changed.relativePath);
      for (const payload of ['REQUIREMENTS', 'short', 'requirements plus extra']) {
        await writeFile(path, payload);
        await assert.rejects(store.copyConversationArtifacts(copyInput), conflict);
        assert.equal(await readFile(path, 'utf8'), payload);
        assert.deepEqual(await targetRecord(store), target);
      }
      await rm(path);
      await assert.rejects(store.copyConversationArtifacts(copyInput));
      await assert.rejects(stat(path), { code: 'ENOENT' });
    });
  });
}

test('verified copy converges after a partially copied attachment batch', async () => {
  await withStores(async (root, openStore) => {
    const store = openStore();
    await createSource(store);
    const other = await store.create({
      sessionId: 'source',
      turnId: 'upload-2',
      id: 'second-attachment',
      name: 'other.txt',
      kind: 'file',
      source: 'user_upload',
      mimeType: 'text/plain',
      content: 'second file',
      now: 2,
    });
    const path = join(root, 'artifacts', other.relativePath);
    await rm(path);
    const request = { ...copyInput, includeArtifactIds: ['attachment', other.id] };
    await assert.rejects(store.copyConversationArtifacts(request));
    const firstCopy = await targetRecord(store);
    await writeFile(path, 'second file');
    store.close();
    const reopened = openStore();
    const copied = await reopened.copyConversationArtifacts(request);
    assert.equal(copied.artifactIds.size, 2);
    assert.deepEqual((await reopened.getInSession('target', firstCopy.id)).record, firstCopy);
    assert.equal((await reopened.listPage('target', { offset: 0, limit: 10 })).total, 2);
    assert.deepEqual(await reopened.copyConversationArtifacts(request), copied);
  });
});

async function createSource(
  store: ArtifactAuthorityStore,
  content: string | Uint8Array = 'requirements',
) {
  return store.create({
    sessionId: 'source',
    turnId: 'upload-1',
    id: 'attachment',
    name: 'requirements.txt',
    kind: 'file',
    source: 'user_upload',
    mimeType: 'text/plain',
    content,
    now: 1,
  });
}

async function targetRecord(store: ArtifactAuthorityStore): Promise<ArtifactRecord> {
  const page = await store.listPage('target', { offset: 0, limit: 10 });
  assert.equal(page.total, 1);
  return page.records[0]!;
}

async function withStores(
  run: (root: string, openStore: () => ArtifactAuthorityStore) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-copy-replay-'));
  const authorities: ReturnType<typeof createSqliteArtifactStoreWriteAuthority>[] = [];
  try {
    await run(root, () => {
      const authority = createSqliteArtifactStoreWriteAuthority(root);
      authorities.push(authority);
      return authority.store;
    });
  } finally {
    for (const authority of authorities.reverse()) authority.close();
    await rm(root, { recursive: true, force: true });
  }
}
