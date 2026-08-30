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
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveDesktopBuilderConfig } from '../apps/desktop/electron-builder.config.mjs';
import { resolveDesktopBuildVersion, resolveRuntimeHostSetupPackage } from './desktop-nightly.mjs';
import { assertPackagedUpdateConfiguration } from './desktop-update-contract.mjs';

const run = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('a nightly package embeds only the Apache Nightlies update authority', () => {
  const version = '0.2.0-dev.42.20260829';
  const config = resolveDesktopBuilderConfig({
    MAKA_DESKTOP_NIGHTLY_VERSION: version,
  });

  assert.equal(config.extraMetadata.version, version);
  assert.equal(config.extraMetadata.runtimeHostSetupPackage, `maka-agent@${version}`);
  assert.equal(config.extraMetadata.makaUpdateChannel, 'nightly');
  assert.equal(config.publish.length, 1);
  assert.equal(config.publish[0].provider, 'generic');
  assert.equal(config.publish[0].url, 'https://nightlies.apache.org/maka/desktop/');
});

test('a dev Nightly identity still advances the latest Desktop feed', () => {
  const config = resolveDesktopBuilderConfig({
    MAKA_DESKTOP_NIGHTLY_VERSION: '0.2.0-dev.42.20260829',
  });

  assert.equal(config.publish[0].channel, 'latest');
});

test('a packaged Nightly accepts the pinned latest update channel', async () => {
  const packagedConfiguration = `provider: generic
url: https://nightlies.apache.org/maka/desktop/
channel: latest
updaterCacheDirName: '@makadesktop-updater'
`;

  await assertPackagedUpdateConfiguration('/fixture', {
    channel: 'nightly',
    read: async () => packagedConfiguration,
  });
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
        MAKA_DESKTOP_NIGHTLY_VERSION: '0.2.0-dev.42.20260829',
      },
    },
  );
});

test('packaging observes a valid nightly version without changing product manifests', () => {
  assert.equal(
    resolveDesktopBuildVersion('0.2.0', {
      MAKA_DESKTOP_NIGHTLY_VERSION: '0.2.0-dev.42.20260829',
    }),
    '0.2.0-dev.42.20260829',
  );
  assert.equal(resolveDesktopBuildVersion('0.2.0', {}), '0.2.0');
  assert.equal(
    resolveRuntimeHostSetupPackage('0.2.0', {
      MAKA_DESKTOP_NIGHTLY_VERSION: '0.2.0-dev.42.20260829',
    }),
    'maka-agent@0.2.0-dev.42.20260829',
  );
});
