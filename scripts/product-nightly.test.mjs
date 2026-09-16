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
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseProductNightlyVersionFile, productNightlyIdentity } from './product-nightly.mjs';
import { assertProductNightlyAdvances } from './release-version.mjs';

const run = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('a nightly identity is a dev build of the checked-in product version', () => {
  assert.deepEqual(
    productNightlyIdentity({
      productVersion: '0.2.0',
      date: new Date('2026-08-29T18:17:00Z'),
      runNumber: '42',
      sourceCommit: 'a'.repeat(40),
    }),
    {
      version: '0.2.0-dev.42.20260829',
      sourceCommit: 'a'.repeat(40),
    },
  );
});

test('the version handoff contains only the exact npm Nightly version', () => {
  assert.equal(
    parseProductNightlyVersionFile('0.2.0-dev.42.20260829\n', '0.2.0'),
    '0.2.0-dev.42.20260829',
  );
  for (const source of [
    '0.2.0-dev.42.20260829',
    '0.2.0-dev.42.20260829\nextra\n',
    '{"version":"0.2.0-dev.42.20260829"}\n',
  ]) {
    assert.throws(() => parseProductNightlyVersionFile(source, '0.2.0'));
  }
});

test('the version handoff CLI passes only the exact version to Desktop', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'maka-product-nightly-record-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const record = join(fixture, 'version.txt');
  const output = join(fixture, 'github-output');
  const script = join(repoRoot, 'scripts', 'product-nightly.mjs');
  const version = '0.2.0-dev.42.20260829';
  await run(process.execPath, [script, 'write-version', record, version]);
  await run(process.execPath, [script, 'inspect-version', record, output]);
  assert.equal(await readFile(output, 'utf8'), `version=${version}\n`);
});

test('run number is the single monotonic Nightly authority across dates and product versions', () => {
  assert.equal(
    assertProductNightlyAdvances('0.2.0-dev.43.20260828', '0.2.0-dev.42.20260829', '0.2.0'),
    '0.2.0-dev.43.20260828',
  );
  assert.equal(
    assertProductNightlyAdvances('0.3.0-dev.43.20260830', '0.2.0-dev.42.20260829', '0.3.0'),
    '0.3.0-dev.43.20260830',
  );
  for (const candidate of ['0.2.0-dev.42.20260830', '0.2.0-dev.41.20260830']) {
    assert.throws(
      () => assertProductNightlyAdvances(candidate, '0.2.0-dev.42.20260829', '0.2.0'),
      /does not advance current run/u,
    );
  }
});

test('the npm channel CLI advances across the checked-in product version boundary', async () => {
  await assert.doesNotReject(
    run(process.execPath, [
      join(repoRoot, 'scripts', 'product-nightly.mjs'),
      'assert-channel-advance',
      '0.2.0-dev.43.20260830',
      '0.1.0-dev.42.20260829',
    ]),
  );
});

test('the identity entrypoint runs before repository dependencies are installed', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'maka-nightly-identity-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'scripts'));
  await Promise.all([
    copyFile(join(repoRoot, 'package.json'), join(fixture, 'package.json')),
    copyFile(
      join(repoRoot, 'scripts', 'product-nightly.mjs'),
      join(fixture, 'scripts', 'product-nightly.mjs'),
    ),
    copyFile(
      join(repoRoot, 'scripts', 'release-version.mjs'),
      join(fixture, 'scripts', 'release-version.mjs'),
    ),
  ]);

  const { stdout } = await run(process.execPath, ['scripts/product-nightly.mjs', 'identity'], {
    cwd: fixture,
    env: {
      GITHUB_RUN_NUMBER: '42',
      GITHUB_SHA: 'a'.repeat(40),
      NIGHTLY_BUILD_DATE: '2026-08-29T18:17:00Z',
    },
  });
  assert.deepEqual(JSON.parse(stdout), {
    version: '0.2.0-dev.42.20260829',
    sourceCommit: 'a'.repeat(40),
  });
});
