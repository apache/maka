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
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertExactArtifactSet,
  assertProductReleasePublicationRecord,
  createProductReleasePublicationRecord,
  stageProductReleaseArtifactGroup,
  verifyProductReleaseArtifactIntegrity,
  verifyProductReleasePublicationRecord,
} from './product-release-artifacts.mjs';

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

test('product release artifact validation rejects missing and unexpected files', () => {
  assert.deepEqual(assertExactArtifactSet(['b.zip', 'a.dmg'], ['a.dmg', 'b.zip']), [
    'a.dmg',
    'b.zip',
  ]);
  assert.throws(() => assertExactArtifactSet(['a.dmg'], ['a.dmg', 'b.zip']), /missing b\.zip/u);
  assert.throws(
    () => assertExactArtifactSet(['a.dmg', 'debug.log'], ['a.dmg']),
    /unexpected debug\.log/u,
  );
});

test('artifact staging publishes exactly one manifest group', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-release-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, 'source');
  const targetDirectory = join(root, 'target');
  await mkdir(sourceDirectory);
  await Promise.all([
    writeFile(join(sourceDirectory, 'a.dmg'), 'dmg'),
    writeFile(join(sourceDirectory, 'a.dmg.sha256'), 'checksum'),
  ]);

  await stageProductReleaseArtifactGroup({
    sourceDirectory,
    targetDirectory,
    expectedNames: ['a.dmg', 'a.dmg.sha256'],
  });

  assert.equal(await readFile(join(targetDirectory, 'a.dmg'), 'utf8'), 'dmg');
  assert.equal(await readFile(join(targetDirectory, 'a.dmg.sha256'), 'utf8'), 'checksum');
});

test('artifact staging refuses to replace an existing target directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-release-artifacts-existing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, 'source');
  const targetDirectory = join(root, 'target');
  await Promise.all([mkdir(sourceDirectory), mkdir(targetDirectory)]);
  await Promise.all([
    writeFile(join(sourceDirectory, 'a.dmg'), 'dmg'),
    writeFile(join(targetDirectory, 'keep.txt'), 'keep'),
  ]);

  await assert.rejects(
    stageProductReleaseArtifactGroup({
      sourceDirectory,
      targetDirectory,
      expectedNames: ['a.dmg'],
    }),
    /target directory must be empty/u,
  );
  assert.equal(await readFile(join(targetDirectory, 'keep.txt'), 'utf8'), 'keep');
});

test('final artifact verification binds checksums and both update channels to exact bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-release-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = '1.2.3';
  const macZip = `Maka-${version}-mac-arm64.zip`;
  const exe = `Maka-${version}-win-x64.exe`;
  const manual = 'manual.txt';
  const macBytes = Buffer.from('mac application');
  const windowsBytes = Buffer.from('windows application');
  const manualBytes = Buffer.from('release notes');
  const names = [
    macZip,
    `${macZip}.blockmap`,
    'latest-mac.yml',
    exe,
    `${exe}.blockmap`,
    'latest.yml',
    manual,
    `${manual}.sha256`,
  ];
  await Promise.all([
    writeFile(join(directory, macZip), macBytes),
    writeFile(join(directory, `${macZip}.blockmap`), 'mac blockmap'),
    writeFile(join(directory, 'latest-mac.yml'), updateMetadata(version, macZip, macBytes)),
    writeFile(join(directory, exe), windowsBytes),
    writeFile(join(directory, `${exe}.blockmap`), 'windows blockmap'),
    writeFile(join(directory, 'latest.yml'), updateMetadata(version, exe, windowsBytes)),
    writeFile(join(directory, manual), manualBytes),
    writeFile(
      join(directory, `${manual}.sha256`),
      `${createHash('sha256').update(manualBytes).digest('hex')}  ${manual}\n`,
    ),
  ]);
  const identity = { version, exe, artifacts: { test: names } };

  assert.deepEqual(await verifyProductReleaseArtifactIntegrity(directory, identity), names);
  await writeFile(join(directory, `${manual}.sha256`), `${'0'.repeat(64)}  ${manual}\n`);
  await assert.rejects(
    verifyProductReleaseArtifactIntegrity(directory, identity),
    /checksum does not match/u,
  );
});

test('publication record binds exact build identity and every artifact byte', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-release-publication-record-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
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
  const identity = {
    version,
    isPrerelease: false,
    tag: `v${version}`,
    sourceReferenceTag: `v${version}-incubating-rc1`,
    sourceCommit: 'a'.repeat(40),
    exe,
    artifacts: { test: names },
  };
  const record = await createProductReleasePublicationRecord({
    artifactDirectory: directory,
    identity,
    repository: 'apache/maka',
    runId: '123',
    runAttempt: '2',
  });

  assert.equal(record.workflow, '.github/workflows/release.yml');
  assert.deepEqual(
    record.assets.map(({ name }) => name),
    [...names].sort(),
  );
  assert.equal(
    assertProductReleasePublicationRecord(record, {
      repository: 'apache/maka',
      tag: 'v1.2.3',
      sourceCommit: 'a'.repeat(40),
      sourceReferenceTag: 'v1.2.3-incubating-rc1',
      runId: '123',
      runAttempt: '2',
    }),
    record,
  );
  await verifyProductReleasePublicationRecord({
    artifactDirectory: directory,
    record,
    expected: { runId: '123', runAttempt: '2' },
  });
  assert.throws(
    () => assertProductReleasePublicationRecord(record, { runAttempt: '3' }),
    /runAttempt does not match/u,
  );

  await writeFile(join(directory, macZip), 'tampered mac application');
  await assert.rejects(
    verifyProductReleasePublicationRecord({ artifactDirectory: directory, record }),
    /do not match the immutable publication record/u,
  );
});
