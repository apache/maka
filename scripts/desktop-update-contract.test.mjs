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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertPackagedUpdateConfiguration,
  bumpedAutoupdateVersion,
  startDesktopUpdateFeed,
  verifyDesktopUpdateArtifacts,
} from './desktop-update-contract.mjs';

test('packaged clients have one exact production update authority', async () => {
  const expected =
    'owner: apache\nrepo: maka\nprovider: github\nupdaterCacheDirName: "@makadesktop-updater"\n';
  await assertPackagedUpdateConfiguration('resources', { read: async () => expected });
  await assert.rejects(
    assertPackagedUpdateConfiguration('resources', {
      read: async () => expected.replace('owner: apache', 'owner: personal-fork'),
    }),
    /expected.*apache/u,
  );
  await assert.rejects(
    assertPackagedUpdateConfiguration('resources', {
      read: async () => `${expected}extra: rejected\n`,
    }),
    /expected/u,
  );
});

test('the successor version follows the shared product SemVer contract', () => {
  assert.equal(bumpedAutoupdateVersion('1.2.3-beta.2'), '1.2.3');
  assert.equal(bumpedAutoupdateVersion('1.2.3'), '1.2.4');
});

test('update metadata is bound to the only published payload bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-update-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifactName = 'Maka-1.2.3-mac-arm64.zip';
  const bytes = Buffer.from('signed application zip');
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  await Promise.all([
    writeFile(join(directory, artifactName), bytes),
    writeFile(join(directory, `${artifactName}.blockmap`), 'blockmap'),
    writeFile(
      join(directory, 'latest-mac.yml'),
      [
        'version: 1.2.3',
        'files:',
        `  - url: ${artifactName}`,
        `    sha512: ${sha512}`,
        `    size: ${bytes.length}`,
        `path: ${artifactName}`,
        `sha512: ${sha512}`,
        '',
      ].join('\n'),
    ),
  ]);
  await verifyDesktopUpdateArtifacts({
    directory,
    metadataName: 'latest-mac.yml',
    version: '1.2.3',
    artifactName,
  });
  await writeFile(join(directory, artifactName), 'changed');
  await assert.rejects(
    verifyDesktopUpdateArtifacts({
      directory,
      metadataName: 'latest-mac.yml',
      version: '1.2.3',
      artifactName,
    }),
    /sha512 does not match/u,
  );
});

test('the shared update feed is exact and supports ranged transfers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-update-feed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'unused'));
  const payload = join(directory, 'payload.zip');
  await writeFile(payload, '0123456789');
  const feed = await startDesktopUpdateFeed(new Map([['payload.zip', payload]]));
  t.after(() => feed.close());

  const ranged = await fetch(`${feed.url}/payload.zip`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), '2345');
  assert.equal((await fetch(`${feed.url}/nested/payload.zip`)).status, 404);
  assert.equal(feed.unexpectedCount(), 1);
});
