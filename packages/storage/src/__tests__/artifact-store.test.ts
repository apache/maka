import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  link,
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
import { ARTIFACT_ENTITY_ID_MAX_CHARS, type ArtifactRecord } from '@maka/core/artifacts';
import {
  ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES,
  createArtifactStore,
  isSafeRelativeArtifactPath,
  resolveArtifactPath,
  sanitizeArtifactName,
} from '../artifact-store.js';

describe('FileArtifactStore', () => {
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
      const metadataBefore = await readFile(metadataPath, 'utf8');

      const replayed = await createArtifactStore(root).create(input);
      assert.deepEqual(replayed, first);
      assert.equal(await readFile(metadataPath, 'utf8'), metadataBefore);
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
      assert.equal(await readFile(metadataPath, 'utf8'), metadataBefore);
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

  test('failed tombstone revival leaves the durable tombstone recoverable', async () => {
    await withWorkspace(async (root) => {
      const input = deepResearchArtifactInput('stable-revive-retry', '# Revivable');
      const store = createArtifactStore(root);
      const first = await store.create(input);
      await store.delete(first.id);
      const metadataPath = join(root, 'artifacts', 'metadata.jsonl');
      const deletedMetadata = await readFile(metadataPath, 'utf8');
      await rm(metadataPath);
      await mkdir(metadataPath);

      await assert.rejects(() => store.create(input));
      assert.equal((await store.get(first.id))?.status, 'deleted');

      await rm(metadataPath, { recursive: true });
      await writeFile(metadataPath, deletedMetadata, 'utf8');
      const reopened = createArtifactStore(root);
      assert.equal((await reopened.get(first.id))?.status, 'deleted');
      const revived = await reopened.create(input);
      assert.equal(revived.status, 'live');
      assert.equal(revived.createdAt, first.createdAt);
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
      const metadata = await readFile(join(root, 'artifacts', 'metadata.jsonl'), 'utf8');
      assert.equal(metadata.trim().split('\n').length, ids.length);
    });
  });

  test('does not publish a payload when metadata publication fails', async () => {
    await withWorkspace(async (root) => {
      const store = createArtifactStore(root);
      await store.create(artifactInput('published', 'kept', 1));
      const metadataPath = join(root, 'artifacts', 'metadata.jsonl');
      const metadata = await readFile(metadataPath, 'utf8');
      await rm(metadataPath);
      await mkdir(metadataPath);

      await assert.rejects(() => store.create(artifactInput('rejected', 'not durable', 2)));
      await assert.rejects(
        () => readFile(join(root, 'artifacts', 'session-1', 'rejected-rejected.txt')),
        { code: 'ENOENT' },
      );
      assert.equal(await store.get('rejected'), null);

      await rm(metadataPath, { recursive: true });
      await writeFile(metadataPath, metadata, 'utf8');
    });
  });

  test('explicit write recovery removes an uncommitted publication and permits stable-id retry', async () => {
    await withWorkspace(async (root) => {
      const residue = await createPublicationResidue(root, 'stable-retry', 'retry.txt', 'old');
      const store = createArtifactStore(root);

      await store.recoverForWrite();
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
      await link(targetPath, stagingPath);

      const reopened = createArtifactStore(root);
      await reopened.recoverForWrite();

      await assert.rejects(() => stat(stagingPath), { code: 'ENOENT' });
      assert.equal(await readFile(targetPath, 'utf8'), 'durable');
      assert.deepEqual(await reopened.readText(record.id), { ok: true, text: 'durable' });
    });
  });

  test('fails closed on malformed metadata and mismatched publication residue', async () => {
    await withWorkspace(async (root) => {
      const metadataPath = join(root, 'artifacts', 'metadata.jsonl');
      await mkdir(join(root, 'artifacts'), { recursive: true });
      await writeFile(metadataPath, '{"id":"incomplete","status":"live"}\n', 'utf8');
      await assert.rejects(
        () => createArtifactStore(root).list('session-1'),
        /Invalid artifact metadata line 1/,
      );
    });

    await withWorkspace(async (root) => {
      const residue = await createPublicationResidue(root, 'mismatch', 'file.txt', 'payload');
      await rm(residue.targetPath);
      await writeFile(residue.targetPath, 'different inode', 'utf8');
      await assert.rejects(
        () => createArtifactStore(root).recoverForWrite(),
        /Artifact publication residue does not match canonical state/,
      );
      assert.equal(await readFile(residue.stagingPath, 'utf8'), 'payload');
      assert.equal(await readFile(residue.targetPath, 'utf8'), 'different inode');
    });
  });

  test('metadata fails closed on non-canonical artifact, session, and turn identities', async () => {
    const invalidIdentities = [
      { field: 'id', value: 'a'.repeat(ARTIFACT_ENTITY_ID_MAX_CHARS + 1) },
      { field: 'id', value: '.' },
      { field: 'sessionId', value: 'session/bad' },
      { field: 'turnId', value: 'turn id' },
      { field: 'turnId', value: 'turn\nid' },
    ] as const;

    for (const { field, value } of invalidIdentities) {
      await withWorkspace(async (root) => {
        await writeArtifactMetadata(root, [recordWithIdentity(field, value)]);
        await assert.rejects(
          () => createArtifactStore(root).list('session-1', { includeDeleted: true }),
          /Invalid artifact metadata line 1/,
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
          () => createArtifactStore(root).recoverForWrite(),
          /Invalid artifact purge intent/,
        );
        assert.equal((await stat(intentPath)).isFile(), true);
      });
    }
  });

  test('fails loud when the metadata path cannot be read as a file', async () => {
    await withWorkspace(async (root) => {
      const metadataPath = join(root, 'artifacts', 'metadata.jsonl');
      await mkdir(metadataPath, { recursive: true });

      await assert.rejects(
        () => createArtifactStore(root).list('session-1'),
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error && error.code === 'EISDIR',
      );
      assert.equal((await stat(metadataPath)).isDirectory(), true);
    });
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

  test('startup recovery completes purge after payload removal but before metadata commit', async () => {
    await withWorkspace(async (root) => {
      const store = createArtifactStore(root);
      const record = await store.create(artifactInput('purge-retry', 'remove me', 1));
      const payloadPath = join(root, 'artifacts', record.relativePath);
      const metadataPath = join(root, 'artifacts', 'metadata.jsonl');
      const purgeIntentPath = join(root, 'artifacts', '.artifact-purge-intent.json');
      const metadata = await readFile(metadataPath, 'utf8');
      await rm(metadataPath);
      await mkdir(metadataPath);

      await assert.rejects(() => store.purge([record.id]));
      await assert.rejects(() => stat(payloadPath), { code: 'ENOENT' });
      assert.equal((await store.get(record.id))?.id, record.id);
      assert.deepEqual(JSON.parse(await readFile(purgeIntentPath, 'utf8')), {
        schemaVersion: 1,
        artifactIds: [record.id],
      });

      await rm(metadataPath, { recursive: true });
      await writeFile(metadataPath, metadata, 'utf8');
      const reopened = createArtifactStore(root);
      await reopened.recoverForWrite();
      await reopened.recoverForWrite();

      assert.equal(await reopened.get(record.id), null);
      assert.equal(await readFile(metadataPath, 'utf8'), '');
      await assert.rejects(() => stat(purgeIntentPath), { code: 'ENOENT' });
      await reopened.purge([record.id]);

      await writeFile(
        purgeIntentPath,
        JSON.stringify({ schemaVersion: 1, artifactIds: [record.id] }),
        'utf8',
      );
      await createArtifactStore(root).recoverForWrite();
      assert.equal(await readFile(metadataPath, 'utf8'), '');
      await assert.rejects(() => stat(purgeIntentPath), { code: 'ENOENT' });
    });
  });

  test('durable attachment reads authenticate the owning session and retain tombstoned bytes', async () => {
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
      const result = await store.readDurableAttachmentBinary({
        artifactId: 'image',
        sessionId: 'session-1',
      });
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(Buffer.from(result.base64, 'base64'), Buffer.from(png));
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

  test('create rejects non-canonical artifact, session, and turn identities', async () => {
    const invalidInputs = [
      {
        field: 'id',
        input: { ...artifactInput('a'.repeat(ARTIFACT_ENTITY_ID_MAX_CHARS + 1), 'no', 1) },
      },
      {
        field: 'id',
        input: { ...artifactInput('.', 'no', 1) },
      },
      {
        field: 'sessionId',
        input: { ...artifactInput('valid', 'no', 1), sessionId: 'session/bad' },
      },
      {
        field: 'turnId',
        input: { ...artifactInput('valid', 'no', 1), turnId: 'turn id' },
      },
      {
        field: 'turnId',
        input: { ...artifactInput('valid', 'no', 1), turnId: 'turn\nid' },
      },
    ] as const;

    for (const { field, input } of invalidInputs) {
      await withWorkspace(async (root) => {
        await assert.rejects(
          () => createArtifactStore(root).create(input),
          new RegExp(`Artifact ${field} must be a canonical entity ID`),
        );
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
  const metadataPath = join(root, 'artifacts', 'metadata.jsonl');
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(
    metadataPath,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
  return metadataPath;
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
): Promise<{ stagingPath: string; targetPath: string }> {
  const sessionDirectory = join(root, 'artifacts', 'session-1');
  await mkdir(sessionDirectory, { recursive: true });
  const targetPath = join(sessionDirectory, `${id}-${name}`);
  const stagingPath = publicationStagingPath(targetPath);
  await writeFile(stagingPath, content, { flag: 'wx' });
  await link(stagingPath, targetPath);
  return { stagingPath, targetPath };
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
    await rm(root, { recursive: true, force: true });
  }
}
