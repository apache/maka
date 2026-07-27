import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

test('repairs a stale desktop storage root after explicit confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-root-'));
  try {
    const initialized = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      rootIdentity: { dev: string };
    };
    marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`);

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
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      rootIdentity: { dev: string };
    };
    marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
    const conflictingMarker = `${JSON.stringify(marker)}\n`;
    await writeFile(markerPath, conflictingMarker);

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
    await makeMarkerDeviceStale(rootMarkerPath);
    const replacementMarker = await makeMarkerDeviceStale(replacementMarkerPath);

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

async function makeMarkerDeviceStale(markerPath: string): Promise<string> {
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
    rootIdentity: { dev: string };
  };
  marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
  const staleMarker = `${JSON.stringify(marker)}\n`;
  await writeFile(markerPath, staleMarker);
  return staleMarker;
}
