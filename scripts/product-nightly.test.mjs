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
import {
  createProductNightlyPublicationRecord,
  productNightlyIdentity,
  validateProductNightlyPublicationRecord,
} from './product-nightly.mjs';

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
      version: '0.2.0-dev.20260829.42',
      sourceCommit: 'a'.repeat(40),
    },
  );
});

test('Desktop consumes the exact successful npm Nightly identity', () => {
  const record = createProductNightlyPublicationRecord({
    productVersion: '0.2.0',
    version: '0.2.0-dev.20260829.42',
    sourceCommit: 'a'.repeat(40),
    repository: 'apache/maka',
    workflowPath: '.github/workflows/npm-publication.yml',
    runId: '123',
    runAttempt: '1',
  });
  assert.deepEqual(
    validateProductNightlyPublicationRecord(record, {
      productVersion: '0.2.0',
      sourceCommit: 'a'.repeat(40),
      repository: 'apache/maka',
      workflowPath: '.github/workflows/npm-publication.yml',
      runId: '123',
      runAttempt: '1',
    }),
    record,
  );
  assert.throws(
    () =>
      validateProductNightlyPublicationRecord(record, {
        productVersion: '0.2.0',
        sourceCommit: 'b'.repeat(40),
        repository: 'apache/maka',
        workflowPath: '.github/workflows/npm-publication.yml',
        runId: '123',
        runAttempt: '1',
      }),
    /sourceCommit does not match/u,
  );
  assert.throws(
    () =>
      validateProductNightlyPublicationRecord(
        { ...record, schemaVersion: 2 },
        {
          productVersion: '0.2.0',
          sourceCommit: 'a'.repeat(40),
          repository: 'apache/maka',
          workflowPath: '.github/workflows/npm-publication.yml',
          runId: '123',
          runAttempt: '1',
        },
      ),
    /schema version is unsupported/u,
  );
});

test('the publication record CLI hands the exact npm run to Desktop', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'maka-product-nightly-record-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const record = join(fixture, 'identity.json');
  const output = join(fixture, 'github-output');
  const script = join(repoRoot, 'scripts', 'product-nightly.mjs');
  const version = '0.2.0-dev.20260829.42';
  const sourceCommit = 'a'.repeat(40);
  await run(process.execPath, [
    script,
    'write-publication-record',
    record,
    version,
    sourceCommit,
    '123',
    '1',
    'apache/maka',
    '.github/workflows/npm-publication.yml',
  ]);
  await run(process.execPath, [
    script,
    'inspect-publication-record',
    record,
    '123',
    '1',
    'apache/maka',
    '.github/workflows/npm-publication.yml',
    sourceCommit,
    output,
  ]);
  assert.equal(
    await readFile(output, 'utf8'),
    `version=${version}\nsource_commit=${sourceCommit}\n`,
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
    version: '0.2.0-dev.20260829.42',
    sourceCommit: 'a'.repeat(40),
  });
});
