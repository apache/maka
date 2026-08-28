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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { stageDesktopNightly } from './desktop-nightly.mjs';

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

test('staging publishes immutable payloads before versioned Nightly metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-nightly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input');
  const output = join(root, 'output');
  const version = '0.2.0-dev.20260829.42';
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

  const macMetadata = (await import('yaml')).parse(
    await readFile(join(output, 'latest-mac.yml'), 'utf8'),
  );
  const windowsMetadata = (await import('yaml')).parse(
    await readFile(join(output, 'latest.yml'), 'utf8'),
  );
  assert.equal(macMetadata.files[0].url, `versions/${version}/Maka-${version}-mac-arm64.zip`);
  assert.equal(windowsMetadata.path, `versions/${version}/Maka-${version}-win-x64.exe`);
  assert.equal(
    JSON.parse(await readFile(join(output, 'nightly.json'), 'utf8')).sourceCommit,
    'a'.repeat(40),
  );
  const index = await readFile(join(output, 'index.html'), 'utf8');
  assert.match(index, /Desktop Nightly is a developer snapshot, not an Apache release/u);
  assert.match(index, new RegExp(`versions/${version}/Maka-${version}-mac-arm64\.dmg`, 'u'));
  assert.match(index, new RegExp(`versions/${version}/Maka-${version}-win-x64\.exe`, 'u'));
  await readFile(join(output, 'versions', version, `Maka-${version}-mac-arm64.zip`));
  await readFile(join(output, 'versions', version, `Maka-${version}-win-x64.exe`));
});
