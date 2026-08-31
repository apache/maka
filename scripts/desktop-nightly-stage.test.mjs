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
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { addDesktopNightlyAttestation, stageDesktopNightly } from './desktop-nightly.mjs';
import { verifyDesktopUpdateArtifacts } from './desktop-update-contract.mjs';

async function writeUpdateSet(directory, version, platform) {
  const isMac = platform === 'mac';
  const artifact = isMac ? `Maka-${version}-mac-arm64.zip` : `Maka-${version}-win-x64.exe`;
  const metadata = isMac ? 'dev-mac.yml' : 'dev.yml';
  const bytes = Buffer.from(`${platform} nightly bytes`);
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  await writeFile(join(directory, artifact), bytes);
  await writeFile(join(directory, `${artifact}.blockmap`), `${platform} blockmap`);
  await writeFile(
    join(directory, metadata),
    stringify({
      version,
      files: [{ url: artifact, sha512, size: bytes.byteLength }],
      path: artifact,
      sha512,
      releaseDate: '2026-08-29T18:17:00.000Z',
    }),
  );
}

test('staging creates only the exact GitHub Release assets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-nightly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input');
  const output = join(root, 'output');
  const version = '0.2.0-dev.42.20260829';
  await mkdir(input);
  await Promise.all([
    writeUpdateSet(input, version, 'mac'),
    writeUpdateSet(input, version, 'win'),
    writeFile(join(input, `Maka-${version}-mac-arm64.dmg`), 'dmg'),
    writeFile(join(input, `Maka-${version}-win-x64.zip`), 'windows zip'),
  ]);

  await stageDesktopNightly({
    inputDirectory: input,
    outputDirectory: output,
    version,
  });

  const payloadNames = [
    `Maka-${version}-mac-arm64.dmg`,
    `Maka-${version}-mac-arm64.zip`,
    `Maka-${version}-mac-arm64.zip.blockmap`,
    `Maka-${version}-win-x64.exe`,
    `Maka-${version}-win-x64.exe.blockmap`,
    `Maka-${version}-win-x64.zip`,
  ];
  const release = join(output, 'release');
  for (const name of payloadNames) {
    assert.deepEqual(await readFile(join(release, name)), await readFile(join(input, name)), name);
  }
  await Promise.all([
    verifyDesktopUpdateArtifacts({
      directory: release,
      metadataName: 'dev-mac.yml',
      version,
      artifactName: `Maka-${version}-mac-arm64.zip`,
    }),
    verifyDesktopUpdateArtifacts({
      directory: release,
      metadataName: 'dev.yml',
      version,
      artifactName: `Maka-${version}-win-x64.exe`,
    }),
  ]);

  assert.deepEqual(
    (await readdir(release)).sort(),
    [...payloadNames, 'dev-mac.yml', 'dev.yml'].sort(),
  );
  assert.deepEqual(await readdir(output), ['release']);
});

test('one attestation bundle is staged only as a GitHub Release asset', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-nightly-attestation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'output');
  const release = join(output, 'release');
  const version = '0.2.0-dev.42.20260829';
  const bundle = join(root, 'bundle.json');
  const bytes = Buffer.from('one offline Sigstore bundle');
  await Promise.all([mkdir(release, { recursive: true }), writeFile(bundle, bytes)]);

  await addDesktopNightlyAttestation({ outputDirectory: output, version, bundlePath: bundle });

  const name = `Maka-${version}-attestation.sigstore.json`;
  assert.deepEqual(await readFile(join(release, name)), bytes);
  assert.deepEqual(await readdir(output), ['release']);
});
