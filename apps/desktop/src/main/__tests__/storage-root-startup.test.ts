import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  resolveStorageRoot,
  STORAGE_ROOT_MARKER_FILE,
  StorageRootAuthorityError,
} from '@maka/storage/root-authority';
import { resolveDesktopStorageRoot } from '../storage-root-startup.js';

test('opens a valid desktop storage root without asking for repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-root-'));
  let repairAsked = false;
  try {
    const resolved = await resolveDesktopStorageRoot(root, {
      confirmRepair: async () => {
        repairAsked = true;
        return false;
      },
    });

    assert.ok(resolved);
    assert.equal(repairAsked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('opens a root whose volume was mounted again, without asking anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-root-'));
  try {
    const initialized = await resolveStorageRoot({ path: root, kind: 'interactive' });
    await makeMarkerDeviceStale(join(root, STORAGE_ROOT_MARKER_FILE));

    // Nothing here is for a person to decide: the directory has not moved and
    // keeps its inode, and only the per-mount device number differs. Asking
    // costs a dialog raised before any window exists, which never appears.
    const resolved = await resolveDesktopStorageRoot(root, {
      confirmRepair: async () => {
        throw new Error('a remount must not be escalated to the person');
      },
    });

    assert.equal(resolved?.rootId, initialized.rootId);
    const marker = JSON.parse(
      await readFile(join(root, STORAGE_ROOT_MARKER_FILE), 'utf8'),
    ) as { rootIdentity: { dev: string } };
    assert.equal(marker.rootIdentity.dev, (await stat(root, { bigint: true })).dev.toString());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repairs a stale desktop storage root after explicit confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-root-'));
  try {
    const initialized = await resolveStorageRoot({ path: root, kind: 'interactive' });
    await makeMarkerInodeForeign(join(root, STORAGE_ROOT_MARKER_FILE));

    const resolved = await resolveDesktopStorageRoot(root, {
      confirmRepair: async () => true,
    });

    assert.equal(resolved?.rootId, initialized.rootId);
    assert.equal(
      (await resolveStorageRoot({ path: root, kind: 'interactive' })).rootId,
      initialized.rootId,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('leaves a conflicting desktop storage root untouched when repair is declined', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-root-'));
  try {
    await resolveStorageRoot({ path: root, kind: 'interactive' });
    const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
    const conflictingMarker = await makeMarkerInodeForeign(markerPath);

    const resolved = await resolveDesktopStorageRoot(root, {
      confirmRepair: async () => false,
    });

    assert.equal(resolved, undefined);
    assert.equal(await readFile(markerPath, 'utf8'), conflictingMarker);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects repair when the storage root is replaced during confirmation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-desktop-root-'));
  const root = join(base, 'root');
  const replacement = join(base, 'replacement');
  await Promise.all([mkdir(root), mkdir(replacement)]);
  try {
    await Promise.all([
      resolveStorageRoot({ path: root, kind: 'interactive' }),
      resolveStorageRoot({ path: replacement, kind: 'interactive' }),
    ]);
    const rootMarkerPath = join(root, STORAGE_ROOT_MARKER_FILE);
    const replacementMarkerPath = join(replacement, STORAGE_ROOT_MARKER_FILE);
    await makeMarkerInodeForeign(rootMarkerPath);
    const replacementMarker = await makeMarkerInodeForeign(replacementMarkerPath);

    await assert.rejects(
      () =>
        resolveDesktopStorageRoot(root, {
          confirmRepair: async () => {
            await rename(root, join(base, 'original'));
            await rename(replacement, root);
            return true;
          },
        }),
      (error: unknown) =>
        error instanceof StorageRootAuthorityError && error.code === 'root_identity_changed',
    );
    assert.equal(await readFile(join(root, STORAGE_ROOT_MARKER_FILE), 'utf8'), replacementMarker);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/** The marker a remount leaves behind: same inode, a device number from before. */
async function makeMarkerDeviceStale(markerPath: string): Promise<string> {
  return editMarkerIdentity(markerPath, (identity) => ({
    ...identity,
    dev: (BigInt(identity.dev) + 1n).toString(),
  }));
}

/**
 * The marker a copied workspace carries: an inode that belongs to some other
 * directory. This is the case the identity check exists to catch, and the only
 * one worth stopping a person for.
 */
async function makeMarkerInodeForeign(markerPath: string): Promise<string> {
  return editMarkerIdentity(markerPath, (identity) => ({
    ...identity,
    ino: (BigInt(identity.ino) + 1n).toString(),
  }));
}

async function editMarkerIdentity(
  markerPath: string,
  edit: (identity: { dev: string; ino: string }) => { dev: string; ino: string },
): Promise<string> {
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
    rootIdentity: { dev: string; ino: string };
  };
  const edited = `${JSON.stringify({ ...marker, rootIdentity: edit(marker.rootIdentity) })}\n`;
  await writeFile(markerPath, edited);
  return edited;
}
