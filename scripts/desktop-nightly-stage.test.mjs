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
import { parse, stringify } from 'yaml';
import { writeDesktopReleaseInput } from './desktop-nightly-fixture.mjs';
import { addDesktopNightlyAttestation, stageDesktopNightly } from './desktop-nightly.mjs';
import { verifyDesktopUpdateArtifacts } from './desktop-update-contract.mjs';

test('staging creates only the exact GitHub Release assets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-nightly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input');
  const output = join(root, 'output');
  const version = '0.2.0-dev.42.20260829';
  await mkdir(input);
  await writeDesktopReleaseInput(input, version, { nightly: true });

  await stageDesktopNightly({
    inputDirectory: input,
    outputDirectory: output,
    version,
  });

  const payloadNames = [
    `Maka-${version}-mac-arm64.dmg`,
    `Maka-${version}-mac-arm64.zip`,
    `Maka-${version}-mac-arm64.zip.blockmap`,
    `Maka-${version}-mac-x64.dmg`,
    `Maka-${version}-mac-x64.zip`,
    `Maka-${version}-mac-x64.zip.blockmap`,
    `Maka-${version}-win-x64.exe`,
    `Maka-${version}-win-x64.exe.blockmap`,
    `Maka-${version}-win-x64.zip`,
    // Linux artifact names use the packaging ecosystem's architecture, and
    // neither distributable has a sidecar blockmap.
    `Maka-${version}-linux-x86_64.AppImage`,
    `Maka-${version}-linux-amd64.deb`,
    `Maka-${version}-linux-arm64.AppImage`,
    `Maka-${version}-linux-arm64.deb`,
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
      artifactNames: [`Maka-${version}-mac-arm64.zip`, `Maka-${version}-mac-x64.zip`],
    }),
    verifyDesktopUpdateArtifacts({
      directory: release,
      metadataName: 'dev.yml',
      version,
      artifactNames: [`Maka-${version}-win-x64.exe`],
    }),
    verifyDesktopUpdateArtifacts({
      directory: release,
      metadataName: 'dev-linux.yml',
      version,
      artifactNames: [`Maka-${version}-linux-x86_64.AppImage`, `Maka-${version}-linux-amd64.deb`],
    }),
    verifyDesktopUpdateArtifacts({
      directory: release,
      metadataName: 'dev-linux-arm64.yml',
      version,
      artifactNames: [`Maka-${version}-linux-arm64.AppImage`, `Maka-${version}-linux-arm64.deb`],
    }),
  ]);

  // Both macOS architectures reach one feed, and the per-runner feeds do not
  // reach the release at all.
  const macFeed = parse(await readFile(join(release, 'dev-mac.yml'), 'utf8'));
  assert.deepEqual(
    macFeed.files.map((file) => file.url).sort(),
    [`Maka-${version}-mac-arm64.zip`, `Maka-${version}-mac-x64.zip`].sort(),
  );

  assert.deepEqual(
    (await readdir(release)).sort(),
    [...payloadNames, 'dev-mac.yml', 'dev.yml', 'dev-linux.yml', 'dev-linux-arm64.yml'].sort(),
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
