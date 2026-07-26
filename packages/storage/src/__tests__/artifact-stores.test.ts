import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  ArtifactStoreLifecycleError,
  authenticateInteractiveArtifactStoreReader,
  authenticateInteractiveArtifactStoreWriter,
  openInteractiveArtifactStoreForRead,
  openInteractiveArtifactStoreForWrite,
  type InteractiveArtifactStoreReader,
  type InteractiveArtifactStoreWriter,
} from '../artifact-stores.js';
import {
  createHeadlessRootLease,
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type StorageRootLease,
} from '../root-authority.js';

describe('interactive artifact store authority', () => {
  test('requires authentic leases and facades', async () => {
    await withTemporaryRoot('headless', async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'headless' });
      const lease = createHeadlessRootLease(capability, 'write');
      await assert.rejects(
        () =>
          openInteractiveArtifactStoreForWrite(
            lease as unknown as StorageRootLease<'interactive', 'write'>,
          ),
        invalidLease,
      );
    });

    assert.throws(
      () =>
        authenticateInteractiveArtifactStoreReader({} as unknown as InteractiveArtifactStoreReader),
      invalidLease,
    );
    assert.throws(
      () =>
        authenticateInteractiveArtifactStoreWriter({} as unknown as InteractiveArtifactStoreWriter),
      invalidLease,
    );
  });

  test('returns one authenticated writer per lease and keeps close terminal', async () => {
    await withInteractiveOwner(async (owner) => {
      const [first, second] = await Promise.all([
        openInteractiveArtifactStoreForWrite(owner.lease),
        openInteractiveArtifactStoreForWrite(owner.lease),
      ]);

      assert.strictEqual(first, second);
      assert.strictEqual(authenticateInteractiveArtifactStoreWriter(first), first);
      await first.recover();
      await first.close();
      assert.strictEqual(await openInteractiveArtifactStoreForWrite(owner.lease), first);
      await assert.rejects(
        () => first.create(artifactInput('after-close', 'not published')),
        lifecycleError('closed'),
      );
      assert.throws(() => first.get('after-close'), lifecycleError('closed'));
    });
  });

  test('drain rejects new mutations and waits for an accepted publication', async () => {
    await withInteractiveOwner(async (owner) => {
      const writer = await openInteractiveArtifactStoreForWrite(owner.lease);
      await writer.recover();
      const accepted = writer.create(
        artifactInput('accepted', new Uint8Array(8 * 1024 * 1024).fill(0x61)),
      );
      const drained = writer.beginDrain();

      await assert.rejects(() => writer.delete('accepted'), lifecycleError('draining'));
      await drained;
      const record = await accepted;
      assert.equal(record.sizeBytes, 8 * 1024 * 1024);
      assert.equal((await writer.get(record.id))?.id, record.id);
    });
  });

  test('root close revokes new facade operations after draining an in-flight write', async () => {
    await withTemporaryRoot('interactive', async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const writer = await openInteractiveArtifactStoreForWrite(owner.lease);
      await writer.recover();
      const accepted = writer.create(
        artifactInput('accepted', new Uint8Array(8 * 1024 * 1024).fill(0x62)),
      );

      await owner.close();
      assert.equal((await accepted).id, 'accepted');
      await assert.rejects(() => writer.list('session-1'), invalidLease);
    });
  });

  test('shared reader exposes only live reads under its own lease', async () => {
    await withTemporaryRoot('interactive', async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const writer = await openInteractiveArtifactStoreForWrite(owner.lease);
      await writer.recover();
      await writer.create(artifactInput('published', 'reader-visible'));
      await writer.close();
      await owner.close();

      const readerHandle = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerHandle);
      try {
        const reader = await openInteractiveArtifactStoreForRead(readerHandle.lease);
        assert.strictEqual(authenticateInteractiveArtifactStoreReader(reader), reader);
        assert.deepEqual(await reader.readText('published'), {
          ok: true,
          text: 'reader-visible',
        });
      } finally {
        await readerHandle.close();
      }
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

function lifecycleError(code: 'draining' | 'closed') {
  return (error: unknown) => error instanceof ArtifactStoreLifecycleError && error.code === code;
}

async function withInteractiveOwner(
  run: (
    owner: NonNullable<Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>>,
  ) => Promise<void>,
): Promise<void> {
  await withTemporaryRoot('interactive', async (root) => {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    try {
      await run(owner);
    } finally {
      await owner.close();
    }
  });
}

async function withTemporaryRoot(
  kind: 'interactive' | 'headless',
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `maka-artifact-${kind}-`));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
