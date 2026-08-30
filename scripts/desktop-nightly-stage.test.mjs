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
import { assertDesktopNightlyFeedAdvance, stageDesktopNightly } from './desktop-nightly.mjs';
import { verifyDesktopUpdateArtifacts } from './desktop-update-contract.mjs';

async function writeUpdateSet(directory, version, platform) {
  const isMac = platform === 'mac';
  const artifact = isMac ? `Maka-${version}-mac-arm64.zip` : `Maka-${version}-win-x64.exe`;
  const metadata = isMac ? 'latest-mac.yml' : 'latest.yml';
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

test('staging separates append-only payloads from the mutable Nightly feed', async (t) => {
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
    sourceCommit: 'a'.repeat(40),
  });

  const payloadNames = [
    `Maka-${version}-mac-arm64.dmg`,
    `Maka-${version}-mac-arm64.zip`,
    `Maka-${version}-mac-arm64.zip.blockmap`,
    `Maka-${version}-win-x64.exe`,
    `Maka-${version}-win-x64.exe.blockmap`,
    `Maka-${version}-win-x64.zip`,
  ];
  for (const name of payloadNames) {
    assert.deepEqual(
      await readFile(join(output, 'versions', version, name)),
      await readFile(join(input, name)),
      name,
    );
  }
  await Promise.all([
    verifyDesktopUpdateArtifacts({
      directory: output,
      metadataName: 'feed/latest-mac.yml',
      version,
      artifactName: `versions/${version}/Maka-${version}-mac-arm64.zip`,
    }),
    verifyDesktopUpdateArtifacts({
      directory: output,
      metadataName: 'feed/latest.yml',
      version,
      artifactName: `versions/${version}/Maka-${version}-win-x64.exe`,
    }),
  ]);

  const macMetadata = (await import('yaml')).parse(
    await readFile(join(output, 'feed', 'latest-mac.yml'), 'utf8'),
  );
  const windowsMetadata = (await import('yaml')).parse(
    await readFile(join(output, 'feed', 'latest.yml'), 'utf8'),
  );
  assert.equal(macMetadata.files[0].url, `versions/${version}/Maka-${version}-mac-arm64.zip`);
  assert.equal(windowsMetadata.path, `versions/${version}/Maka-${version}-win-x64.exe`);
  const index = await readFile(join(output, 'feed', 'index.html'), 'utf8');
  assert.match(index, /Desktop Nightly is a developer snapshot, not an Apache release/u);
  assert.match(index, new RegExp(`source commit <code>${'a'.repeat(40)}</code>`, 'u'));
  assert.match(index, new RegExp(`versions/${version}/Maka-${version}-mac-arm64\.dmg`, 'u'));
  assert.match(index, new RegExp(`versions/${version}/Maka-${version}-win-x64\.exe`, 'u'));
  assert.deepEqual((await readdir(join(output, 'feed'))).sort(), [
    'index.html',
    'latest-mac.yml',
    'latest.yml',
  ]);
  assert.deepEqual((await readdir(join(output, 'versions', version))).sort(), payloadNames);
});

test('the Desktop feed advances only to a newer npm run number', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-desktop-nightly-feed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(directory, 'latest-mac.yml'), 'version: 0.2.0-dev.42.20260829\n'),
    writeFile(join(directory, 'latest.yml'), 'version: 0.2.0-dev.42.20260829\n'),
  ]);
  await assert.doesNotReject(
    assertDesktopNightlyFeedAdvance({
      directory,
      candidateVersion: '0.3.0-dev.43.20260828',
      productVersion: '0.3.0',
    }),
  );
  await assert.rejects(
    assertDesktopNightlyFeedAdvance({
      directory,
      candidateVersion: '0.2.0-dev.41.20260830',
      productVersion: '0.2.0',
    }),
    /does not advance current run/u,
  );
});
