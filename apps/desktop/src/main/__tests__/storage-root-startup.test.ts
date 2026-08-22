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

test('asks before adopting a root whose device number moved on its own', async () => {
  // A device number changes on its own whenever a volume is mounted again, so
  // repairing that case without asking is tempting: the person is being shown
  // a number they cannot answer for.
  //
  // It cannot be done from the marker. Inode numbers are unique only within
  // one mounted filesystem, so a workspace restored onto another volume can
  // report the same root-directory inode as the original — a different `dev`
  // and a matching `ino` is exactly that case too, and the two are
  // indistinguishable here. Adopting it would hand a second, unrelated
  // directory the original's rootId with nobody asked.
  //
  // So this drift stays a question, and this test is the reason why.
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-root-'));
  let repairAsked = false;
  try {
    await resolveStorageRoot({ path: root, kind: 'interactive' });
    const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      rootIdentity: { dev: string; ino: string };
    };
    const inodeBefore = marker.rootIdentity.ino;
    marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
    const conflictingMarker = `${JSON.stringify(marker)}\n`;
    await writeFile(markerPath, conflictingMarker);

    const resolved = await resolveDesktopStorageRoot(root, {
      confirmRepair: async () => {
        repairAsked = true;
        return false;
      },
    });

    assert.equal(repairAsked, true, 'only the person can tell a remount from a restored copy');
    assert.equal(resolved, undefined);
    // And nothing was written while the answer was outstanding.
    assert.equal(await readFile(markerPath, 'utf8'), conflictingMarker);
    const after = JSON.parse(await readFile(markerPath, 'utf8')) as {
      rootIdentity: { ino: string };
    };
    assert.equal(after.rootIdentity.ino, inodeBefore);
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
