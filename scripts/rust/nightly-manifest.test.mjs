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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  derivePublicKey,
  generateKeypair,
  generateNightlyMetadata,
  verifyManifest,
} from './nightly-manifest.mjs';

test('nightly-manifest generates SHA256SUMS, signed latest.json, and release notes with Previous Nightly section', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-nightly-manifest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'Maka-nightly-macos-arm64.dmg'), 'fake-dmg');
  await writeFile(join(dir, 'Maka-nightly-macos-arm64.tar.gz'), 'fake-mac-tar');
  await writeFile(join(dir, 'Maka-nightly-linux-x64.tar.gz'), 'fake-linux-x64');
  await writeFile(join(dir, 'Maka-nightly-linux-arm64.tar.gz'), 'fake-linux-arm64');
  await writeFile(join(dir, 'Maka-nightly-windows-x64-setup.exe'), 'fake-setup');
  await writeFile(join(dir, 'Maka-nightly-windows-x64.zip'), 'fake-win-zip');
  await writeFile(join(dir, 'Maka-nightly-ios-arm64.ipa'), 'fake-ipa');
  await writeFile(join(dir, 'install.sh'), '#!/bin/sh\n');

  const keys = generateKeypair();
  assert.equal(derivePublicKey(keys.secretKey), keys.publicKey);

  const otherKeys = generateKeypair();
  await assert.rejects(
    generateNightlyMetadata({
      directory: dir,
      version: '0.2.0-nightly.20261121.42',
      commit: '1234567890abcdef1234567890abcdef12345678',
      secretKey: '',
      expectedPublicKey: keys.publicKey,
      requireSignature: true,
    }),
    /MAKA_UPDATE_SIGNING_KEY is required/,
  );
  await assert.rejects(
    generateNightlyMetadata({
      directory: dir,
      version: '0.2.0-nightly.20261121.42',
      commit: '1234567890abcdef1234567890abcdef12345678',
      secretKey: keys.secretKey,
      expectedPublicKey: otherKeys.publicKey,
      requireSignature: true,
    }),
    /does not match/,
  );

  // Without npmPublished, release notes omit npm commands.
  await generateNightlyMetadata({
    directory: dir,
    version: '0.2.0-nightly.20261121.42',
    commit: '1234567890abcdef1234567890abcdef12345678',
    buildDate: '2026-11-21T07:00:00Z',
    repo: 'apache/maka',
    secretKey: keys.secretKey,
    expectedPublicKey: keys.publicKey,
    requireSignature: true,
    npmPublished: false,
  });
  assert.doesNotMatch(await readFile(join(dir, 'RELEASE_NOTES.md'), 'utf8'), /npm install/);

  const result = await generateNightlyMetadata({
    directory: dir,
    version: '0.2.0-nightly.20261121.42',
    commit: '1234567890abcdef1234567890abcdef12345678',
    buildDate: '2026-11-21T07:00:00Z',
    repo: 'apache/maka',
    secretKey: keys.secretKey,
    expectedPublicKey: keys.publicKey,
    requireSignature: true,
    npmPublished: true,
    previous: {
      version: '0.2.0-nightly.20261120.41',
      commit: 'abcdef1234567890abcdef1234567890abcdef12',
      buildDate: '2026-11-20T07:00:00Z',
      assets: [
        'Maka-nightly-macos-arm64.dmg',
        'Maka-nightly-windows-x64-setup.exe',
        'Maka-nightly-ios-arm64.ipa',
        'SHA256SUMS.txt',
      ],
    },
  });

  assert.equal(result.signed, true);
  const manifestBytes = await readFile(join(dir, 'latest.json'));
  const sig = await readFile(join(dir, 'latest.json.sig'), 'utf8');
  assert.equal(verifyManifest(keys.publicKey, manifestBytes, sig), true);

  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.id, 'org.apache.maka.desktop');
  assert.equal(manifest.version, '0.2.0-nightly.20261121.42');
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [
    'linux-aarch64',
    'linux-x86_64',
    'macos-aarch64',
    'windows-x86_64',
  ]);

  const checksums = await readFile(join(dir, 'SHA256SUMS.txt'), 'utf8');
  assert.match(checksums, /Maka-nightly-macos-arm64\.dmg/);
  assert.match(checksums, /Maka-nightly-linux-arm64\.tar\.gz/);
  assert.match(checksums, /Maka-nightly-ios-arm64\.ipa/);
  assert.ok(result.assets.includes('Maka-nightly-ios-arm64.ipa'));

  const notes = await readFile(join(dir, 'RELEASE_NOTES.md'), 'utf8');
  assert.match(notes, /NOT AN APACHE SOFTWARE FOUNDATION RELEASE/);
  assert.doesNotMatch(notes, /\p{Script=Han}/u);
  assert.match(notes, /## Previous Nightly/);
  assert.match(notes, /releases\/download\/nightly\/Maka-nightly-ios-arm64\.ipa/);
  assert.match(notes, /nightly-previous\/Maka-nightly-macos-arm64\.dmg/);
  assert.match(notes, /nightly-previous\/Maka-nightly-ios-arm64\.ipa/);
  assert.match(notes, /@maka-agent\/cli@0\.2\.0-nightly\.20261121\.42/);
  assert.match(notes, /maka-agent@0\.2\.0-nightly\.20261121\.42/);
});
