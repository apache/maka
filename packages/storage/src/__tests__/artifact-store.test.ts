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
import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import {
  ARTIFACT_ENTITY_ID_MAX_CHARS,
  ARTIFACT_TURN_KEY_MAX_CHARS,
  type ArtifactRecord,
} from '@maka/core/artifacts';
import {
  ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES,
  type ArtifactStore,
  type ArtifactStoreWriteAuthority,
  type CreateArtifactInput,
  createSqliteArtifactStore,
  createSqliteArtifactStoreWriteAuthority,
  isSafeRelativeArtifactPath,
  resolveArtifactPath,
  sanitizeArtifactName,
} from '../artifact-store.js';
import { withArtifactWriterLock } from '../artifact-writer-lock.js';
import { createSqliteArtifactMetadataRepository } from '../sqlite-artifact-metadata.js';

const artifactStoreClosersByRoot = new Map<string, Set<() => void>>();

function trackArtifactStoreCloser(root: string, close: () => void): void {
  const closers = artifactStoreClosersByRoot.get(root) ?? new Set<() => void>();
  closers.add(close);
  artifactStoreClosersByRoot.set(root, closers);
}

function createArtifactStore(root: string): ArtifactStore {
  const store = createSqliteArtifactStore(root);
  trackArtifactStoreCloser(root, () => store.close?.());
  return store;
}

function createArtifactStoreWriteAuthority(root: string): ArtifactStoreWriteAuthority {
  const authority = createSqliteArtifactStoreWriteAuthority(root);
  trackArtifactStoreCloser(root, () => authority.close());
  return authority;
}

function closeArtifactStores(root: string): void {
  const closers = artifactStoreClosersByRoot.get(root);
  artifactStoreClosersByRoot.delete(root);
  if (!closers) return;
  for (const close of [...closers].reverse()) close();
}

describe('SQLite Artifact store', () => {
  test('creates a missing workspace root before acquiring the writer lock', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'maka-artifact-missing-root-'));
    const root = join(parent, 'nested', 'workspace');
    try {
      const created = await createArtifactStore(root).create(
        artifactInput('missing-root', 'created', 1),
      );

      assert.equal((await stat(root)).isDirectory(), true);
      assert.equal(created.id, 'missing-root');
      assert.deepEqual(
        (await createArtifactStore(root).list('session-1')).map((record) => record.id),
        ['missing-root'],
      );
    } finally {
      closeArtifactStores(root);
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('publishes stable identities and persists canonical records', async () => {
    await withWorkspace(async (root) => {
      const store = createArtifactStore(root);
      const first = await store.create(artifactInput('artifact-1', '# Notes', 100));
      const second = await store.create({
        ...artifactInput('artifact-2', 'diff --git a/a b/a', 200),
        name: 'patch.diff',
        kind: 'diff',
        source: 'tool_result',
      });

      assert.equal(first.relativePath, 'session-1/artifact-1-artifact-1.txt');
      assert.equal(first.sizeBytes, 7);
      assert.deepEqual(
        (await store.list('session-1')).map((record) => record.id),
        ['artifact-2', 'artifact-1'],
      );
      assert.deepEqual(await store.readText(first.id), { ok: true, text: '# Notes' });

      const reopened = createArtifactStore(root);
      assert.deepEqual(await reopened.get(second.id), second);
      await assert.rejects(
        () => reopened.create(artifactInput('artifact-1', 'replacement', 300)),
        /Artifact artifact-1 already exists/,
      );
      assert.deepEqual(await reopened.readText('artifact-1'), { ok: true, text: '# Notes' });
    });
  });

  test('lists only live Artifacts committed by one exact Turn', async () => {
    await withWorkspace(async (root) => {
      const authority = createArtifactStoreWriteAuthority(root);
      await authority.recover();
      const { store } = authority;
      await store.create({ ...artifactInput('turn-a-new', 'new', 30), turnId: 'turn-a' });
      await store.create({ ...artifactInput('turn-b', 'other turn', 20), turnId: 'turn-b' });
      await store.create({
        ...artifactInput('turn-a-old', 'old', 10),
        turnId: 'turn-a',
      });
      await store.create({
        ...artifactInput('other-session', 'other session', 40),
        sessionId: 'session-2',
        turnId: 'turn-a',
      });

      assert.deepEqual(
        (await store.listTurnArtifacts('session-1', 'turn-a')).map((record) => record.id),
        ['turn-a-new', 'turn-a-old'],
      );
      await store.deleteUserArtifactInSession('session-1', 'turn-a-new');
      assert.deepEqual(
        (await store.listTurnArtifacts('session-1', 'turn-a')).map((record) => record.id),
        ['turn-a-old'],
      );
    });
  });

  test('persists and reopens bounded synthetic turn keys', async () => {
    await withWorkspace(async (root) => {
      for (const [id, turnId] of [
        ['history-artifact', 'history-compact:42'],
        ['synthesis-artifact', 'synthesis-cache:43'],
      ] as const) {
        const input = { ...artifactInput(id, 'compacted', 1), turnId };
        const created = await createArtifactStore(root).create(input);
        assert.equal(created.turnId, input.turnId);
        assert.equal((await createArtifactStore(root).get(created.id))?.turnId, input.turnId);
      }

      for (const turnId of [
        '',
        'history-compact:\n1',
        'synthesis-cache:\u007f1',
        'x'.repeat(ARTIFACT_TURN_KEY_MAX_CHARS + 1),
      ]) {
        await assert.rejects(
          () =>
            createArtifactStore(root).create({
              ...artifactInput(`invalid-${turnId.length}`, 'invalid', 2),
              turnId,
            }),
          /bounded opaque turn key/,
        );
      }
    });
  });

  test('owns stable session revisions across paging, reopen, mutations, and no-ops', async () => {
    await withWorkspace(async (root) => {
      const authority = createArtifactStoreWriteAuthority(root);
      await authority.recover();
      const { store } = authority;
      const empty = await store.listPage('session-1', { offset: 0, limit: 2 });
      assert.equal(empty.total, 0);
      assert.deepEqual(empty.records, []);
      assert.equal((await store.getInSession('session-1', 'missing')).revision, empty.revision);
      assert.equal(
        (await store.listPage('another-empty-session', { offset: 0, limit: 1 })).revision,
        empty.revision,
      );

      const firstInput = artifactInput('first', 'first', 10);
      await store.create(firstInput);
      await store.create(artifactInput('second', 'second', 20));
      const created = await store.listPage('session-1', { offset: 0, limit: 1 });
      assert.equal(created.total, 2);
      assert.deepEqual(
        created.records.map((record) => record.id),
        ['second'],
      );
      assert.equal((await store.getInSession('session-1', 'first')).revision, created.revision);

      const reopenedAuthority = createArtifactStoreWriteAuthority(root);
      await reopenedAuthority.recover();
      const reopenedPage = await reopenedAuthority.store.listPage('session-1', {
        offset: 0,
        limit: 2,
      });
      assert.equal(reopenedPage.revision, created.revision);
      assert.deepEqual(
        reopenedPage.records.map((record) => record.id),
        ['second', 'first'],
      );

      await store.create({
        ...artifactInput('other-session', 'other', 30),
        sessionId: 'session-2',
      });
      assert.equal(
        (await store.listPage('session-1', { offset: 0, limit: 2 })).revision,
        created.revision,
      );
      await store.create(firstInput);
      assert.equal(
        (await store.listPage('session-1', { offset: 0, limit: 2 })).revision,
        created.revision,
      );

      await store.create(artifactInput('revision-race', 'race', 25));
      const deletedResult = await store.deleteUserArtifactInSession('session-1', 'first');
      assert.equal(deletedResult.kind, 'deleted');
      const deleted = await store.listPage('session-1', { offset: 0, limit: 3 });
      assert.notEqual(deleted.revision, created.revision);
      assert.equal(deleted.records.find((record) => record.id === 'first')?.status, 'deleted');
      assert.equal((await store.deleteUserArtifactInSession('session-1', 'first')).kind, 'deleted');
      assert.equal(
        (await store.listPage('session-1', { offset: 0, limit: 3 })).revision,
        deleted.revision,
      );

      await store.create(firstInput);
      const revived = await store.listPage('session-1', { offset: 0, limit: 3 });
      assert.notEqual(revived.revision, deleted.revision);
      assert.equal(revived.records.find((record) => record.id === 'first')?.status, 'live');

      await store.purge(['first', 'second', 'revision-race']);
      const purged = await store.listPage('session-1', { offset: 0, limit: 2 });
      assert.equal(purged.revision, empty.revision);
      assert.equal(purged.total, 0);
    });
  });

  test('copies an exact turn-scoped Artifact snapshot and purges only the target Session', async () => {
    await withWorkspace(async (root) => {
      const authority = createArtifactStoreWriteAuthority(root);
      await authority.recover();
      const { store } = authority;
      const retained = await store.create({
        ...artifactInput('retained-artifact', 'retained', 10),
        turnId: 'turn-retained',
        mimeType: 'text/plain',
      });
      const deleted = await store.create({
        ...artifactInput('deleted-artifact', 'deleted', 11),
        turnId: 'turn-retained',
      });
      await store.delete(deleted.id);
      await store.create({
        ...artifactInput('later-artifact', 'later', 20),
        turnId: 'turn-later',
      });

      const copied = await store.copyConversationArtifacts({
        sourceSessionId: 'session-1',
        targetSessionId: 'session-copy',
        turnIds: ['turn-retained'],
      });
      const copiedId = copied.artifactIds.get(retained.id);
      const copiedDeletedId = copied.artifactIds.get(deleted.id);
      assert.ok(copiedId);
      assert.ok(copiedDeletedId);
      assert.notEqual(copiedId, retained.id);
      const target = await store.list('session-copy');
      assert.equal(target.length, 1);
      assert.equal(target[0]?.id, copiedId);
      assert.equal(target[0]?.turnId, retained.turnId);
      assert.equal(copied.relativePaths.get(retained.relativePath), target[0]?.relativePath);
      assert.deepEqual(await store.readText(copiedId!), {
        ok: true,
        text: 'retained',
      });
      const targetWithTombstones = await store.list('session-copy', { includeDeleted: true });
      assert.equal(targetWithTombstones.find((record) => record.id === copiedId)?.status, 'live');
      const copiedDeleted = targetWithTombstones.find((record) => record.id === copiedDeletedId);
      assert.equal(copiedDeleted?.status, 'deleted');
      assert.equal(copied.relativePaths.get(deleted.relativePath), copiedDeleted?.relativePath);
      assert.deepEqual(await store.readText(copiedDeletedId!, { includeDeleted: true }), {
        ok: true,
        text: 'deleted',
      });

      await store.purgeSessionArtifacts('session-copy');
      assert.deepEqual(await store.list('session-copy'), []);
      assert.deepEqual((await store.list('session-1')).map((record) => record.id).sort(), [
        'later-artifact',
        'retained-artifact',
      ]);
    });
  });

  test('user delete evaluates current-generation policy before tombstone state', async () => {
    await withWorkspace(async (root) => {
      const authority = createArtifactStoreWriteAuthority(root);
      await authority.recover();
      const { store } = authority;
      const input = artifactInput('current-policy', 'replaceable', 1);
      await store.create(input);
      await store.purge([input.id]);
      const protectedRecord = await store.create({
        ...input,
        content: 'protected replacement',
        source: 'deep_research',
      });

      assert.deepEqual(await store.deleteUserArtifactInSession(input.sessionId, input.id), {
        kind: 'protected',
      });
      assert.deepEqual(await store.get(input.id), protectedRecord);
      assert.deepEqual(await store.deleteUserArtifactInSession('different-session', input.id), {
        kind: 'not_found',
      });

      await store.delete(input.id);
      assert.deepEqual(await store.deleteUserArtifactInSession(input.sessionId, input.id), {
        kind: 'protected',
      });
    });
  });

  test('sanitizes adversarial names idempotently across reopen and stable-id retry', async () => {
    const names = [
      '-.gitignore',
      '  . a',
      `${'a'.repeat(119)}- trailing`,
      `${'b'.repeat(119)}. trailing`,
      `${'c'.repeat(119)}  trailing`,
      `${'.-'.repeat(80)}report.txt`,
      `${'d'.repeat(120)}---`,
    ];
    for (const name of names) {
      const sanitized = sanitizeArtifactName(name);
      assert.equal(sanitizeArtifactName(sanitized), sanitized, name);
      assert.ok(sanitized.length > 0 && sanitized.length <= 120, name);
      assert.doesNotMatch(sanitized, /^[ .-]|[ .-]$/, name);
    }
    assert.equal(sanitizeArtifactName('-.gitignore'), 'gitignore');
    assert.equal(sanitizeArtifactName('  . a'), 'a');

    await withWorkspace(async (root) => {
      for (const [index, name] of names.entries()) {
        const input = {
          ...artifactInput(`adversarial-${index}`, `payload-${index}`, index + 1),
          name,
        };
        const created = await createArtifactStore(root).create(input);
        const reopened = createArtifactStore(root);

        assert.deepEqual(await reopened.list(input.sessionId), [
          created,
          ...(await reopened.list(input.sessionId)).filter((record) => record.id !== created.id),
        ]);
        assert.deepEqual(await reopened.get(created.id), created);
        assert.deepEqual(await reopened.readText(created.id), {
          ok: true,
          text: input.content,
        });
        assert.deepEqual(await reopened.create(input), created);
      }
    });
  });

  test('rejects metadata names that neither writer could have produced', async () => {
    for (const name of ['short ', 'embedded\ttab', 'embedded\nnewline']) {
      await withWorkspace(async (root) => {
        await writeArtifactMetadata(root, [
          canonicalRecord({ id: 'invalid-name', sessionId: 'session-1', name, sizeBytes: 0 }),
        ]);
        await assert.rejects(
          () => createArtifactStore(root).list('session-1', { includeDeleted: true }),
          /Invalid artifact metadata record 1/,
        );
      });
    }
  });

  test('does not split a surrogate pair at the persisted name boundary', async () => {
    await withWorkspace(async (root) => {
      const input = {
        ...artifactInput('unicode-boundary', 'boundary', 1),
        name: `${'a'.repeat(119)}😀tail`,
      };
      assert.equal(sanitizeArtifactName(input.name), 'a'.repeat(119));

      const created = await createArtifactStore(root).create(input);
      assert.equal(created.name, 'a'.repeat(119));
      const targetPath = join(root, 'artifacts', created.relativePath);
      const stagingPath = publicationStagingPath(targetPath);
      await writeFile(stagingPath, input.content, { flag: 'wx' });

      const authority = createArtifactStoreWriteAuthority(root);
      const reopened = authority.store;
      await authority.recover();
      await assert.rejects(() => stat(stagingPath), { code: 'ENOENT' });
      assert.deepEqual(await reopened.create(input), created);
      assert.deepEqual(await reopened.readText(created.id), { ok: true, text: input.content });
    });
  });

  test('persists complete canonical deep-research and archived tool-result records', async () => {
    await withWorkspace(async (root) => {
      const store = createArtifactStore(root);
      const report = await store.create({
        id: 'research-report',
        sessionId: 'session-1',
        turnId: 'turn-report',
        name: 'report.html',
        kind: 'html',
        content: '<h1>Research</h1>',
        mimeType: 'text/html',
        source: 'deep_research',
        summary: 'Canonical research report',
        deepResearchRole: 'report',
        now: 100,
      });
      const archive = await store.create({
        id: 'tool-archive',
        sessionId: 'session-1',
        turnId: 'turn-tool',
        name: 'tool-result.json',
        kind: 'file',
        content: '{"ok":true}',
        mimeType: 'application/json',
        source: 'tool_result_archive',
        summary: 'Archived tool result',
        now: 200,
      });

      const reopened = createArtifactStore(root);
      assert.deepEqual(await reopened.get(report.id), report);
      assert.deepEqual(await reopened.get(archive.id), archive);
      assert.deepEqual(await reopened.readText(report.id), {
        ok: true,
        text: '<h1>Research</h1>',
      });
      assert.deepEqual(await reopened.readText(archive.id), {
        ok: true,
        text: '{"ok":true}',
      });
    });
  });

  test('exact live replay returns the canonical record without rewriting or accepting conflicts', async () => {
    await withWorkspace(async (root) => {
      const input = deepResearchArtifactInput('stable-replay', '# Durable result');
      const first = await createArtifactStore(root).create(input);
      const metadataPath = join(root, 'artifacts', 'metadata.jsonl');
      await assert.rejects(() => stat(metadataPath), { code: 'ENOENT' });

      const replayed = await createArtifactStore(root).create(input);
      assert.deepEqual(replayed, first);
      await assert.rejects(() => stat(metadataPath), { code: 'ENOENT' });
      assert.deepEqual(await createArtifactStore(root).readText(first.id), {
        ok: true,
        text: '# Durable result',
      });

      await assert.rejects(
        () =>
          createArtifactStore(root).create({
            ...input,
            content: '# Mutated result',
          }),
        /already exists with different metadata or content/,
      );
      assert.equal(Buffer.byteLength(input.content), Buffer.byteLength('# Mutated result'));
      await assert.rejects(
        () =>
          createArtifactStore(root).create({
            ...input,
            summary: 'Different summary',
          }),
        /already exists with different metadata or content/,
      );
      await assert.rejects(() => stat(metadataPath), { code: 'ENOENT' });
    });
  });

  test('exact tombstone replay atomically revives only an unchanged canonical payload', async () => {
    await withWorkspace(async (root) => {
      const input = deepResearchArtifactInput('stable-revive', '# Revivable');
      const store = createArtifactStore(root);
      const first = await store.create(input);
      await store.delete(first.id);
      const deleted = await store.get(first.id);
      assert.equal(deleted?.status, 'deleted');

      const revived = await createArtifactStore(root).create(input);
      assert.deepEqual(revived, { ...first, status: 'live' });
      assert.deepEqual(await createArtifactStore(root).readText(first.id), {
        ok: true,
        text: '# Revivable',
      });

      const reopened = createArtifactStore(root);
      await reopened.delete(first.id);
      await writeFile(join(root, 'artifacts', first.relativePath), '# Rewritten', 'utf8');
      assert.equal(Buffer.byteLength(input.content), Buffer.byteLength('# Rewritten'));
      await assert.rejects(
        () => createArtifactStore(root).create(input),
        /already exists with different metadata or content/,
      );
      assert.equal((await createArtifactStore(root).get(first.id))?.status, 'deleted');
    });
  });

  test('serializes concurrent creates without dropping metadata', async () => {
    await withWorkspace(async (root) => {
      const store = createArtifactStore(root);
      const ids = Array.from({ length: 12 }, (_, index) => `artifact-${index}`);
      await Promise.all(ids.map((id, index) => store.create(artifactInput(id, id, index + 1))));

      const reopened = createArtifactStore(root);
      const rows = await reopened.list('session-1', { includeDeleted: true });
      assert.deepEqual(rows.map((record) => record.id).sort(), ids.sort());
      await assert.rejects(() => stat(join(root, 'artifacts', 'metadata.jsonl')), {
        code: 'ENOENT',
      });
    });
  });

  test('serializes independent SQLite stores without dropping metadata', async () => {
    await withWorkspace(async (root) => {
      const first = createArtifactStore(root);
      const second = createArtifactStore(root);
      await Promise.all([
        first.create(artifactInput('independent-first', 'first', 1)),
        second.create(artifactInput('independent-second', 'second', 2)),
      ]);

      const rows = await createArtifactStore(root).list('session-1', { includeDeleted: true });
      assert.deepEqual(rows.map((record) => record.id).sort(), [
        'independent-first',
        'independent-second',
      ]);
    });
  });

  test('snapshots mutable create input and bytes before waiting for the writer lock', async () => {
    await withWorkspace(async (root) => {
      let releaseLock!: () => void;
      let lockAcquired!: () => void;
      const acquired = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const holder = withArtifactWriterLock(root, async () => {
        lockAcquired();
        await release;
      });
      await acquired;

      const bytes = Uint8Array.from([0x73, 0x61, 0x66, 0x65]);
      const input: CreateArtifactInput = {
        id: 'accepted-id',
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'accepted.bin',
        kind: 'file',
        content: bytes,
        mimeType: 'application/octet-stream',
        source: 'fixture',
        summary: 'accepted summary',
        now: 7,
      };
      const accepted = createArtifactStore(root).create(input);

      input.id = 'mutated-id';
      input.sessionId = 'mutated-session';
      input.turnId = 'mutated-turn';
      input.name = 'mutated.txt';
      input.kind = 'diff';
      input.content = 'mutated content';
      input.mimeType = 'text/plain';
      input.source = 'tool_result';
      input.summary = 'mutated summary';
      input.now = 99;
      bytes.fill(0x78);
      releaseLock();
      await holder;

      const record = await accepted;
      assert.deepEqual(record, {
        id: 'accepted-id',
        sessionId: 'session-1',
        turnId: 'turn-1',
        createdAt: 7,
        name: 'accepted.bin',
        kind: 'file',
        relativePath: 'session-1/accepted-id-accepted.bin',
        sizeBytes: 4,
        mimeType: 'application/octet-stream',
        source: 'fixture',
        summary: 'accepted summary',
        status: 'live',
      });
      assert.deepEqual(
        await readFile(join(root, 'artifacts', record.relativePath)),
        Buffer.from('safe'),
      );
      const reopened = createArtifactStore(root);
      assert.deepEqual(await reopened.get(record.id), record);
      assert.deepEqual(await reopened.list('session-1'), [record]);
      assert.equal(await reopened.get('mutated-id'), null);
    });
  });

  test('refreshes a loaded SQLite store after another instance commits metadata', async () => {
    await withWorkspace(async (root) => {
      const stale = createArtifactStore(root);
      const writer = createArtifactStore(root);
      await stale.create(artifactInput('first', 'first', 1));
      assert.deepEqual(
        (await stale.list('session-1')).map((record) => record.id),
        ['first'],
      );

      await writer.create(artifactInput('second', 'second', 2));

      assert.deepEqual(
        (await stale.list('session-1')).map((record) => record.id),
        ['second', 'first'],
      );
      assert.equal((await stale.get('second'))?.id, 'second');
      assert.deepEqual(await stale.readText('second'), { ok: true, text: 'second' });
    });
  });

  test('snapshots purge inputs before lock waits', async () => {
    await withWorkspace(async (root) => {
      const authority = createArtifactStoreWriteAuthority(root);
      await authority.recover();
      const { store } = authority;
      await store.create(artifactInput('purge-me', 'purge', 2));
      await store.create(artifactInput('keep-me', 'keep', 3));

      const purgeIds = ['purge-me'];
      const purgeLock = await holdArtifactWriterLock(root);
      const purged = store.purge(purgeIds);
      purgeIds[0] = 'keep-me';
      purgeLock.release();
      await purgeLock.finished;
      await purged;
      assert.equal(await store.get('purge-me'), null);
      assert.equal((await store.get('keep-me'))?.status, 'live');
    });
  });

  test('does not publish a payload after the SQLite metadata repository closes', async () => {
    await withWorkspace(async (root) => {
      const store = createArtifactStore(root);
      await store.create(artifactInput('published', 'kept', 1));
      store.close?.();

      await assert.rejects(
        () => store.create(artifactInput('rejected', 'not durable', 2)),
        /Artifact metadata repository is closed/,
      );
      await assert.rejects(
        () => readFile(join(root, 'artifacts', 'session-1', 'rejected-rejected.txt')),
        { code: 'ENOENT' },
      );
      const reopened = createArtifactStore(root);
      assert.equal(await reopened.get('rejected'), null);
    });
  });

  test('explicit write recovery removes an uncommitted publication and permits stable-id retry', async () => {
    await withWorkspace(async (root) => {
      const residue = await createPublicationResidue(root, 'stable-retry', 'retry.txt', 'old');
      const authority = createArtifactStoreWriteAuthority(root);
      const { store } = authority;

      await assert.rejects(
        () =>
          store.create({
            ...artifactInput('stable-retry', 'new', 1),
            name: 'retry.txt',
          }),
        /Artifact write recovery is required/,
      );
      await assert.rejects(() => store.delete('missing'), /Artifact write recovery is required/);
      await assert.rejects(() => store.purge(['missing']), /Artifact write recovery is required/);
      assert.equal(await readFile(residue.stagingPath, 'utf8'), 'old');
      assert.equal(await readFile(residue.targetPath, 'utf8'), 'old');

      await authority.recover();
      await assert.rejects(() => stat(residue.stagingPath), { code: 'ENOENT' });
      await assert.rejects(() => stat(residue.targetPath), { code: 'ENOENT' });

      const retried = await store.create({
        ...artifactInput('stable-retry', 'new', 1),
        name: 'retry.txt',
      });
      assert.equal(retried.id, 'stable-retry');
      assert.deepEqual(await store.readText(retried.id), { ok: true, text: 'new' });
    });
  });

  test('explicit write recovery completes a committed publication without removing its payload', async () => {
    await withWorkspace(async (root) => {
      const first = createArtifactStore(root);
      const record = await first.create(artifactInput('committed', 'durable', 1));
      const targetPath = join(root, 'artifacts', record.relativePath);
      const stagingPath = publicationStagingPath(targetPath);
      await writeFile(stagingPath, await readFile(targetPath));
      assert.notEqual((await stat(targetPath)).ino, (await stat(stagingPath)).ino);

      const authority = createArtifactStoreWriteAuthority(root);
      const reopened = authority.store;
      await authority.recover();

      await assert.rejects(() => stat(stagingPath), { code: 'ENOENT' });
      assert.equal(await readFile(targetPath, 'utf8'), 'durable');
      assert.deepEqual(await reopened.readText(record.id), { ok: true, text: 'durable' });
    });
  });

  test('self-managed SQLite mutation adopts an exact stable-id target-only orphan', async () => {
    await withWorkspace(async (root) => {
      const input = {
        ...artifactInput('target-orphan', 'orphan bytes', 1),
        name: 'report.txt',
      };
      const orphanPath = join(root, 'artifacts', 'session-1', 'target-orphan-report.txt');
      await mkdir(dirname(orphanPath), { recursive: true });
      await writeFile(orphanPath, input.content, { flag: 'wx' });

      const bare = createArtifactStore(root);
      const adopted = await bare.create(input);
      assert.equal(adopted.name, 'report.txt');
      assert.equal(adopted.relativePath, 'session-1/target-orphan-report.txt');
      assert.deepEqual(await createArtifactStore(root).readText(adopted.id), {
        ok: true,
        text: input.content,
      });
    });
  });

  test('self-managed SQLite mutations recover target-local publications without rescanning unrelated sessions', async () => {
    await withWorkspace(async (root) => {
      const store = createArtifactStore(root);
      await store.create(artifactInput('delete-me', 'delete', 1));
      await store.create(artifactInput('purge-me', 'purge', 2));

      const unrelated = await createPublicationResidue(
        root,
        'unrelated',
        'unrelated.txt',
        'publication bytes',
        'session-2',
      );
      await rm(unrelated.targetPath);
      await writeFile(unrelated.targetPath, 'different bytes');

      const created = await store.create({
        ...artifactInput('target-only', 'created', 3),
        sessionId: 'session-1',
      });
      assert.equal(created.id, 'target-only');
      await store.delete('delete-me');
      await store.purge(['purge-me']);
      assert.equal((await store.get('delete-me'))?.status, 'deleted');
      assert.equal(await store.get('purge-me'), null);

      await assert.rejects(
        () => createArtifactStoreWriteAuthority(root).recover(),
        /Artifact publication residue does not match canonical state/,
      );
    });
  });

  test('authority recovery adopts only its pre-existing exact stable-id orphan snapshot', async () => {
    await withWorkspace(async (root) => {
      const input = artifactInput('drifted-orphan', 'expected bytes', 1);
      const orphanPath = join(root, 'artifacts', 'session-1', 'drifted-orphan-drifted-orphan.txt');
      await mkdir(dirname(orphanPath), { recursive: true });
      await writeFile(orphanPath, 'drifted bytes!', { flag: 'wx' });
      const authority = createArtifactStoreWriteAuthority(root);
      const authorized = authority.store;
      await authority.recover();
      await rm(orphanPath);
      await writeFile(orphanPath, input.content, { flag: 'wx' });

      await assert.rejects(
        () => authorized.create(input),
        /already exists with different metadata or content/,
      );
      assert.equal(await readFile(orphanPath, 'utf8'), input.content);
      await assert.rejects(() => stat(join(root, 'artifacts', 'metadata.jsonl')), {
        code: 'ENOENT',
      });
    });

    await withWorkspace(async (root) => {
      const input = artifactInput('late-payload', 'same bytes', 1);
      const authority = createArtifactStoreWriteAuthority(root);
      const store = authority.store;
      await authority.recover();
      const residue = await createPublicationResidue(
        root,
        input.id,
        input.name,
        input.content as string,
      );

      await assert.rejects(() => store.create(input), /Artifact write recovery is required/);
      assert.equal(await readFile(residue.stagingPath, 'utf8'), input.content);
      assert.equal(await readFile(residue.targetPath, 'utf8'), input.content);
    });
  });

  test('write recovery removes only canonical purge-intent temp files', async () => {
    await withWorkspace(async (root) => {
      const artifactRoot = join(root, 'artifacts');
      await mkdir(artifactRoot, { recursive: true });
      const canonicalTemps = [
        join(
          artifactRoot,
          '.artifact-purge-intent.json.123.00000000-0000-4000-8000-000000000000.tmp',
        ),
      ];
      const unknownFiles = [
        join(artifactRoot, 'metadata.jsonl.123.00000000-0000-4000-8000-000000000000.tmp'),
        join(artifactRoot, 'metadata.jsonl.123.1700000000000.tmp'),
        join(artifactRoot, 'metadata.jsonl.123.not-a-uuid.tmp'),
        join(artifactRoot, '.artifact-purge-intent.json.123.not-a-uuid.tmp'),
        join(artifactRoot, 'other.jsonl.123.00000000-0000-4000-8000-000000000000.tmp'),
      ];
      for (const path of canonicalTemps) await writeFile(path, 'stale', 'utf8');
      for (const path of unknownFiles) await writeFile(path, 'keep', 'utf8');

      await createArtifactStoreWriteAuthority(root).recover();

      for (const path of canonicalTemps) {
        await assert.rejects(() => stat(path), { code: 'ENOENT' });
      }
      for (const path of unknownFiles) assert.equal(await readFile(path, 'utf8'), 'keep');
    });
  });

  test('write recovery fails closed on a non-file canonical transaction temp', async () => {
    await withWorkspace(async (root) => {
      const artifactRoot = join(root, 'artifacts');
      const canonicalTemp = join(
        artifactRoot,
        '.artifact-purge-intent.json.123.00000000-0000-4000-8000-000000000000.tmp',
      );
      await mkdir(canonicalTemp, { recursive: true });

      await assert.rejects(
        () => createArtifactStoreWriteAuthority(root).recover(),
        /Artifact recovery temp is not a regular file/,
      );
      assert.equal((await stat(canonicalTemp)).isDirectory(), true);
    });
  });

  test('fails closed on mismatched publication residue', async () => {
    await withWorkspace(async (root) => {
      const residue = await createPublicationResidue(root, 'mismatch', 'file.txt', 'payload');
      await rm(residue.targetPath);
      await writeFile(residue.targetPath, 'different inode', 'utf8');
      await assert.rejects(
        () => createArtifactStoreWriteAuthority(root).recover(),
        /Artifact publication residue does not match canonical state/,
      );
      assert.equal(await readFile(residue.stagingPath, 'utf8'), 'payload');
      assert.equal(await readFile(residue.targetPath, 'utf8'), 'different inode');
    });
  });

  test('metadata fails closed on invalid path identities and bounded turn keys', async () => {
    const invalidIdentities = [
      { field: 'id', value: 'a'.repeat(ARTIFACT_ENTITY_ID_MAX_CHARS + 1) },
      { field: 'id', value: '.' },
      { field: 'sessionId', value: 'session/bad' },
      { field: 'turnId', value: 'turn\nid' },
      { field: 'turnId', value: 'x'.repeat(ARTIFACT_TURN_KEY_MAX_CHARS + 1) },
    ] as const;

    for (const { field, value } of invalidIdentities) {
      await withWorkspace(async (root) => {
        await writeArtifactMetadata(root, [recordWithIdentity(field, value)]);
        await assert.rejects(
          () => createArtifactStore(root).list('session-1', { includeDeleted: true }),
          /Invalid artifact metadata record 1/,
        );
      });
    }
  });

  test('purge-intent recovery fails closed on non-canonical artifact identities', async () => {
    for (const artifactId of [
      'a'.repeat(ARTIFACT_ENTITY_ID_MAX_CHARS + 1),
      '.',
      'artifact/id',
      'artifact id',
      'artifact\nid',
    ]) {
      await withWorkspace(async (root) => {
        const intentPath = join(root, 'artifacts', '.artifact-purge-intent.json');
        await mkdir(dirname(intentPath), { recursive: true });
        await writeFile(
          intentPath,
          JSON.stringify({ schemaVersion: 1, artifactIds: [artifactId] }),
          'utf8',
        );

        await assert.rejects(
          () => createArtifactStoreWriteAuthority(root).recover(),
          /Invalid artifact purge intent/,
        );
        assert.equal((await stat(intentPath)).isFile(), true);
      });
    }
  });

  test('soft delete tombstones bytes until idempotent purge', async () => {
    await withWorkspace(async (root) => {
      const store = createArtifactStore(root);
      const record = await store.create(artifactInput('artifact-1', '<h1>Report</h1>', 1));

      await store.delete(record.id);
      await store.delete(record.id);
      assert.deepEqual(await store.list('session-1'), []);
      assert.equal((await store.get(record.id))?.status, 'deleted');
      assert.deepEqual(await store.readText(record.id), { ok: false, reason: 'deleted' });
      assert.deepEqual(await store.readText(record.id, { includeDeleted: true }), {
        ok: true,
        text: '<h1>Report</h1>',
      });
      assert.equal(
        await readFile(join(root, 'artifacts', record.relativePath), 'utf8'),
        '<h1>Report</h1>',
      );

      await store.purge([record.id]);
      await store.purge([record.id]);
      assert.equal(await store.get(record.id), null);
      await assert.rejects(() => stat(join(root, 'artifacts', record.relativePath)), {
        code: 'ENOENT',
      });
    });
  });

  test('purge rejects a symlink escape without deleting external bytes or metadata', async (t) => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-artifact-outside-'));
    try {
      await withWorkspace(async (root) => {
        const artifactRoot = join(root, 'artifacts');
        const safeRecord = canonicalRecord({
          id: 'safe',
          sessionId: 'session-1',
          name: 'safe.txt',
          sizeBytes: 4,
        });
        const escapedRecord = canonicalRecord({
          id: 'escaped',
          sessionId: 'linked',
          name: 'victim.txt',
          sizeBytes: 8,
        });
        await mkdir(join(artifactRoot, safeRecord.sessionId), { recursive: true });
        await writeFile(join(artifactRoot, safeRecord.relativePath), 'safe', 'utf8');
        const externalPath = join(outsideRoot, basename(escapedRecord.relativePath));
        await writeFile(externalPath, 'external', 'utf8');
        if (!(await createSymlinkOrSkip(t, outsideRoot, join(artifactRoot, 'linked'), 'dir')))
          return;
        const metadataPath = await writeArtifactMetadata(root, [safeRecord, escapedRecord]);
        const metadataBefore = await readFile(metadataPath, 'utf8');

        const store = createArtifactStore(root);
        await assert.rejects(
          () => store.purge([safeRecord.id, escapedRecord.id]),
          /outside the artifact root/,
        );

        assert.equal(await readFile(externalPath, 'utf8'), 'external');
        assert.equal(await readFile(join(artifactRoot, safeRecord.relativePath), 'utf8'), 'safe');
        assert.equal(await readFile(metadataPath, 'utf8'), metadataBefore);
        assert.equal((await store.get(safeRecord.id))?.id, safeRecord.id);
        assert.equal((await store.get(escapedRecord.id))?.id, escapedRecord.id);
      });
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test('purge unlinks a final symlink without deleting its in-root target', async (t) => {
    await withWorkspace(async (root) => {
      const artifactRoot = join(root, 'artifacts');
      const record = canonicalRecord({
        id: 'linked',
        sessionId: 'session-1',
        name: 'linked.txt',
        sizeBytes: 11,
      });
      const sessionRoot = join(artifactRoot, record.sessionId);
      await mkdir(sessionRoot, { recursive: true });
      const targetPath = join(sessionRoot, 'target.txt');
      const linkPath = join(artifactRoot, record.relativePath);
      await writeFile(targetPath, 'keep target', 'utf8');
      if (!(await createSymlinkOrSkip(t, 'target.txt', linkPath, 'file'))) return;
      await writeArtifactMetadata(root, [record]);

      const store = createArtifactStore(root);
      await store.purge([record.id]);

      assert.equal(await readFile(targetPath, 'utf8'), 'keep target');
      await assert.rejects(() => stat(linkPath), { code: 'ENOENT' });
      assert.equal(await store.get(record.id), null);
    });
  });

  test('purge preserves a payload inode still referenced by a non-target canonical record', async () => {
    await withWorkspace(async (root) => {
      const artifactRoot = join(root, 'artifacts');
      const first = canonicalRecord({
        id: 'first',
        sessionId: 'session-1',
        name: 'first.txt',
        sizeBytes: 12,
      });
      const second = canonicalRecord({
        id: 'second',
        sessionId: 'session-1',
        name: 'second.txt',
        sizeBytes: 12,
      });
      const firstPath = join(artifactRoot, first.relativePath);
      const secondPath = join(artifactRoot, second.relativePath);
      await mkdir(dirname(firstPath), { recursive: true });
      await writeFile(firstPath, 'shared bytes', 'utf8');
      await link(firstPath, secondPath);
      await writeArtifactMetadata(root, [first, second]);
      const firstStat = await stat(firstPath);
      const secondStat = await stat(secondPath);
      assert.equal(firstStat.ino, secondStat.ino);

      const store = createArtifactStore(root);
      await store.purge([first.id]);

      await assert.rejects(() => stat(firstPath), { code: 'ENOENT' });
      assert.equal(await readFile(secondPath, 'utf8'), 'shared bytes');
      assert.equal((await store.get(second.id))?.id, second.id);
      assert.deepEqual(await store.readText(second.id), { ok: true, text: 'shared bytes' });
    });
  });

  test('purge rejects case aliases that resolve to another live record', async (t) => {
    await withWorkspace(async (root) => {
      const artifactRoot = join(root, 'artifacts');
      const lower = canonicalRecord({
        id: 'case',
        sessionId: 'session-1',
        name: 'file.txt',
        sizeBytes: 12,
      });
      const upper = canonicalRecord({
        id: 'CASE',
        sessionId: 'session-1',
        name: 'file.txt',
        sizeBytes: 12,
      });
      const lowerPath = join(artifactRoot, lower.relativePath);
      const upperPath = join(artifactRoot, upper.relativePath);
      await mkdir(dirname(lowerPath), { recursive: true });
      await writeFile(lowerPath, 'shared bytes', 'utf8');
      if (!(await stat(upperPath).catch(() => null))) {
        t.skip('filesystem is case-sensitive');
        return;
      }
      await writeArtifactMetadata(root, [lower, upper]);

      const store = createArtifactStore(root);
      await assert.rejects(() => store.purge([lower.id]), /path is still referenced/);
      assert.equal(await readFile(upperPath, 'utf8'), 'shared bytes');
      assert.equal((await store.get(upper.id))?.status, 'live');
    });
  });

  test('purge rejects case aliases of the same final symlink without unlinking it', async (t) => {
    await withWorkspace(async (root) => {
      const artifactRoot = join(root, 'artifacts');
      const lower = canonicalRecord({
        id: 'case',
        sessionId: 'session-1',
        name: 'file.txt',
        sizeBytes: 12,
      });
      const upper = canonicalRecord({
        id: 'CASE',
        sessionId: 'session-1',
        name: 'file.txt',
        sizeBytes: 12,
      });
      const lowerPath = join(artifactRoot, lower.relativePath);
      const upperPath = join(artifactRoot, upper.relativePath);
      const targetPath = join(dirname(lowerPath), 'target.txt');
      await mkdir(dirname(lowerPath), { recursive: true });
      await writeFile(targetPath, 'shared bytes', 'utf8');
      if (!(await createSymlinkOrSkip(t, 'target.txt', lowerPath, 'file'))) return;
      const upperEntry = await lstat(upperPath).catch(() => null);
      if (!upperEntry?.isSymbolicLink()) {
        t.skip('filesystem is case-sensitive');
        return;
      }
      await writeArtifactMetadata(root, [lower, upper]);

      const store = createArtifactStore(root);
      await assert.rejects(() => store.purge([lower.id]), /path is still referenced/);

      assert.deepEqual(await store.readText(upper.id), { ok: true, text: 'shared bytes' });
      assert.equal((await lstat(lowerPath)).isSymbolicLink(), true);
      assert.equal((await lstat(upperPath)).isSymbolicLink(), true);
      assert.equal(await readFile(targetPath, 'utf8'), 'shared bytes');
    });
  });

  test('startup recovery completes purge after payload removal but before metadata commit', async () => {
    await withWorkspace(async (root) => {
      const authority = createArtifactStoreWriteAuthority(root);
      const store = authority.store;
      await authority.recover();
      const record = await store.create(artifactInput('purge-retry', 'remove me', 1));
      const payloadPath = join(root, 'artifacts', record.relativePath);
      const metadataPath = join(root, 'artifacts', 'metadata.jsonl');
      const purgeIntentPath = join(root, 'artifacts', '.artifact-purge-intent.json');
      await rm(payloadPath);
      await writeFile(
        purgeIntentPath,
        JSON.stringify({ schemaVersion: 1, artifactIds: [record.id] }),
        'utf8',
      );
      await assert.rejects(() => stat(payloadPath), { code: 'ENOENT' });
      assert.equal((await store.get(record.id))?.id, record.id);
      assert.deepEqual(JSON.parse(await readFile(purgeIntentPath, 'utf8')), {
        schemaVersion: 1,
        artifactIds: [record.id],
      });
      await assert.rejects(
        () => store.create(artifactInput('same-instance-blocked', 'blocked', 2)),
        /Artifact write recovery is required/,
      );

      await authority.recover();
      await authority.recover();

      assert.equal(await store.get(record.id), null);
      await assert.rejects(() => stat(metadataPath), { code: 'ENOENT' });
      await assert.rejects(() => stat(purgeIntentPath), { code: 'ENOENT' });
      await store.purge([record.id]);

      await writeFile(
        purgeIntentPath,
        JSON.stringify({ schemaVersion: 1, artifactIds: [record.id] }),
        'utf8',
      );
      await createArtifactStoreWriteAuthority(root).recover();
      await assert.rejects(() => stat(metadataPath), { code: 'ENOENT' });
      await assert.rejects(() => stat(purgeIntentPath), { code: 'ENOENT' });
    });
  });

  test('self-managed SQLite stores recover an interrupted purge before the next write', async () => {
    await withWorkspace(async (root) => {
      const store = createArtifactStore(root);
      const record = await store.create(artifactInput('interrupted-purge', 'remove me', 1));
      await rm(join(root, 'artifacts', record.relativePath));
      await writeFile(
        join(root, 'artifacts', '.artifact-purge-intent.json'),
        JSON.stringify({ schemaVersion: 1, artifactIds: [record.id] }),
        'utf8',
      );

      const reopened = createArtifactStore(root);
      const next = await reopened.create(artifactInput('after-recovery', 'kept', 2));
      assert.equal(next.id, 'after-recovery');
      assert.equal(await reopened.get(record.id), null);
      await assert.rejects(() => stat(join(root, 'artifacts', '.artifact-purge-intent.json')), {
        code: 'ENOENT',
      });
    });
  });

  test('durable attachment reads authenticate the owning session and reject tombstoned bytes', async () => {
    await withWorkspace(async (root) => {
      const store = createArtifactStore(root);
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await store.create({ ...artifactInput('image', png, 1), name: 'image.png', kind: 'image' });
      await store.delete('image');

      assert.deepEqual(await store.readBinary('image'), { ok: false, reason: 'deleted' });
      assert.deepEqual(
        await store.readDurableAttachmentBinary({
          artifactId: 'image',
          sessionId: 'other-session',
        }),
        { ok: false, reason: 'session_mismatch' },
      );
      assert.deepEqual(
        await store.readDurableAttachmentBinary({
          artifactId: 'image',
          sessionId: 'session-1',
        }),
        { ok: false, reason: 'deleted' },
      );
    });
  });

  test('enforces preview limits and sniffed binary MIME types', async () => {
    await withWorkspace(async (root) => {
      const store = createArtifactStore(root);
      await store.create(
        artifactInput('large', 'x'.repeat(ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES + 1), 1),
      );
      await store.create({
        ...artifactInput('unknown', Uint8Array.from([0, 1, 2, 3]), 2),
        name: 'unknown.bin',
      });

      assert.deepEqual(await store.readText('large'), { ok: false, reason: 'too_large' });
      assert.deepEqual(await store.readBinary('unknown'), {
        ok: false,
        reason: 'unsupported_mime',
      });
    });
  });

  test('persists canonical entity identities at the shared 128-character boundary', async () => {
    await withWorkspace(async (root) => {
      const boundaryId = 'a'.repeat(ARTIFACT_ENTITY_ID_MAX_CHARS);
      const store = createArtifactStore(root);
      const record = await store.create({
        id: boundaryId,
        sessionId: boundaryId,
        turnId: boundaryId,
        name: 'boundary.txt',
        kind: 'file',
        content: 'boundary',
        now: 1,
      });

      assert.equal(record.id.length, ARTIFACT_ENTITY_ID_MAX_CHARS);
      assert.deepEqual(await createArtifactStore(root).get(boundaryId), record);
      assert.deepEqual(await createArtifactStore(root).list(boundaryId), [record]);
    });
  });

  test('create rejects invalid path identities and bounded turn keys', async () => {
    const invalidInputs = [
      {
        expected: /Artifact id must be a canonical entity ID/,
        input: { ...artifactInput('a'.repeat(ARTIFACT_ENTITY_ID_MAX_CHARS + 1), 'no', 1) },
      },
      {
        expected: /Artifact id must be a canonical entity ID/,
        input: { ...artifactInput('.', 'no', 1) },
      },
      {
        expected: /Artifact sessionId must be a canonical entity ID/,
        input: { ...artifactInput('valid', 'no', 1), sessionId: 'session/bad' },
      },
      {
        expected: /Artifact turnId must be a bounded opaque turn key/,
        input: { ...artifactInput('valid', 'no', 1), turnId: '' },
      },
      {
        expected: /Artifact turnId must be a bounded opaque turn key/,
        input: { ...artifactInput('valid', 'no', 1), turnId: 'turn\nid' },
      },
      {
        expected: /Artifact turnId must be a bounded opaque turn key/,
        input: {
          ...artifactInput('valid', 'no', 1),
          turnId: 'x'.repeat(ARTIFACT_TURN_KEY_MAX_CHARS + 1),
        },
      },
    ] as const;

    for (const { expected, input } of invalidInputs) {
      await withWorkspace(async (root) => {
        await assert.rejects(() => createArtifactStore(root).create(input), expected);
        await assert.rejects(() => stat(join(root, 'artifacts')), { code: 'ENOENT' });
      });
    }
  });

  test('keeps relative path resolution inside the artifact root', async () => {
    assert.equal(isSafeRelativeArtifactPath('session-1/artifact.txt'), true);
    for (const value of ['', '/tmp/file', '../file', 'session/../file', 'file:///tmp/a']) {
      assert.equal(isSafeRelativeArtifactPath(value), false, value);
    }
    assert.equal(sanitizeArtifactName(' ../unsafe:name?.txt '), 'unsafe-name-.txt');

    await withWorkspace(async (root) => {
      assert.deepEqual(
        await resolveArtifactPath({
          artifactRoot: join(root, 'artifacts'),
          relativePath: '../outside',
        }),
        { ok: false, reason: 'not_allowed' },
      );
    });
  });

  test('resolve and read reject a canonical payload that escapes through a symlink', async (t) => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-artifact-read-outside-'));
    try {
      await withWorkspace(async (root) => {
        const artifactRoot = join(root, 'artifacts');
        const record = canonicalRecord({
          id: 'escaped',
          sessionId: 'session-1',
          name: 'secret.txt',
          sizeBytes: 6,
        });
        await mkdir(join(artifactRoot, record.sessionId), { recursive: true });
        const outsidePath = join(outsideRoot, 'secret.txt');
        await writeFile(outsidePath, 'secret', 'utf8');
        if (
          !(await createSymlinkOrSkip(
            t,
            outsidePath,
            join(artifactRoot, record.relativePath),
            'file',
          ))
        ) {
          return;
        }
        await writeArtifactMetadata(root, [record]);

        assert.deepEqual(
          await resolveArtifactPath({
            artifactRoot,
            relativePath: record.relativePath,
          }),
          { ok: false, reason: 'not_allowed' },
        );
        assert.deepEqual(await createArtifactStore(root).readText(record.id), {
          ok: false,
          reason: 'not_allowed',
        });
      });
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test('create path and identity failures leave no payload or metadata', async (t) => {
    await withWorkspace(async (root) => {
      const store = createArtifactStore(root);
      await assert.rejects(
        () => store.create({ ...artifactInput('bad/id', 'no', 1) }),
        /Artifact id must be a canonical entity ID/,
      );
      await assert.rejects(
        () =>
          store.create({
            ...artifactInput('invalid-role', 'no', 1),
            deepResearchRole: 'invalid' as never,
          }),
        /Invalid Artifact deep-research role/,
      );
      await assert.rejects(() => stat(join(root, 'artifacts')), { code: 'ENOENT' });
    });

    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-artifact-create-outside-'));
    try {
      await withWorkspace(async (root) => {
        const artifactRoot = join(root, 'artifacts');
        await mkdir(artifactRoot, { recursive: true });
        if (!(await createSymlinkOrSkip(t, outsideRoot, join(artifactRoot, 'session-1'), 'dir'))) {
          return;
        }

        await assert.rejects(
          () => createArtifactStore(root).create(artifactInput('escaped', 'must not write', 1)),
          /target directory resolves outside the artifact root/,
        );
        assert.deepEqual(await readdir(outsideRoot), []);
        await assert.rejects(() => stat(join(artifactRoot, 'metadata.jsonl')), {
          code: 'ENOENT',
        });
        assert.deepEqual((await readdir(artifactRoot)).sort(), ['session-1']);
      });
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

function artifactInput(id: string, content: string | Uint8Array, now: number) {
  return {
    id,
    sessionId: 'session-1',
    turnId: 'turn-1',
    name: `${id}.txt`,
    kind: 'file' as const,
    content,
    source: 'fixture' as const,
    now,
  };
}

function deepResearchArtifactInput(id: string, content: string) {
  return {
    id,
    sessionId: 'session-1',
    turnId: 'turn-1',
    name: 'research.md',
    kind: 'file' as const,
    content,
    mimeType: 'text/markdown',
    source: 'deep_research' as const,
    summary: 'Stable research artifact',
    deepResearchRole: 'source' as const,
  };
}

function canonicalRecord(input: {
  id: string;
  sessionId: string;
  name: string;
  sizeBytes: number;
}): ArtifactRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    turnId: 'turn-1',
    createdAt: 1,
    name: input.name,
    kind: 'file',
    relativePath: `${input.sessionId}/${input.id}-${input.name}`,
    sizeBytes: input.sizeBytes,
    source: 'fixture',
    status: 'live',
  };
}

function recordWithIdentity(field: 'id' | 'sessionId' | 'turnId', value: string): ArtifactRecord {
  const record = canonicalRecord({
    id: 'artifact-1',
    sessionId: 'session-1',
    name: 'artifact.txt',
    sizeBytes: 0,
  });
  const mutated = { ...record, [field]: value };
  return {
    ...mutated,
    relativePath: `${mutated.sessionId}/${mutated.id}-${mutated.name}`,
  };
}

async function writeArtifactMetadata(
  root: string,
  records: readonly ArtifactRecord[],
): Promise<string> {
  const repository = createSqliteArtifactMetadataRepository(root);
  try {
    repository.replaceAll(records);
  } finally {
    repository.close();
  }
  return join(root, 'runtime.sqlite');
}

async function createSymlinkOrSkip(
  t: TestContext,
  target: string,
  path: string,
  type: 'file' | 'dir',
): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      t.skip('Windows symlink creation requires elevated privileges or Developer Mode');
      return false;
    }
    throw error;
  }
}

async function createPublicationResidue(
  root: string,
  id: string,
  name: string,
  content: string,
  sessionId = 'session-1',
): Promise<{ stagingPath: string; targetPath: string }> {
  const sessionDirectory = join(root, 'artifacts', sessionId);
  await mkdir(sessionDirectory, { recursive: true });
  const targetPath = join(sessionDirectory, `${id}-${name}`);
  const stagingPath = publicationStagingPath(targetPath);
  await writeFile(stagingPath, content, { flag: 'wx' });
  await link(stagingPath, targetPath);
  return { stagingPath, targetPath };
}

async function holdArtifactWriterLock(
  root: string,
): Promise<{ release: () => void; finished: Promise<void> }> {
  let release!: () => void;
  let acquired!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const finished = withArtifactWriterLock(root, async () => {
    acquired();
    await gate;
  });
  await entered;
  return { release, finished };
}

function publicationStagingPath(targetPath: string): string {
  const hash = createHash('sha256').update(basename(targetPath)).digest('hex');
  return join(
    dirname(targetPath),
    `.artifact-publish.${hash}.00000000-0000-4000-8000-000000000000.tmp`,
  );
}

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-store-'));
  try {
    await run(root);
  } finally {
    closeArtifactStores(root);
    await rm(root, { recursive: true, force: true });
  }
}
