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
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveDesktopBuilderConfig } from '../apps/desktop/electron-builder.config.mjs';
import { desktopNightlyIdentity, resolveDesktopBuildVersion } from './desktop-nightly.mjs';

const run = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('a nightly identity is a dev build of the checked-in product version', () => {
  assert.deepEqual(
    desktopNightlyIdentity({
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

test('the identity entrypoint runs before repository dependencies are installed', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'maka-nightly-identity-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'scripts'));
  await Promise.all([
    copyFile(join(repoRoot, 'package.json'), join(fixture, 'package.json')),
    copyFile(
      join(repoRoot, 'scripts', 'desktop-nightly.mjs'),
      join(fixture, 'scripts', 'desktop-nightly.mjs'),
    ),
    copyFile(
      join(repoRoot, 'scripts', 'desktop-update-contract.mjs'),
      join(fixture, 'scripts', 'desktop-update-contract.mjs'),
    ),
    copyFile(
      join(repoRoot, 'scripts', 'release-version.mjs'),
      join(fixture, 'scripts', 'release-version.mjs'),
    ),
  ]);

  const { stdout } = await run(process.execPath, ['scripts/desktop-nightly.mjs', 'identity'], {
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

test('a nightly package embeds only the Apache Nightlies update authority', () => {
  const version = '0.2.0-dev.20260829.42';
  const config = resolveDesktopBuilderConfig({
    MAKA_DESKTOP_NIGHTLY_VERSION: version,
  });

  assert.equal(config.extraMetadata.version, version);
  assert.equal(config.extraMetadata.makaUpdateChannel, 'nightly');
  assert.deepEqual(config.publish, [
    {
      provider: 'generic',
      url: 'https://nightlies.apache.org/maka/desktop/',
    },
  ]);
});

test('formal release checks ignore the ambient Nightly packaging environment', async () => {
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...environment } = process.env;
  await run(
    process.execPath,
    [
      '--test',
      '--test-name-pattern=Desktop packaging derives|platform package verifiers',
      'scripts/product-release.test.mjs',
    ],
    {
      cwd: repoRoot,
      env: {
        ...environment,
        MAKA_DESKTOP_NIGHTLY_VERSION: '0.2.0-dev.20260829.42',
      },
    },
  );
});

test('packaging observes a valid nightly version without changing product manifests', () => {
  assert.equal(
    resolveDesktopBuildVersion('0.2.0', {
      MAKA_DESKTOP_NIGHTLY_VERSION: '0.2.0-dev.20260829.42',
    }),
    '0.2.0-dev.20260829.42',
  );
  assert.equal(resolveDesktopBuildVersion('0.2.0', {}), '0.2.0');
});
