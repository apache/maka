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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishDraftProductRelease } from './product-release-authority.mjs';
import { createProductReleasePublicationRecord } from './product-release-artifacts.mjs';

function updateMetadata(version, artifactName, bytes) {
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${artifactName}`,
    `    sha512: ${sha512}`,
    `    size: ${bytes.length}`,
    `path: ${artifactName}`,
    `sha512: ${sha512}`,
    '',
  ].join('\n');
}

test('publication verifies live asset digests before one Stable/Latest mutation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-publish-authority-'));
  const recordDirectory = await mkdtemp(join(tmpdir(), 'maka-publish-record-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(recordDirectory, { recursive: true, force: true }));
  const version = '1.2.3';
  const macZip = `Maka-${version}-mac-arm64.zip`;
  const exe = `Maka-${version}-win-x64.exe`;
  const macBytes = Buffer.from('mac application');
  const windowsBytes = Buffer.from('windows application');
  const names = [
    macZip,
    `${macZip}.blockmap`,
    'latest-mac.yml',
    exe,
    `${exe}.blockmap`,
    'latest.yml',
  ];
  await Promise.all([
    writeFile(join(directory, macZip), macBytes),
    writeFile(join(directory, `${macZip}.blockmap`), 'mac blockmap'),
    writeFile(join(directory, 'latest-mac.yml'), updateMetadata(version, macZip, macBytes)),
    writeFile(join(directory, exe), windowsBytes),
    writeFile(join(directory, `${exe}.blockmap`), 'windows blockmap'),
    writeFile(join(directory, 'latest.yml'), updateMetadata(version, exe, windowsBytes)),
  ]);
  const sourceCommit = 'a'.repeat(40);
  const record = await createProductReleasePublicationRecord({
    artifactDirectory: directory,
    identity: {
      version,
      tag: `v${version}`,
      sourceReferenceTag: `v${version}-incubating-rc1`,
      sourceCommit,
      exe,
      artifacts: { test: names },
    },
    repository: 'apache/maka',
    runId: '123',
    runAttempt: '2',
  });
  const attestationContents = Buffer.from('sigstore bundle');
  const attestationBundlePath = join(recordDirectory, 'Maka-1.2.3-attestation.sigstore.json');
  await writeFile(attestationBundlePath, attestationContents);
  const attestation = {
    name: 'Maka-1.2.3-attestation.sigstore.json',
    size: attestationContents.length,
    digest: `sha256:${createHash('sha256').update(attestationContents).digest('hex')}`,
  };
  const publicationRecordPath = join(recordDirectory, 'product-release.json');
  await writeFile(publicationRecordPath, `${JSON.stringify(record)}\n`);
  const calls = [];
  let latestReads = 0;
  let attestationUploaded = false;
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'git' && args[0] === 'ls-remote') {
      return { stdout: `${sourceCommit}\trefs/tags/v1.2.3\n` };
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'upload') {
      attestationUploaded = true;
      return { stdout: '' };
    }
    if (command === 'gh' && args[0] === 'release') {
      return {
        stdout: JSON.stringify({
          databaseId: 42,
          tagName: 'v1.2.3',
          isDraft: true,
          isPrerelease: false,
          assets: [...record.assets, ...(attestationUploaded ? [attestation] : [])],
        }),
      };
    }
    if (command === 'gh' && args.includes('PATCH')) {
      return {
        stdout: JSON.stringify({
          id: 42,
          tag_name: 'v1.2.3',
          draft: false,
          prerelease: false,
          assets: [...record.assets, attestation],
        }),
      };
    }
    if (command === 'gh' && args.includes('repos/apache/maka/releases/latest')) {
      latestReads += 1;
      return { stdout: JSON.stringify({ tag_name: latestReads === 1 ? 'v1.2.2' : 'v1.2.3' }) };
    }
    return { stdout: '' };
  };

  const publication = {
    tag: 'v1.2.3',
    sourceCommit,
    repository: 'apache/maka',
    artifactDirectory: directory,
    publicationRecordPath,
    sourceReferenceTag: 'v1.2.3-incubating-rc1',
    releaseRunId: '123',
    releaseRunAttempt: '2',
    attestationBundlePath,
    pause: async () => {},
  };
  await writeFile(join(directory, macZip), 'tampered mac application');
  await assert.rejects(
    publishDraftProductRelease({
      ...publication,
      run: async () => {
        throw new Error('network must not be reached for invalid local evidence');
      },
    }),
    /do not match the immutable publication record/u,
  );
  await writeFile(join(directory, macZip), macBytes);

  await publishDraftProductRelease({
    ...publication,
    run,
  });

  const patchCall = calls.find(([, args]) => args.includes('PATCH'));
  assert.ok(patchCall);
  assert.ok(patchCall[1].includes('draft=false'));
  assert.ok(patchCall[1].includes('prerelease=false'));
  assert.ok(patchCall[1].includes('make_latest=true'));
  const uploadCall = calls.find(([, args]) => args[0] === 'release' && args[1] === 'upload');
  assert.ok(uploadCall);
  assert.ok(calls.indexOf(uploadCall) < calls.indexOf(patchCall));
  assert.equal(latestReads, 2);
});
