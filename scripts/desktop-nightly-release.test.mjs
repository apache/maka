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
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  prepareDesktopNightlyRelease,
  publishDesktopNightlyRelease,
} from './desktop-nightly-release.mjs';
import {
  addDesktopNightlyAttestation,
  desktopNightlyReleaseAssetNames,
  stageDesktopNightly,
} from './desktop-nightly.mjs';
import { productReleaseArtifactRecords } from './product-release-artifacts.mjs';

async function writeUpdateSet(directory, version, platform) {
  const isMac = platform === 'mac';
  const artifact = isMac ? `Maka-${version}-mac-arm64.zip` : `Maka-${version}-win-x64.exe`;
  const metadata = isMac ? 'dev-mac.yml' : 'dev.yml';
  const bytes = Buffer.from(`${platform} nightly bytes`);
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  await Promise.all([
    writeFile(join(directory, artifact), bytes),
    writeFile(join(directory, `${artifact}.blockmap`), `${platform} blockmap`),
    writeFile(
      join(directory, metadata),
      `version: ${version}\nfiles:\n  - url: ${artifact}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${artifact}\nsha512: ${sha512}\n`,
    ),
  ]);
}

async function stageRelease(root, version) {
  const input = join(root, 'input');
  const output = join(root, 'output');
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
  const bundle = join(root, 'bundle.json');
  await writeFile(bundle, 'sigstore bundle');
  await addDesktopNightlyAttestation({ outputDirectory: output, version, bundlePath: bundle });
  return join(output, 'release');
}

test('Nightly publication verifies the exact draft before one Prerelease/non-Latest mutation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-nightly-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = '0.2.0-dev.42.20260829';
  const tag = `v${version}`;
  const sourceCommit = 'a'.repeat(40);
  const directory = await stageRelease(root, version);
  const records = await productReleaseArtifactRecords(
    directory,
    desktopNightlyReleaseAssetNames(version),
  );
  const calls = [];
  let remoteAssets = records.slice(0, 1);
  let draft = true;
  let tampered = false;
  const release = () => ({
    databaseId: 42,
    tagName: tag,
    isDraft: draft,
    isPrerelease: true,
    assets: remoteAssets.map((record, index) =>
      tampered && index === 0 ? { ...record, digest: `sha256:${'0'.repeat(64)}` } : record,
    ),
  });
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'git') return { stdout: `${sourceCommit}\trefs/tags/${tag}\n` };
    if (command === 'gh' && args[0] === 'release' && args[1] === 'upload') {
      remoteAssets = records;
      return { stdout: '' };
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'edit') return { stdout: '' };
    if (command === 'gh' && args[0] === 'release' && args[1] === 'view') {
      return { stdout: JSON.stringify(release()) };
    }
    if (command === 'gh' && args.includes('PATCH')) {
      draft = false;
      return {
        stdout: JSON.stringify({
          id: 42,
          tag_name: tag,
          draft: false,
          prerelease: true,
          assets: records,
        }),
      };
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  await prepareDesktopNightlyRelease({
    artifactDirectory: directory,
    repository: 'apache/maka',
    run,
    sourceCommit,
    version,
  });
  tampered = true;
  await assert.rejects(
    publishDesktopNightlyRelease({
      artifactDirectory: directory,
      repository: 'apache/maka',
      run,
      sourceCommit,
      version,
    }),
    /assets do not match local bytes/u,
  );
  assert.equal(draft, true);
  assert.equal(
    calls.some(([, args]) => args.includes('PATCH')),
    false,
  );
  tampered = false;
  await publishDesktopNightlyRelease({
    artifactDirectory: directory,
    repository: 'apache/maka',
    run,
    sourceCommit,
    version,
  });

  const upload = calls.find(([, args]) => args[0] === 'release' && args[1] === 'upload');
  const patchCall = calls.find(([, args]) => args.includes('PATCH'));
  assert.ok(upload);
  assert.deepEqual(
    upload[1].slice(3, upload[1].indexOf('--repo')).map((path) => basename(path)),
    records.slice(1).map(({ name }) => name),
  );
  assert.ok(patchCall);
  assert.ok(calls.indexOf(upload) < calls.indexOf(patchCall));
  assert.ok(patchCall[1].includes('draft=false'));
  assert.ok(patchCall[1].includes('prerelease=true'));
  assert.ok(patchCall[1].includes('make_latest=false'));
  const edit = calls.find(([, args]) => args[0] === 'release' && args[1] === 'edit');
  assert.match(edit[1].at(-1), /Developer Snapshot/u);
  assert.match(edit[1].at(-1), /not an Apache Release/u);
  assert.match(edit[1].at(-1), /DISCLAIMER-WIP/u);
  assert.match(edit[1].at(-1), /Apache License 2\.0/u);
});

test('a missing Nightly release is created only as a draft prerelease with Latest disabled', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-nightly-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = '0.2.0-dev.42.20260829';
  const tag = `v${version}`;
  const sourceCommit = 'a'.repeat(40);
  const directory = await stageRelease(root, version);
  const records = await productReleaseArtifactRecords(
    directory,
    desktopNightlyReleaseAssetNames(version),
  );
  const calls = [];
  let created = false;
  let uploaded = false;
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'git') return { stdout: `${sourceCommit}\trefs/tags/${tag}\n` };
    if (command === 'gh' && args[0] === 'release' && args[1] === 'view') {
      if (!created) {
        const error = new Error('release not found');
        error.stderr = 'release not found';
        throw error;
      }
      return {
        stdout: JSON.stringify({
          databaseId: 42,
          tagName: tag,
          isDraft: true,
          isPrerelease: true,
          assets: uploaded ? records : [],
        }),
      };
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'create') {
      created = true;
      return { stdout: '' };
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'edit') return { stdout: '' };
    if (command === 'gh' && args[0] === 'release' && args[1] === 'upload') {
      uploaded = true;
      return { stdout: '' };
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  await prepareDesktopNightlyRelease({
    artifactDirectory: directory,
    repository: 'apache/maka',
    run,
    sourceCommit,
    version,
  });

  const create = calls.find(([, args]) => args[0] === 'release' && args[1] === 'create');
  for (const flag of ['--draft', '--verify-tag', '--prerelease', '--latest=false']) {
    assert.ok(create[1].includes(flag), flag);
  }
});
