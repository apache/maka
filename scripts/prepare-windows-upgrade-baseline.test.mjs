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

/**
 * The packaged Windows lane restores this directory from a cache keyed on the
 * pinned manifest, because downloading the baseline is that lane's most
 * frequent failure and the asset it names never changes. A restored copy is
 * only worth anything if the preparation step actually reuses it, which is the
 * contract below: reuse what verifies, download what does not, and never let a
 * cache decide what the run installs.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareWindowsUpgradeBaseline } from './prepare-windows-upgrade-baseline.mjs';

const MANIFEST = {
  version: '0.1.0',
  tag: 'v0.1.0',
  assetName: 'Maka-0.1.0-win-x64.exe',
  sha256: 'a'.repeat(64),
};

function scenario({ cached, digest = async () => MANIFEST.sha256 }) {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-baseline-'));
  const manifestPath = join(root, 'baseline.json');
  writeFileSync(manifestPath, JSON.stringify(MANIFEST));
  const directory = join(root, 'artifacts');
  const installer = join(directory, MANIFEST.assetName);
  if (cached !== undefined) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(installer, cached);
  }
  const downloads = [];
  return {
    root,
    directory,
    installer,
    downloads,
    prepare: () =>
      prepareWindowsUpgradeBaseline('0.2.0', directory, {
        manifestPath,
        checksum: digest,
        run: (...args) => {
          downloads.push(args);
          mkdirSync(directory, { recursive: true });
          writeFileSync(installer, 'downloaded');
          return Promise.resolve();
        },
      }),
  };
}

test('a cached installer matching the pinned digest is used without downloading', async () => {
  const { installer, downloads, prepare, root } = scenario({ cached: 'cached' });
  try {
    assert.equal(await prepare(), installer);
    assert.deepEqual(downloads, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an absent installer is downloaded and verified', async () => {
  const { installer, downloads, prepare, root } = scenario({ cached: undefined });
  try {
    assert.equal(await prepare(), installer);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0][0], 'gh');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cached installer with the wrong digest is replaced rather than trusted', async () => {
  // The cache is not an authority on what this lane installs. First call is the
  // stale entry, second is the fresh download, which must be the one verified.
  const digests = [`${'b'.repeat(63)}0`, MANIFEST.sha256];
  const { downloads, prepare, root } = scenario({
    cached: 'stale',
    digest: async () => digests.shift(),
  });
  try {
    await prepare();
    assert.equal(downloads.length, 1);
    assert.deepEqual(digests, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable cache entry falls back to the network instead of failing', async () => {
  const digests = [null, MANIFEST.sha256];
  const { downloads, prepare, root } = scenario({
    cached: '',
    digest: async () => {
      const next = digests.shift();
      if (next === null) throw new Error('unreadable');
      return next;
    },
  });
  try {
    await prepare();
    assert.equal(downloads.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh download that does not match the pinned digest fails the run', async () => {
  const { prepare, root } = scenario({ cached: undefined, digest: async () => 'c'.repeat(64) });
  try {
    await assert.rejects(prepare(), /checksum mismatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
