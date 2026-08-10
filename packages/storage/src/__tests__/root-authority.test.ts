import assert from 'node:assert/strict';
import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { withArtifactWriterLock } from '../artifact-writer-lock.js';
import {
  adoptStorageRootOnImport,
  assertStorageRootCapability,
  assertStorageRootLease,
  discoverMarkedStorageRoot,
  prepareArtifactWriterBootstrapAuthority,
  prepareStorageRootControlDirectory,
  prepareStorageRootIdentityRepair,
  repairStorageRootIdentity,
  resolveExistingStorageRoot,
  resolveExistingStorageRootControlDirectory,
  resolveRootControlNamespace,
  resolveStorageRoot,
  runWithStorageRootLease,
  STORAGE_ROOT_MARKER_FILE,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type StorageRootCapability,
  type StorageRootLease,
} from '../root-authority.js';

// These probes launch native-lock holders and deliberately exercise abnormal
// process exits. Keep them on the owning storage seam's stress route; the
// default suite covers the same-process lease and lock boundaries below.
const RUN_PROCESS_LOCK_TESTS = process.env.MAKA_STORAGE_STRESS === '1';

describe('storage root authority', () => {
  test('discovers only marked roots without creating or changing filesystem state', async () => {
    await withRoots(async ({ base, root }) => {
      const initialized = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const payloadPath = join(root, 'payload.txt');
      await writeFile(payloadPath, 'preserve me');
      const fixedTime = new Date('2020-01-02T03:04:05.000Z');
      await utimes(join(root, STORAGE_ROOT_MARKER_FILE), fixedTime, fixedTime);
      await utimes(payloadPath, fixedTime, fixedTime);
      await utimes(root, fixedTime, fixedTime);
      const before = await snapshotFlatRoot(root);

      const discovered = await discoverMarkedStorageRoot({ path: root });
      assert.equal(discovered.kind, 'interactive');
      assert.equal(discovered.rootId, initialized.rootId);
      assert.equal(discovered.canonicalPath, initialized.canonicalPath);
      assert.deepEqual(await snapshotFlatRoot(root), before);

      const unmarked = join(base, 'unmarked');
      await mkdir(unmarked);
      const unmarkedBefore = await snapshotFlatRoot(unmarked);
      await assert.rejects(
        () => discoverMarkedStorageRoot({ path: unmarked }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_unmarked',
      );
      assert.deepEqual(await snapshotFlatRoot(unmarked), unmarkedBefore);

      const missing = join(base, 'missing');
      await assert.rejects(
        () => discoverMarkedStorageRoot({ path: missing }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_not_found',
      );
      await assert.rejects(lstat(missing), { code: 'ENOENT' });
    });
  });

  test('rejects unsupported root kinds without transient marker writes', async () => {
    await withRoots(async ({ root }) => {
      await resolveStorageRoot({ path: root, kind: 'interactive' });
      const fixedTime = new Date('2020-01-02T03:04:05.000Z');
      await utimes(join(root, STORAGE_ROOT_MARKER_FILE), fixedTime, fixedTime);
      await utimes(root, fixedTime, fixedTime);
      const before = await snapshotFlatRoot(root);

      await assert.rejects(
        () => resolveStorageRoot({ path: root, kind: 'retired' as never }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_root_kind',
      );
      assert.deepEqual(await snapshotFlatRoot(root), before);
    });
  });

  test('canonicalizes aliases and gives them one ownership identity', async () => {
    await withRoots(async ({ base, root }) => {
      const alias = join(base, 'alias');
      await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');

      const direct = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const throughAlias = await resolveStorageRoot({ path: alias, kind: 'interactive' });

      assert.equal(throughAlias.canonicalPath, direct.canonicalPath);
      assert.equal(throughAlias.rootId, direct.rootId);
    });
  });

  test('derives Artifact writer bootstrap authority from stable filesystem identity', async () => {
    await withRoots(async ({ base, root }) => {
      const alias = join(base, 'alias');
      const movedRoot = join(base, 'moved-root');
      await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');

      const direct = await prepareArtifactWriterBootstrapAuthority(root);
      const throughAlias = await prepareArtifactWriterBootstrapAuthority(alias);
      assert.equal(throughAlias.lockPath, direct.lockPath);
      assert.equal(throughAlias.canonicalPath, direct.canonicalPath);
      assert.deepEqual(await readdir(root), []);

      await rename(root, movedRoot);
      await assert.rejects(() => direct.assertCurrentRoot());
      const moved = await prepareArtifactWriterBootstrapAuthority(movedRoot);
      assert.equal(moved.lockPath, direct.lockPath);

      await mkdir(root);
      const replacement = await prepareArtifactWriterBootstrapAuthority(root);
      assert.notEqual(replacement.lockPath, direct.lockPath);
      assert.deepEqual(await readdir(root), []);

      await Promise.all([
        rm(direct.lockPath, { force: true }),
        rm(replacement.lockPath, { force: true }),
      ]);
    });
  });

  test('rejects a marker from another device even when its inode matches', async () => {
    await withRoots(async ({ root }) => {
      await resolveStorageRoot({ path: root, kind: 'interactive' });
      const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
        rootIdentity: { dev: string; ino: string };
      };
      marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
      await writeFile(markerPath, `${JSON.stringify(marker)}\n`);

      await assert.rejects(
        () => resolveStorageRoot({ path: root, kind: 'interactive' }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_identity_collision',
      );
    });
  });

  test('explicitly repairs a stale root identity without changing its root id', async () => {
    await withRoots(async ({ root }) => {
      const initialized = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
        rootIdentity: { dev: string; ino: string };
      };
      marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
      await writeFile(markerPath, `${JSON.stringify(marker)}\n`);

      const candidate = await prepareStorageRootIdentityRepair({
        path: root,
        kind: 'interactive',
      });
      assert.ok(candidate);
      const repaired = await repairStorageRootIdentity(candidate);
      const rootStat = await lstat(root, { bigint: true });
      const repairedMarker = JSON.parse(await readFile(markerPath, 'utf8')) as {
        rootId: string;
        rootIdentity: { dev: string; ino: string };
      };

      assert.equal(repaired.rootId, initialized.rootId);
      assert.equal(repairedMarker.rootId, initialized.rootId);
      assert.deepEqual(repairedMarker.rootIdentity, {
        dev: rootStat.dev.toString(),
        ino: rootStat.ino.toString(),
      });
      assert.equal(
        (await resolveStorageRoot({ path: root, kind: 'interactive' })).rootId,
        initialized.rootId,
      );
    });
  });

  test('rejects a prepared repair when its marker changes before commit', async () => {
    await withRoots(async ({ root }) => {
      await resolveStorageRoot({ path: root, kind: 'interactive' });
      const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
        rootId: string;
        rootIdentity: { dev: string };
      };
      marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
      await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
      const candidate = await prepareStorageRootIdentityRepair({
        path: root,
        kind: 'interactive',
      });
      assert.ok(candidate);

      marker.rootId = '0'.repeat(64);
      const replacedMarker = `${JSON.stringify(marker)}\n`;
      await writeFile(markerPath, replacedMarker);

      await assert.rejects(
        () => repairStorageRootIdentity(candidate),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_identity_changed',
      );
      assert.equal(await readFile(markerPath, 'utf8'), replacedMarker);
    });
  });

  test('serializes concurrent repairs across marker replacement', async () => {
    await withRoots(async ({ root }) => {
      await resolveStorageRoot({ path: root, kind: 'interactive' });
      const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
        rootIdentity: { dev: string };
      };
      marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
      await writeFile(markerPath, `${JSON.stringify(marker)}\n`);

      const [first, second] = await Promise.all([
        prepareStorageRootIdentityRepair({ path: root, kind: 'interactive' }),
        prepareStorageRootIdentityRepair({ path: root, kind: 'interactive' }),
      ]);
      assert.ok(first);
      assert.ok(second);

      const results = await Promise.allSettled([
        repairStorageRootIdentity(first),
        repairStorageRootIdentity(second),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const rejected = results.find((result) => result.status === 'rejected');
      assert.ok(rejected);
      assert.ok(rejected.reason instanceof StorageRootAuthorityError);
      assert.notEqual(rejected.reason.code, 'invalid_marker');
      assert.ok(
        rejected.reason.code === 'root_identity_changed' ||
          rejected.reason.code === 'root_identity_collision',
      );
      await resolveStorageRoot({ path: root, kind: 'interactive' });
    });
  });

  test('serializes identity repair behind the Artifact bootstrap writer lock', async () => {
    await withRoots(async ({ root }) => {
      await resolveStorageRoot({ path: root, kind: 'interactive' });
      let releaseWriter!: () => void;
      const writerBlocked = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      let writerAdmitted!: () => void;
      const admitted = new Promise<void>((resolve) => {
        writerAdmitted = resolve;
      });
      const writer = withArtifactWriterLock(root, async () => {
        writerAdmitted();
        await writerBlocked;
      });
      await admitted;

      const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
        rootIdentity: { dev: string };
      };
      marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
      await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
      const candidate = await prepareStorageRootIdentityRepair({
        path: root,
        kind: 'interactive',
      });
      assert.ok(candidate);

      let repairSettled = false;
      const repair = repairStorageRootIdentity(candidate).finally(() => {
        repairSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(repairSettled, false);

      releaseWriter();
      await writer;
      await repair;
      await resolveStorageRoot({ path: root, kind: 'interactive' });
    });
  });

  test('rejects a copied initialized root before it can share authority', async () => {
    await withRoots(async ({ base, root }) => {
      await resolveStorageRoot({ path: root, kind: 'interactive' });
      const copiedRoot = join(base, 'copied-root');
      await cp(root, copiedRoot, { recursive: true });

      await assert.rejects(
        () => resolveStorageRoot({ path: copiedRoot, kind: 'interactive' }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_identity_collision',
      );
    });
  });

  test('adopts the host-local identity of an explicitly imported storage root', async () => {
    await withRoots(async ({ base, root }) => {
      const initialized = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const copiedRoot = join(base, 'copied-root');
      await cp(root, copiedRoot, { recursive: true });

      await assert.rejects(
        () => resolveStorageRoot({ path: copiedRoot, kind: 'interactive' }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_identity_collision',
      );
      const markerBeforeConflict = await readFile(
        join(copiedRoot, STORAGE_ROOT_MARKER_FILE),
        'utf8',
      );
      await assert.rejects(
        () =>
          adoptStorageRootOnImport({
            path: copiedRoot,
            kind: 'interactive',
            expectedRootId: '0'.repeat(64),
          }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_identity_collision',
      );
      assert.equal(
        await readFile(join(copiedRoot, STORAGE_ROOT_MARKER_FILE), 'utf8'),
        markerBeforeConflict,
      );
      await rm(root, { recursive: true, force: true });

      const adopted = await adoptStorageRootOnImport({
        path: copiedRoot,
        kind: 'interactive',
        expectedRootId: initialized.rootId,
      });
      assert.equal(adopted.rootId, initialized.rootId);
      assert.equal(
        (
          await adoptStorageRootOnImport({
            path: copiedRoot,
            kind: 'interactive',
            expectedRootId: initialized.rootId,
          })
        ).rootId,
        initialized.rootId,
      );
      assert.equal(
        (await resolveStorageRoot({ path: copiedRoot, kind: 'interactive' })).rootId,
        initialized.rootId,
      );
    });
  });

  test('resolves only an existing expected root without initializing a replacement', async () => {
    await withRoots(async ({ base, root }) => {
      const initialized = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const existing = await resolveExistingStorageRoot({
        path: root,
        kind: 'interactive',
        expectedRootId: initialized.rootId,
      });
      assert.equal(existing.rootId, initialized.rootId);

      await rename(root, join(base, 'original-root'));
      await mkdir(root);
      await assert.rejects(
        () =>
          resolveExistingStorageRoot({
            path: root,
            kind: 'interactive',
            expectedRootId: initialized.rootId,
          }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_unmarked',
      );
      await assert.rejects(readFile(join(root, STORAGE_ROOT_MARKER_FILE)), { code: 'ENOENT' });
    });
  });

  test('rejects replacement before opening the temporary marker', async () => {
    await withRoots(async ({ base, root }) => {
      const originalRoot = join(base, 'original-root');
      const child = fork(
        new URL('./fixtures/root-initialization-race.js', import.meta.url),
        [root, STORAGE_ROOT_MARKER_FILE],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      );
      try {
        await waitForChildMessage(
          child,
          (message): message is { type: 'marker_open_pending' } =>
            message.type === 'marker_open_pending',
          'marker_open_pending',
        );
        await rename(root, originalRoot);
        await mkdir(root);

        const outcomePromise = waitForChildMessage(
          child,
          (message): message is RootResolverMessage =>
            message.type === 'resolved' || message.type === 'error',
          'resolver outcome',
        );
        child.send('resume');
        assert.deepEqual(await outcomePromise, {
          type: 'error',
          code: 'root_identity_changed',
        });
        child.disconnect();
        await waitForExit(child);

        await assert.rejects(lstat(join(root, STORAGE_ROOT_MARKER_FILE)), { code: 'ENOENT' });
        const replacement = await resolveStorageRoot({ path: root, kind: 'interactive' });
        await assert.doesNotReject(() => assertStorageRootCapability(replacement, 'interactive'));
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await waitForExit(child);
        }
      }
    });
  });

  test('rejects a regular file as a typed invalid root', async () => {
    await withRoots(
      async ({ root }) => {
        await writeFile(root, 'not a directory');
        await assert.rejects(
          () => resolveStorageRoot({ path: root, kind: 'interactive' }),
          (error: unknown) =>
            error instanceof StorageRootAuthorityError && error.code === 'invalid_root',
        );
      },
      { createRoot: false },
    );
  });

  test('rejects an unsupported root kind before creating filesystem state', async () => {
    await withRoots(
      async ({ root }) => {
        await assert.rejects(
          () => resolveStorageRoot({ path: root, kind: 'unsupported' as 'interactive' }),
          (error: unknown) =>
            error instanceof StorageRootAuthorityError && error.code === 'invalid_root_kind',
        );
        await assert.rejects(lstat(root), { code: 'ENOENT' });
      },
      { createRoot: false },
    );
  });

  test('normalizes root filesystem failures at the public authority boundary', async () => {
    await withRoots(
      async ({ base }) => {
        const blockingFile = join(base, 'blocking-file');
        await writeFile(blockingFile, 'not a directory');

        await assert.rejects(
          () => resolveStorageRoot({ path: join(blockingFile, 'root'), kind: 'interactive' }),
          (error: unknown) =>
            error instanceof StorageRootAuthorityError &&
            error.code === 'root_io_failed' &&
            error.cause instanceof Error,
        );
      },
      { createRoot: false },
    );
  });

  test('preserves unexpected marker I/O failures at the public authority boundary', {
    skip:
      process.platform === 'win32'
        ? 'POSIX permissions are required to make the marker unreadable'
        : typeof process.getuid === 'function' && process.getuid() === 0,
  }, async () => {
    await withRoots(async ({ root }) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
      await chmod(markerPath, 0o000);
      try {
        await assert.rejects(
          () => assertStorageRootCapability(capability, 'interactive'),
          (error: unknown) =>
            error instanceof StorageRootAuthorityError &&
            error.code === 'root_io_failed' &&
            error.cause instanceof Error &&
            'code' in error.cause &&
            (error.cause as NodeJS.ErrnoException).code === 'EACCES',
        );
      } finally {
        await chmod(markerPath, 0o600);
      }
    });
  });

  test('keeps one owner when a live root moves behind a new alias', async () => {
    await withRoots(async ({ base, root }) => {
      const firstCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const firstOwner = await tryAcquireInteractiveRootOwner(firstCapability);
      assert.ok(firstOwner);

      const movedRoot = join(base, 'moved-root');
      await rename(root, movedRoot);
      await symlink(movedRoot, root, process.platform === 'win32' ? 'junction' : 'dir');

      const movedCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      assert.equal(movedCapability.rootId, firstCapability.rootId);
      assert.equal(await tryAcquireInteractiveRootOwner(movedCapability), undefined);

      await firstOwner.close();
      const nextOwner = await tryAcquireInteractiveRootOwner(movedCapability);
      assert.ok(nextOwner);
      await nextOwner.close();
    });
  });

  test('concurrent initialization resolves one interactive root identity', async () => {
    await withRoots(
      async ({ root }) => {
        const outcomes = await Promise.all([
          resolveStorageRoot({ path: root, kind: 'interactive' }),
          resolveStorageRoot({ path: root, kind: 'interactive' }),
        ]);
        assert.equal(outcomes[0].rootId, outcomes[1].rootId);
      },
      { createRoot: false },
    );
  });

  test('rejects an unbounded root marker before parsing it', async () => {
    await withRoots(async ({ root }) => {
      await writeFile(join(root, STORAGE_ROOT_MARKER_FILE), Buffer.alloc(1_025, 0x20));
      await assert.rejects(
        () => resolveStorageRoot({ path: root, kind: 'interactive' }),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_marker',
      );
    });
  });

  test('rejects FIFO marker paths without blocking root resolution', {
    skip: process.platform === 'win32',
  }, async () => {
    await withRoots(async ({ base, root }) => {
      const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
      createFifo(markerPath);
      assert.deepEqual(await resolveRootInChild(root), {
        type: 'error',
        code: 'invalid_marker',
      });

      await rm(markerPath);
      const fifoPath = join(base, 'marker.fifo');
      createFifo(fifoPath);
      await symlink(fifoPath, markerPath);
      assert.deepEqual(await resolveRootInChild(root), {
        type: 'error',
        code: 'invalid_marker',
      });
    });
  });

  test('rejects forged capabilities and invalidates a lease when its OS lock closes', async () => {
    await withRoots(async ({ root }) => {
      const forged = {
        kind: 'interactive',
        canonicalPath: root,
        rootId: 'forged',
      } as StorageRootCapability<'interactive'>;
      await assert.rejects(
        () => assertStorageRootCapability(forged, 'interactive'),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_capability',
      );

      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      await assertStorageRootLease(owner.lease, 'interactive', 'write');
      await owner.close();
      await assert.rejects(
        () => assertStorageRootLease(owner.lease, 'interactive', 'write'),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );

      const forgedLease = {
        kind: 'interactive',
        access: 'write',
        canonicalPath: root,
        rootId: capability.rootId,
      } as StorageRootLease<'interactive', 'write'>;
      await assert.rejects(
        () => assertStorageRootLease(forgedLease, 'interactive', 'write'),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
    });
  });

  test('keeps the owner lock until an admitted lease operation drains', async () => {
    await withRoots(async ({ root }) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;

      let releaseOperation!: () => void;
      const operationBlocked = new Promise<void>((resolve) => {
        releaseOperation = resolve;
      });
      let operationAdmitted!: () => void;
      const admitted = new Promise<void>((resolve) => {
        operationAdmitted = resolve;
      });
      const operation = runWithStorageRootLease(owner.lease, 'interactive', 'write', async () => {
        operationAdmitted();
        await operationBlocked;
      });
      await admitted;

      const closing = owner.close();
      assert.equal(owner.closed, true);
      assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);
      await assert.rejects(
        () => runWithStorageRootLease(owner.lease, 'interactive', 'write', async () => {}),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );

      releaseOperation();
      await Promise.all([operation, closing]);
      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successor);
      await successor?.close();
    });
  });

  test('enforces exclusive/shared lock arbitration across processes', {
    skip: !RUN_PROCESS_LOCK_TESTS,
  }, async () => {
    await withRoots(async ({ root }) => {
      const writer = spawnHolder(root, 'write');
      try {
        assert.equal(await waitForHolder(writer), 'locked');
        const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
        assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);
        assert.equal(await tryAcquireInteractiveRootReader(capability), undefined);
      } finally {
        await closeHolder(writer);
      }

      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const firstReader = spawnHolder(root, 'read');
      const secondReader = spawnHolder(root, 'read');
      try {
        assert.deepEqual(
          await Promise.all([waitForHolder(firstReader), waitForHolder(secondReader)]),
          ['locked', 'locked'],
        );
        const localReader = await tryAcquireInteractiveRootReader(capability);
        assert.ok(localReader);
        assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);
        await localReader?.close();
      } finally {
        await Promise.all([closeHolder(firstReader), closeHolder(secondReader)]);
      }

      const nextOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(nextOwner);
      await nextOwner.close();
    });
  });

  test('rejects a lock path that aliases another filesystem object', {
    skip:
      process.platform === 'win32'
        ? 'Windows file-symlink permissions are not guaranteed in CI'
        : false,
  }, async () => {
    await withRoots(async ({ base, root }) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
      const foreignLock = join(base, 'foreign.lock');
      await writeFile(foreignLock, 'not an authority\n');
      await symlink(foreignLock, join(controlDirectory, 'owner.lock'));

      await assert.rejects(
        () => tryAcquireInteractiveRootOwner(capability),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lock_artifact',
      );
    });
  });

  test('rejects a directory at the owner lock path', async () => {
    await withRoots(async ({ root }) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
      await mkdir(join(controlDirectory, 'owner.lock'));

      await assert.rejects(
        () => tryAcquireInteractiveRootOwner(capability),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'invalid_lock_artifact',
      );
    });
  });

  test('does not create a missing control directory while resolving an existing Host', async () => {
    await withRoots(async ({ root }) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
      await rm(controlDirectory, { recursive: true, force: true });

      await assert.rejects(
        () => resolveExistingStorageRootControlDirectory(capability),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'control_io_failed',
      );
      await assert.rejects(lstat(controlDirectory), { code: 'ENOENT' });
    });
  });

  test('validates an existing control directory without repairing its permissions', {
    skip: process.platform === 'win32',
  }, async () => {
    await withRoots(async ({ root }) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
      await chmod(controlDirectory, 0o755);

      await assert.rejects(
        () => resolveExistingStorageRootControlDirectory(capability),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'insecure_control_directory',
      );
      assert.equal((await lstat(controlDirectory)).mode & 0o777, 0o755);
    });
  });

  test('kernel releases a process lock after normal, uncaught, abort, and forced exits', {
    skip: !RUN_PROCESS_LOCK_TESTS,
  }, async () => {
    await withRoots(async ({ root }) => {
      const modes = ['close', 'throw', 'abort', 'SIGKILL'] as const;
      for (const mode of modes) {
        const holder = spawnHolder(root, 'write');
        assert.equal(await waitForHolder(holder), 'locked');
        const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
        assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);

        const exited = waitForExit(holder);
        if (mode === 'SIGKILL') holder.kill(mode);
        else holder.send(mode);
        await exited;

        const owner = await retryAcquire(capability);
        assert.ok(owner);
        await owner?.close();
      }
    });
  });

  test('does not inherit the owner lock into a surviving descendant', {
    skip: !RUN_PROCESS_LOCK_TESTS,
  }, async () => {
    await withRoots(async ({ root }) => {
      const holder = spawnHolder(root, 'write');
      let descendantPid: number | undefined;
      try {
        assert.equal(await waitForHolder(holder), 'locked');
        const descendant = waitForDescendant(holder);
        const holderExited = waitForExit(holder);
        holder.send('spawn-descendant');
        descendantPid = await descendant;
        await holderExited;
        assert.equal(isProcessAlive(descendantPid), true);

        const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
        const owner = await retryAcquire(capability);
        assert.ok(owner);
        await owner?.close();
      } finally {
        terminateProcess(descendantPid);
        if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
      }
    });
  });

  test('fails closed when a capability root is replaced', async () => {
    await withRoots(async ({ base, root }) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      await rename(root, join(base, 'old-root'));
      await mkdir(root);
      await assert.rejects(
        () => assertStorageRootCapability(capability, 'interactive'),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_identity_changed',
      );
    });
  });
});

async function snapshotFlatRoot(root: string): Promise<{
  entries: Array<{ name: string; content: string; mtimeNs: bigint }>;
  mtimeNs: bigint;
}> {
  const names = (await readdir(root)).sort();
  const entries = await Promise.all(
    names.map(async (name) => {
      const path = join(root, name);
      const stats = await lstat(path, { bigint: true });
      return {
        name,
        content: stats.isFile() ? await readFile(path, 'utf8') : '',
        mtimeNs: stats.mtimeNs,
      };
    }),
  );
  const rootStats = await lstat(root, { bigint: true });
  return { entries, mtimeNs: rootStats.mtimeNs };
}

async function withRoots(
  run: (input: { base: string; root: string }) => Promise<void>,
  options: { createRoot?: boolean } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-root-authority-'));
  const root = join(base, 'root');
  if (options.createRoot !== false) await mkdir(root);
  try {
    await run({ base, root });
  } finally {
    await removeControlDirectoriesForRootsUnder(base);
    await rm(base, { recursive: true, force: true });
  }
}

function waitForHolder(child: ChildProcess): Promise<'locked' | 'denied'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('lock holder did not report readiness')),
      5_000,
    );
    child.once('error', reject);
    child.once('message', (message) => {
      clearTimeout(timer);
      if (isHolderMessage(message)) resolve(message.type);
      else reject(new Error(`unexpected holder message: ${JSON.stringify(message)}`));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`lock holder exited early: ${code ?? signal}`));
    });
  });
}

function isHolderMessage(value: unknown): value is { type: 'locked' | 'denied' } {
  return (
    !!value &&
    typeof value === 'object' &&
    ((value as { type?: unknown }).type === 'locked' ||
      (value as { type?: unknown }).type === 'denied')
  );
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function spawnHolder(root: string, access: 'read' | 'write'): ChildProcess {
  return fork(new URL('./fixtures/root-lock-holder.js', import.meta.url), [root, access], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}

type RootResolverMessage = { type: 'resolved' } | { type: 'error'; code: string };

type InitializationRaceMessage = RootResolverMessage | { type: 'marker_open_pending' };

function createFifo(path: string): void {
  const result = spawnSync('mkfifo', [path], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || `mkfifo exited with status ${result.status}`);
}

function resolveRootInChild(root: string): Promise<RootResolverMessage> {
  const child = fork(new URL('./fixtures/root-resolver.js', import.meta.url), [root], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    let message: RootResolverMessage | undefined;
    const timer = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error('storage root resolution blocked on a non-regular marker'));
    }, 1_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      if (code !== 0 || !message) {
        reject(new Error(`storage root resolver exited before reporting: ${code ?? signal}`));
      } else {
        resolve(message);
      }
    };
    const onMessage = (value: unknown) => {
      if (!isRootResolverMessage(value)) {
        cleanup();
        child.kill('SIGKILL');
        reject(new Error(`unexpected storage root resolver message: ${JSON.stringify(value)}`));
        return;
      }
      message = value;
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

function waitForChildMessage<T extends InitializationRaceMessage>(
  child: ChildProcess,
  matches: (message: InitializationRaceMessage) => message is T,
  expected: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`initialization race fixture did not report ${expected}`));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`initialization race fixture exited before reporting: ${code ?? signal}`));
    };
    const onMessage = (value: unknown) => {
      if (!isInitializationRaceMessage(value)) {
        cleanup();
        reject(new Error(`unexpected initialization race message: ${JSON.stringify(value)}`));
      } else if (matches(value)) {
        cleanup();
        resolve(value);
      } else {
        cleanup();
        reject(
          new Error(
            `initialization race fixture reported ${value.type} while waiting for ${expected}`,
          ),
        );
      }
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

function isRootResolverMessage(value: unknown): value is RootResolverMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'resolved' || (message.type === 'error' && typeof message.code === 'string')
  );
}

function isInitializationRaceMessage(value: unknown): value is InitializationRaceMessage {
  return (
    isRootResolverMessage(value) ||
    (!!value &&
      typeof value === 'object' &&
      (value as { type?: unknown }).type === 'marker_open_pending')
  );
}

async function closeHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.send('close');
  await exited;
}

function waitForDescendant(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('lock holder did not report its descendant')),
      5_000,
    );
    child.once('message', (message) => {
      if (
        !message ||
        typeof message !== 'object' ||
        (message as { type?: unknown }).type !== 'descendant'
      )
        return;
      clearTimeout(timer);
      resolve((message as { pid: number }).pid);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`lock holder exited before reporting its descendant: ${code ?? signal}`));
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    ) {
      return false;
    }
    throw error;
  }
}

function terminateProcess(pid: number | undefined): void {
  if (pid === undefined || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ESRCH'
      )
    ) {
      throw error;
    }
  }
}

async function retryAcquire(
  capability: StorageRootCapability<'interactive'>,
): Promise<Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    if (owner) return owner;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

async function removeControlDirectoriesForRootsUnder(base: string): Promise<void> {
  const rootIds = new Set<string>();
  await collectRootIds(base, rootIds);
  await Promise.all(
    [...rootIds].map((rootId) =>
      rm(join(resolveRootControlNamespace(), rootId), { recursive: true, force: true }),
    ),
  );
}

async function collectRootIds(directory: string, rootIds: Set<string>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    const markerPath = join(path, STORAGE_ROOT_MARKER_FILE);
    const markerStat = await lstat(markerPath).catch(() => undefined);
    const marker = markerStat?.isFile()
      ? await readFile(markerPath, 'utf8').catch(() => undefined)
      : undefined;
    if (marker) {
      try {
        const rootId = (JSON.parse(marker) as { rootId?: unknown }).rootId;
        if (typeof rootId === 'string' && /^[a-f0-9]{64}$/.test(rootId)) rootIds.add(rootId);
      } catch {
        // Invalid marker tests never create a control directory.
      }
    }
    await collectRootIds(path, rootIds);
  }
}
