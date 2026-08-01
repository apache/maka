import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import type { ArtifactRecord } from '@maka/core/artifacts';
import {
  createSqliteArtifactStore,
  createSqliteArtifactStoreWriteAuthority,
} from '../artifact-store.js';
import * as artifactStoreModule from '../artifact-store.js';
import { withArtifactWriterLock } from '../artifact-writer-lock.js';

describe('SQLite artifact metadata', () => {
  test('does not expose the retired JSONL Artifact writer', () => {
    assert.equal(Reflect.has(artifactStoreModule, 'createArtifactStore'), false);
    assert.equal(Reflect.has(artifactStoreModule, 'createArtifactStoreWriteAuthority'), false);
  });

  test('cuts over legacy metadata once and makes SQLite canonical without rewriting JSONL', async () => {
    await withWorkspace(async (root) => {
      const migrated = await seedLegacyArtifact(root, artifactInput('migrated', 'legacy bytes', 1));
      const metadataPath = join(root, 'artifacts', 'metadata.jsonl');
      const legacyMetadata = await readFile(metadataPath);

      const store = createSqliteArtifactStore(root);
      try {
        assert.deepEqual(await store.get(migrated.id), migrated);
        const created = await store.create(artifactInput('sqlite', 'canonical bytes', 2));
        await store.delete(migrated.id);

        assert.deepEqual(await readFile(metadataPath), legacyMetadata);
        assert.ok((await stat(join(root, 'runtime.sqlite'))).isFile());
        assert.deepEqual(await store.readText(created.id), {
          ok: true,
          text: 'canonical bytes',
        });
      } finally {
        store.close?.();
      }

      const reopened = createSqliteArtifactStore(root);
      try {
        assert.equal((await reopened.get(migrated.id))?.status, 'deleted');
        assert.equal((await reopened.get('sqlite'))?.status, 'live');
      } finally {
        reopened.close?.();
      }
    });
  });

  test('resumes an interrupted cutover atomically', async () => {
    await withWorkspace(async (root) => {
      const record = await seedLegacyArtifact(root, artifactInput('legacy', 'durable', 1));
      const interrupted = createSqliteArtifactStore(root, {
        failpoint: (point) => {
          if (point === 'after_cutover_rows_copied') {
            throw new Error('simulated cutover crash');
          }
        },
      });
      await assert.rejects(() => interrupted.list('session-1'), /simulated cutover crash/);
      interrupted.close?.();

      const recovered = createSqliteArtifactStore(root);
      try {
        assert.deepEqual(await recovered.list('session-1'), [record]);
        assert.deepEqual(await recovered.readText(record.id), { ok: true, text: 'durable' });
      } finally {
        recovered.close?.();
      }
    });
  });

  test('runs the first legacy cutover under the artifact writer lock', async () => {
    await withWorkspace(async (root) => {
      await seedLegacyArtifact(root, artifactInput('legacy', 'durable', 1));
      const held = await holdArtifactWriterLock(root);
      const store = createSqliteArtifactStore(root);
      let settled = false;
      const opening = store.list('session-1').finally(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);

      held.release();
      await held.finished;
      assert.equal((await opening)[0]?.id, 'legacy');
      store.close?.();
    });
  });

  test('fails closed when an old writer changes JSONL after cutover', async () => {
    await withWorkspace(async (root) => {
      await seedLegacyArtifact(root, artifactInput('legacy', 'durable', 1));
      const store = createSqliteArtifactStore(root);
      await store.list('session-1');
      store.close?.();

      await seedLegacyArtifact(root, artifactInput('old-writer', 'stale', 2));
      const reopened = createSqliteArtifactStore(root);
      try {
        await assert.rejects(
          () => reopened.list('session-1'),
          /Legacy artifact_metadata source changed after cutover completed/,
        );
      } finally {
        reopened.close?.();
      }
    });
  });

  test('recovery removes a payload whose SQLite metadata transaction did not commit', async () => {
    await withWorkspace(async (root) => {
      const residue = await createPublicationResidue(
        root,
        'uncommitted',
        'uncommitted.txt',
        'not committed',
      );
      const authority = createSqliteArtifactStoreWriteAuthority(root);
      try {
        await authority.recover();
        await assert.rejects(() => stat(residue.stagingPath), { code: 'ENOENT' });
        await assert.rejects(() => stat(residue.targetPath), { code: 'ENOENT' });
        assert.equal(await authority.store.get('uncommitted'), null);
      } finally {
        authority.close();
      }
    });
  });

  test('recovery keeps a committed payload and removes its publication staging file', async () => {
    await withWorkspace(async (root) => {
      const initial = createSqliteArtifactStore(root);
      const record = await initial.create(artifactInput('committed', 'durable', 1));
      initial.close?.();

      const targetPath = join(root, 'artifacts', record.relativePath);
      const stagingPath = publicationStagingPath(targetPath);
      await writeFile(stagingPath, await readFile(targetPath));

      const authority = createSqliteArtifactStoreWriteAuthority(root);
      try {
        await authority.recover();
        await assert.rejects(() => stat(stagingPath), { code: 'ENOENT' });
        assert.equal(await readFile(targetPath, 'utf8'), 'durable');
        assert.deepEqual(await authority.store.readText(record.id), {
          ok: true,
          text: 'durable',
        });
      } finally {
        authority.close();
      }
    });
  });

  test('recovery completes a purge interrupted before the SQLite metadata commit', async () => {
    await withWorkspace(async (root) => {
      const authority = createSqliteArtifactStoreWriteAuthority(root);
      try {
        await authority.recover();
        const record = await authority.store.create(artifactInput('purge-retry', 'remove me', 1));
        const payloadPath = join(root, 'artifacts', record.relativePath);
        const purgeIntentPath = join(root, 'artifacts', '.artifact-purge-intent.json');
        await rm(payloadPath);
        await writeFile(
          purgeIntentPath,
          JSON.stringify({ schemaVersion: 1, artifactIds: [record.id] }),
          'utf8',
        );

        await authority.recover();
        assert.equal(await authority.store.get(record.id), null);
        await assert.rejects(() => stat(purgeIntentPath), { code: 'ENOENT' });
      } finally {
        authority.close();
      }
    });
  });

  test('does not create legacy metadata for a new SQLite-backed store', async () => {
    await withWorkspace(async (root) => {
      const store = createSqliteArtifactStore(root);
      try {
        const record = await store.create(artifactInput('sqlite-only', 'bytes', 1));
        assert.equal(await readFile(join(root, 'artifacts', record.relativePath), 'utf8'), 'bytes');
        await assert.rejects(() => stat(join(root, 'artifacts', 'metadata.jsonl')), {
          code: 'ENOENT',
        });
      } finally {
        store.close?.();
      }
    });
  });
});

function artifactInput(id: string, content: string, now: number) {
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

async function seedLegacyArtifact(
  root: string,
  input: ReturnType<typeof artifactInput>,
): Promise<ArtifactRecord> {
  const relativePath = `${input.sessionId}/${input.id}-${input.name}`;
  const payloadPath = join(root, 'artifacts', relativePath);
  const metadataPath = join(root, 'artifacts', 'metadata.jsonl');
  await mkdir(dirname(payloadPath), { recursive: true });
  await writeFile(payloadPath, input.content);
  const record: ArtifactRecord = {
    id: input.id,
    sessionId: input.sessionId,
    turnId: input.turnId,
    createdAt: input.now,
    name: input.name,
    kind: input.kind,
    relativePath,
    sizeBytes: Buffer.byteLength(input.content),
    source: input.source,
    status: 'live',
  };
  let existing = '';
  try {
    existing = await readFile(metadataPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(metadataPath, `${existing}${JSON.stringify(record)}\n`);
  return record;
}

async function createPublicationResidue(
  root: string,
  id: string,
  name: string,
  content: string,
): Promise<{ stagingPath: string; targetPath: string }> {
  const targetPath = join(root, 'artifacts', 'session-1', `${id}-${name}`);
  const stagingPath = publicationStagingPath(targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
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
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-artifact-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
