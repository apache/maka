import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  MemoryBundleBackupRevisionConflictError,
  MemoryBundleRevisionConflictError,
  MemoryBundleBackupNotFoundError,
  MemoryBundleStoreError,
  authenticateInteractiveMemoryBundleStoreReader,
  authenticateInteractiveMemoryBundleStoreWriter,
  openInteractiveMemoryBundleStoreForRead,
  openInteractiveMemoryBundleStoreForWrite,
  type MemoryBundleSnapshot,
  type MemoryDocumentSnapshot,
  type MemoryRevision,
} from '../memory-bundle-store.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type InteractiveRootOwner,
  type StorageRootCapability,
} from '../root-authority.js';

const MEMORY_DIRECTORY = 'memory';
const TRANSACTION_DIRECTORY = '.memory-bundle-transaction';

describe('interactive Memory bundle storage authority', () => {
  test('reader and writer recovery are non-mutating when no transaction exists', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const readerOwner = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerOwner);
      if (!readerOwner) return;
      try {
        const reader = await openInteractiveMemoryBundleStoreForRead(readerOwner.lease);
        assert.strictEqual(authenticateInteractiveMemoryBundleStoreReader(reader), reader);
        const snapshot = await reader.read();
        assert.equal(snapshot.memory.kind, 'missing');
        assert.equal(snapshot.pending.kind, 'missing');
        await assert.rejects(lstat(memoryDirectory(root)), { code: 'ENOENT' });
      } finally {
        await readerOwner.close();
      }

      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const writer = await openInteractiveMemoryBundleStoreForWrite(owner.lease);
        assert.strictEqual(authenticateInteractiveMemoryBundleStoreWriter(writer), writer);
        const snapshot = await writer.read();
        assert.equal(snapshot.memory.kind, 'missing');
        assert.equal(snapshot.pending.kind, 'missing');
        await assert.rejects(lstat(memoryDirectory(root)), { code: 'ENOENT' });
        await assert.rejects(lstat(pendingPath(root)), { code: 'ENOENT' });
      } finally {
        await owner.close();
      }
    });
  });

  test('commits MEMORY.md and PENDING.md under one exact bundle CAS', async () => {
    await withInteractiveOwner(async ({ root, owner }) => {
      const store = await openInteractiveMemoryBundleStoreForWrite(owner.lease);
      const initial = await store.read();
      const memory = Buffer.from('# Maka Memory\n\n## Preference\nUse concise answers.\n');
      const pending = Buffer.from('# Maka Pending Memory\n\n## Candidate\nReview this.\n');
      const committed = await store.commit({
        expectedRevision: initial.revision,
        memory,
        pending,
      });

      assert.equal(committed.changed, true);
      assert.deepEqual(await readFile(memoryPath(root)), memory);
      assert.deepEqual(await readFile(pendingPath(root)), pending);
      assert.equal(committed.snapshot.memory.kind, 'document');
      assert.equal(committed.snapshot.pending.kind, 'document');

      const unchanged = await store.commit({
        expectedRevision: committed.snapshot.revision,
        memory,
        pending,
      });
      assert.equal(unchanged.changed, false);

      await assert.rejects(
        store.commit({
          expectedRevision: initial.revision,
          memory: Buffer.from('# Stale overwrite\n'),
          pending,
        }),
        (error: unknown) =>
          error instanceof MemoryBundleRevisionConflictError &&
          error.actual.revision === committed.snapshot.revision,
      );
    });
  });

  test('detects direct external edits before publishing a mutation', async () => {
    await withInteractiveOwner(async ({ root, owner }) => {
      const store = await openInteractiveMemoryBundleStoreForWrite(owner.lease);
      const basis = await store.read();
      const external = Buffer.from('# External edit\n');
      await mkdir(memoryDirectory(root), { mode: 0o700 });
      await writeFile(memoryPath(root), external);

      await assert.rejects(
        store.commit({
          expectedRevision: basis.revision,
          memory: Buffer.from('# Lost update\n'),
          pending: null,
        }),
        (error: unknown) =>
          error instanceof MemoryBundleRevisionConflictError &&
          error.actual.memory.kind === 'document' &&
          error.actual.memory.revision === revision(external),
      );
      assert.deepEqual(await readFile(memoryPath(root)), external);
    });
  });

  test('restores a selected backup, preserves PENDING.md, and rotates restore undo history', async () => {
    await withInteractiveOwner(async ({ root, owner }) => {
      const store = await openInteractiveMemoryBundleStoreForWrite(owner.lease);
      const initial = await store.read();
      const first = Buffer.from('# First memory\n');
      const second = Buffer.from('# Second memory\n');
      const pending = Buffer.from('# Pending remains\n');
      const firstCommit = await store.commit({
        expectedRevision: initial.revision,
        memory: first,
        pending,
      });
      const secondCommit = await store.commit({
        expectedRevision: firstCommit.snapshot.revision,
        memory: second,
        pending,
        backup: 'save',
      });
      const saveBackup = (await store.listBackups()).find((backup) => backup.kind === 'save');
      assert.ok(saveBackup);

      const restoredFirst = await store.restoreBackup({
        expectedRevision: secondCommit.snapshot.revision,
        expectedBackupRevision: saveBackup.revision,
        kind: 'save',
      });
      assert.deepEqual(await readFile(memoryPath(root)), first);
      assert.deepEqual(await readFile(pendingPath(root)), pending);
      assert.deepEqual(
        await readFile(join(memoryDirectory(root), 'MEMORY.md.restore.bak')),
        second,
      );
      const restoreBackup = (await store.listBackups()).find((backup) => backup.kind === 'restore');
      assert.ok(restoreBackup);

      const restoredSecond = await store.restoreBackup({
        expectedRevision: restoredFirst.snapshot.revision,
        expectedBackupRevision: restoreBackup.revision,
        kind: 'restore',
      });
      assert.deepEqual(await readFile(memoryPath(root)), second);
      assert.deepEqual(await readFile(join(memoryDirectory(root), 'MEMORY.md.restore.bak')), first);
      assert.deepEqual(
        await readFile(join(memoryDirectory(root), 'MEMORY.md.restore.1.bak')),
        second,
      );
      assert.equal(restoredSecond.changed, true);

      await assert.rejects(
        store.restoreBackup({
          expectedRevision: restoredSecond.snapshot.revision,
          expectedBackupRevision: revision(Buffer.from('missing reset backup')),
          kind: 'reset',
        }),
        (error: unknown) =>
          error instanceof MemoryBundleBackupNotFoundError && error.kind === 'reset',
      );
    });
  });

  test('can restore a bounded safe-mode backup for manual recovery', async () => {
    await withInteractiveOwner(async ({ root, owner }) => {
      const store = await openInteractiveMemoryBundleStoreForWrite(owner.lease);
      const initial = await store.read();
      const current = await store.commit({
        expectedRevision: initial.revision,
        memory: Buffer.from('# Current memory\n'),
        pending: null,
      });
      const oversized = Buffer.alloc(128 * 1024 + 1, 0x61);
      await writeFile(join(memoryDirectory(root), 'MEMORY.md.bak'), oversized);
      const saveBackup = (await store.listBackups()).find((backup) => backup.kind === 'save');
      assert.ok(saveBackup);

      const restored = await store.restoreBackup({
        expectedRevision: current.snapshot.revision,
        expectedBackupRevision: saveBackup.revision,
        kind: 'save',
      });
      assert.equal(restored.snapshot.memory.kind, 'safe_mode');
      if (restored.snapshot.memory.kind === 'safe_mode') {
        assert.equal(restored.snapshot.memory.reason, 'oversize');
        assert.equal(restored.snapshot.memory.byteLength, oversized.byteLength);
      }
      assert.deepEqual(await readFile(memoryPath(root)), oversized);
    });
  });

  test('rejects a stale backup candidate even when the bundle revision is unchanged', async () => {
    await withInteractiveOwner(async ({ root, owner }) => {
      const store = await openInteractiveMemoryBundleStoreForWrite(owner.lease);
      const initial = await store.read();
      const first = Buffer.from('# First memory\n');
      const firstCommit = await store.commit({
        expectedRevision: initial.revision,
        memory: first,
        pending: null,
      });
      const second = Buffer.from('# Second memory\n');
      const secondCommit = await store.commit({
        expectedRevision: firstCommit.snapshot.revision,
        memory: second,
        pending: null,
        backup: 'save',
      });
      const selected = (await store.listBackups()).find((backup) => backup.kind === 'save');
      assert.ok(selected);
      assert.equal(selected.revision, revision(first));

      const unchanged = await store.commit({
        expectedRevision: secondCommit.snapshot.revision,
        memory: second,
        pending: null,
        backup: 'save',
      });
      assert.equal(unchanged.changed, false);
      assert.equal(unchanged.snapshot.revision, secondCommit.snapshot.revision);
      const replaced = (await store.listBackups()).find((backup) => backup.kind === 'save');
      assert.ok(replaced);
      assert.equal(replaced.revision, revision(second));

      await assert.rejects(
        store.restoreBackup({
          expectedRevision: secondCommit.snapshot.revision,
          expectedBackupRevision: selected.revision,
          kind: 'save',
        }),
        (error: unknown) =>
          error instanceof MemoryBundleBackupRevisionConflictError &&
          error.kind === 'save' &&
          error.expectedRevision === selected.revision &&
          error.actualRevision === replaced.revision,
      );
      assert.deepEqual(await readFile(memoryPath(root)), second);
    });
  });

  test('rolls a durable two-document decision forward after partial materialization', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const targetMemory = Buffer.from('# Target memory\n');
      const oldPending = Buffer.from('# Old pending\n');
      const targetPending = Buffer.from('# Target pending\n');
      await mkdir(memoryDirectory(root), { mode: 0o700 });
      await writeFile(memoryPath(root), targetMemory);
      await writeFile(pendingPath(root), oldPending);

      const readerOwner = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerOwner);
      if (!readerOwner) return;
      let basis: MemoryBundleSnapshot;
      let target: MemoryBundleSnapshot;
      try {
        const reader = await openInteractiveMemoryBundleStoreForRead(readerOwner.lease);
        basis = await reader.read();
        await writeFile(pendingPath(root), targetPending);
        target = await reader.read();
      } finally {
        await readerOwner.close();
      }

      await writeFile(pendingPath(root), oldPending);
      const transaction = join(memoryDirectory(root), TRANSACTION_DIRECTORY);
      await mkdir(transaction, { mode: 0o700 });
      await writeFile(join(transaction, 'MEMORY.md.next'), targetMemory, { mode: 0o600 });
      await writeFile(join(transaction, 'PENDING.md.next'), targetPending, { mode: 0o600 });
      await writeFile(
        join(transaction, 'decision.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          basis: transactionBundleDecision(basis),
          target: transactionBundleDecision(target),
        })}\n`,
        { mode: 0o600 },
      );

      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const store = await openInteractiveMemoryBundleStoreForWrite(owner.lease);
        const recovered = await store.read();
        assert.equal(recovered.revision, target.revision);
        assert.deepEqual(await readFile(memoryPath(root)), targetMemory);
        assert.deepEqual(await readFile(pendingPath(root)), targetPending);
        await assert.rejects(lstat(transaction), { code: 'ENOENT' });
      } finally {
        await owner.close();
      }
    });
  });

  test('preserves external edits made after a durable decision', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const basisMemory = Buffer.from('# Basis memory\n');
      const basisPending = Buffer.from('# Basis pending\n');
      const targetMemory = Buffer.from('# Target memory\n');
      const targetPending = Buffer.from('# Target pending\n');
      const externalPending = Buffer.from('# External edit after commit\n');
      await mkdir(memoryDirectory(root), { mode: 0o700 });
      await writeFile(memoryPath(root), basisMemory);
      await writeFile(pendingPath(root), basisPending);

      const readerOwner = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerOwner);
      if (!readerOwner) return;
      let basis: MemoryBundleSnapshot;
      let target: MemoryBundleSnapshot;
      try {
        const reader = await openInteractiveMemoryBundleStoreForRead(readerOwner.lease);
        basis = await reader.read();
        await writeFile(memoryPath(root), targetMemory);
        await writeFile(pendingPath(root), targetPending);
        target = await reader.read();
      } finally {
        await readerOwner.close();
      }

      await writeFile(pendingPath(root), externalPending);
      const transaction = join(memoryDirectory(root), TRANSACTION_DIRECTORY);
      await mkdir(transaction, { mode: 0o700 });
      await writeFile(join(transaction, 'MEMORY.md.next'), targetMemory, { mode: 0o600 });
      await writeFile(join(transaction, 'PENDING.md.next'), targetPending, { mode: 0o600 });
      await writeFile(
        join(transaction, 'decision.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          basis: transactionBundleDecision(basis),
          target: transactionBundleDecision(target),
        })}\n`,
        { mode: 0o600 },
      );

      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        await assert.rejects(
          openInteractiveMemoryBundleStoreForWrite(owner.lease),
          (error: unknown) =>
            error instanceof MemoryBundleStoreError && error.code === 'recovery_conflict',
        );
        assert.deepEqual(await readFile(memoryPath(root)), targetMemory);
        assert.deepEqual(await readFile(pendingPath(root)), externalPending);
        assert.equal((await lstat(transaction)).isDirectory(), true);
      } finally {
        await owner.close();
      }
    });
  });

  test('does not replace an external save published after basis displacement', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const basisMemory = Buffer.from('# Basis memory\n');
      const targetMemory = Buffer.from('# Target memory\n');
      const externalMemory = Buffer.from('# External replacement\n');
      await mkdir(memoryDirectory(root), { mode: 0o700 });
      await writeFile(memoryPath(root), basisMemory);

      const readerOwner = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerOwner);
      if (!readerOwner) return;
      let basis: MemoryBundleSnapshot;
      let target: MemoryBundleSnapshot;
      try {
        const reader = await openInteractiveMemoryBundleStoreForRead(readerOwner.lease);
        basis = await reader.read();
        await writeFile(memoryPath(root), targetMemory);
        target = await reader.read();
      } finally {
        await readerOwner.close();
      }

      const transaction = join(memoryDirectory(root), TRANSACTION_DIRECTORY);
      await mkdir(transaction, { mode: 0o700 });
      await writeFile(join(transaction, 'MEMORY.md.next'), targetMemory, { mode: 0o600 });
      await writeFile(join(transaction, 'MEMORY.md.displaced'), basisMemory, { mode: 0o600 });
      await writeFile(
        join(transaction, 'decision.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          basis: transactionBundleDecision(basis),
          target: transactionBundleDecision(target),
        })}\n`,
        { mode: 0o600 },
      );
      await writeFile(memoryPath(root), externalMemory);

      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        await assert.rejects(
          openInteractiveMemoryBundleStoreForWrite(owner.lease),
          (error: unknown) =>
            error instanceof MemoryBundleStoreError && error.code === 'recovery_conflict',
        );
        assert.deepEqual(await readFile(memoryPath(root)), externalMemory);
        assert.deepEqual(await readFile(join(transaction, 'MEMORY.md.displaced')), basisMemory);
        assert.deepEqual(await readFile(join(transaction, 'MEMORY.md.next')), targetMemory);
        assert.equal((await lstat(transaction)).isDirectory(), true);
      } finally {
        await owner.close();
      }
    });
  });

  test('restores an external save captured while displacing the basis', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const basisMemory = Buffer.from('# Basis memory\n');
      const targetMemory = Buffer.from('# Target memory\n');
      const externalMemory = Buffer.from('# External in-place save\n');
      await mkdir(memoryDirectory(root), { mode: 0o700 });
      await writeFile(memoryPath(root), basisMemory);

      const readerOwner = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerOwner);
      if (!readerOwner) return;
      let basis: MemoryBundleSnapshot;
      let target: MemoryBundleSnapshot;
      try {
        const reader = await openInteractiveMemoryBundleStoreForRead(readerOwner.lease);
        basis = await reader.read();
        await writeFile(memoryPath(root), targetMemory);
        target = await reader.read();
      } finally {
        await readerOwner.close();
      }

      const transaction = join(memoryDirectory(root), TRANSACTION_DIRECTORY);
      await mkdir(transaction, { mode: 0o700 });
      await writeFile(join(transaction, 'MEMORY.md.next'), targetMemory, { mode: 0o600 });
      await writeFile(join(transaction, 'MEMORY.md.displaced'), externalMemory, { mode: 0o600 });
      await writeFile(
        join(transaction, 'decision.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          basis: transactionBundleDecision(basis),
          target: transactionBundleDecision(target),
        })}\n`,
        { mode: 0o600 },
      );
      await rm(memoryPath(root));

      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        await assert.rejects(
          openInteractiveMemoryBundleStoreForWrite(owner.lease),
          (error: unknown) =>
            error instanceof MemoryBundleStoreError && error.code === 'recovery_conflict',
        );
        assert.deepEqual(await readFile(memoryPath(root)), externalMemory);
        assert.deepEqual(await readFile(join(transaction, 'MEMORY.md.displaced')), externalMemory);
        assert.deepEqual(await readFile(join(transaction, 'MEMORY.md.next')), targetMemory);
        assert.equal((await lstat(transaction)).isDirectory(), true);
      } finally {
        await owner.close();
      }
    });
  });

  test('keeps staged targets immutable after partial materialization', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const basisMemory = Buffer.from('# Basis memory\n');
      const basisPending = Buffer.from('# Basis pending\n');
      const targetMemory = Buffer.from('# Target memory\n');
      const targetPending = Buffer.from('# Target pending\n');
      const externalMemory = Buffer.from('# External in-place edit\n');
      const externalPending = Buffer.from('# External pending edit\n');
      await mkdir(memoryDirectory(root), { mode: 0o700 });
      await writeFile(memoryPath(root), basisMemory);
      await writeFile(pendingPath(root), basisPending);

      const readerOwner = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerOwner);
      if (!readerOwner) return;
      let basis: MemoryBundleSnapshot;
      let target: MemoryBundleSnapshot;
      try {
        const reader = await openInteractiveMemoryBundleStoreForRead(readerOwner.lease);
        basis = await reader.read();
        await writeFile(memoryPath(root), targetMemory);
        await writeFile(pendingPath(root), targetPending);
        target = await reader.read();
      } finally {
        await readerOwner.close();
      }

      await writeFile(memoryPath(root), basisMemory);
      await writeFile(pendingPath(root), externalPending);
      const transaction = join(memoryDirectory(root), TRANSACTION_DIRECTORY);
      await mkdir(transaction, { mode: 0o700 });
      await writeFile(join(transaction, 'MEMORY.md.next'), targetMemory, { mode: 0o600 });
      await writeFile(join(transaction, 'PENDING.md.next'), targetPending, { mode: 0o600 });
      await writeFile(
        join(transaction, 'decision.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          basis: transactionBundleDecision(basis),
          target: transactionBundleDecision(target),
        })}\n`,
        { mode: 0o600 },
      );

      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        await assert.rejects(
          openInteractiveMemoryBundleStoreForWrite(owner.lease),
          (error: unknown) =>
            error instanceof MemoryBundleStoreError && error.code === 'recovery_conflict',
        );
        assert.deepEqual(await readFile(memoryPath(root)), targetMemory);
        assert.deepEqual(await readFile(pendingPath(root)), externalPending);

        await writeFile(memoryPath(root), externalMemory);
        assert.deepEqual(await readFile(memoryPath(root)), externalMemory);
        assert.deepEqual(await readFile(join(transaction, 'MEMORY.md.next')), targetMemory);
        assert.equal(
          (await readdir(transaction)).some((entry) => entry.endsWith('.publish')),
          false,
        );
      } finally {
        await owner.close();
      }
    });
  });

  test('rejects a durable decision whose document state disagrees with staged bytes', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const current = Buffer.from('# Current memory\n');
      const currentRevision = revision(current);
      await mkdir(memoryDirectory(root), { mode: 0o700 });
      await writeFile(memoryPath(root), current);

      const readerOwner = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerOwner);
      if (!readerOwner) return;
      let basis: MemoryBundleSnapshot;
      try {
        basis = await (await openInteractiveMemoryBundleStoreForRead(readerOwner.lease)).read();
      } finally {
        await readerOwner.close();
      }

      const transaction = join(memoryDirectory(root), TRANSACTION_DIRECTORY);
      await mkdir(transaction, { mode: 0o700 });
      await writeFile(join(transaction, 'MEMORY.md.next'), current, { mode: 0o600 });
      await writeFile(
        join(transaction, 'decision.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          basis: transactionBundleDecision(basis),
          target: {
            revision: decisionBundleRevision('safe_mode', current.byteLength, currentRevision),
            memory: {
              kind: 'safe_mode',
              byteLength: current.byteLength,
              revision: currentRevision,
              reason: 'invalid_utf8',
            },
            pending: {
              kind: 'missing',
              byteLength: 0,
              revision: null,
              reason: null,
            },
          },
        })}\n`,
        { mode: 0o600 },
      );

      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        await assert.rejects(
          openInteractiveMemoryBundleStoreForWrite(owner.lease),
          (error: unknown) =>
            error instanceof MemoryBundleStoreError && error.code === 'invalid_document',
        );
        assert.deepEqual(await readFile(memoryPath(root)), current);
        assert.equal((await lstat(transaction)).isDirectory(), true);
      } finally {
        await owner.close();
      }
    });
  });

  test('discards an undecided transaction without touching user documents', async () => {
    await withInteractiveOwner(async ({ root, owner }) => {
      await mkdir(memoryDirectory(root), { mode: 0o700 });
      const current = Buffer.from('# Current\n');
      await writeFile(memoryPath(root), current);
      const transaction = join(memoryDirectory(root), TRANSACTION_DIRECTORY);
      await mkdir(transaction, { mode: 0o700 });
      await writeFile(join(transaction, 'MEMORY.md.next'), '# Uncommitted\n');

      const store = await openInteractiveMemoryBundleStoreForWrite(owner.lease);
      assert.deepEqual(await readFile(memoryPath(root)), current);
      await assert.rejects(lstat(transaction), { code: 'ENOENT' });
      assert.equal((await store.read()).memory.kind, 'document');
    });
  });

  test('read-only inspection fails closed until a writer recovers a transaction', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      await mkdir(memoryDirectory(root), { mode: 0o700 });
      const current = Buffer.from('# Current\n');
      await writeFile(memoryPath(root), current);
      const transaction = join(memoryDirectory(root), TRANSACTION_DIRECTORY);
      await mkdir(transaction, { mode: 0o700 });
      await writeFile(join(transaction, 'MEMORY.md.next'), '# Uncommitted\n');

      const readerOwner = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerOwner);
      if (!readerOwner) return;
      try {
        const reader = await openInteractiveMemoryBundleStoreForRead(readerOwner.lease);
        await assert.rejects(
          reader.read(),
          (error: unknown) => error instanceof MemoryBundleStoreError && error.code === 'io_failed',
        );
      } finally {
        await readerOwner.close();
      }

      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const store = await openInteractiveMemoryBundleStoreForWrite(owner.lease);
        assert.equal((await store.read()).memory.kind, 'document');
        assert.deepEqual(await readFile(memoryPath(root)), current);
        await assert.rejects(lstat(transaction), { code: 'ENOENT' });
      } finally {
        await owner.close();
      }
    });
  });

  test('rejects a symbolic-link Memory parent without reading or writing outside the root', async () => {
    await withInteractiveOwner(async ({ root, owner }) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-memory-outside-'));
      try {
        const outsideMemory = join(outside, 'MEMORY.md');
        await writeFile(outsideMemory, '# Outside\n');
        await symlink(
          outside,
          memoryDirectory(root),
          process.platform === 'win32' ? 'junction' : 'dir',
        );

        await assert.rejects(
          openInteractiveMemoryBundleStoreForWrite(owner.lease),
          (error: unknown) =>
            error instanceof MemoryBundleStoreError && error.code === 'invalid_document',
        );
        assert.equal(await readFile(outsideMemory, 'utf8'), '# Outside\n');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test('root owner close drains mutations admitted before close', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const store = await openInteractiveMemoryBundleStoreForWrite(owner.lease);
      const initial = await store.read();
      const commit = store.commit({
        expectedRevision: initial.revision,
        memory: Buffer.alloc(128 * 1024, 0x61),
        pending: null,
      });
      const close = owner.close();

      const committed = await commit;
      assert.equal(committed.changed, true);
      await close;
      await assert.rejects(store.read(), { code: 'invalid_lease' });
    });
  });
});

async function withInteractiveOwner(
  run: (input: { root: string; owner: InteractiveRootOwner }) => Promise<void>,
): Promise<void> {
  await withInteractiveRoot(async ({ root, capability }) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    try {
      await run({ root, owner });
    } finally {
      if (!owner.closed) await owner.close();
    }
  });
}

async function withInteractiveRoot(
  run: (input: { root: string; capability: StorageRootCapability<'interactive'> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-memory-bundle-store-'));
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    await run({ root, capability });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function memoryDirectory(root: string): string {
  return join(root, MEMORY_DIRECTORY);
}

function memoryPath(root: string): string {
  return join(memoryDirectory(root), 'MEMORY.md');
}

function pendingPath(root: string): string {
  return join(memoryDirectory(root), 'PENDING.md');
}

function revision(bytes: Uint8Array): MemoryRevision {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decisionBundleRevision(
  memoryKind: 'document' | 'safe_mode',
  memoryByteLength: number,
  memoryRevision: MemoryRevision,
): MemoryRevision {
  const hash = createHash('sha256');
  hash.update('maka-memory-bundle-v1\0');
  hash.update(`memory\0${memoryKind}\0${memoryByteLength}\0`);
  hash.update(memoryRevision);
  hash.update('\0');
  hash.update('pending\0missing\0');
  hash.update('0');
  hash.update('\0missing\0');
  return `sha256:${hash.digest('hex')}`;
}

function transactionBundleDecision(snapshot: MemoryBundleSnapshot) {
  return {
    revision: snapshot.revision,
    memory: transactionDocumentDecision(snapshot.memory),
    pending: transactionDocumentDecision(snapshot.pending),
  };
}

function transactionDocumentDecision(snapshot: MemoryDocumentSnapshot) {
  return {
    kind: snapshot.kind,
    byteLength: snapshot.byteLength,
    revision: snapshot.revision,
    reason: snapshot.kind === 'safe_mode' ? snapshot.reason : null,
  };
}
