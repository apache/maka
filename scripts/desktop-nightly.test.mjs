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
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveDesktopBuilderConfig } from '../apps/desktop/electron-builder.config.mjs';
import { packageLinux } from './package-linux.mjs';
import { packageMacos } from './package-macos.mjs';
import { packageWindowsX64 } from './package-windows-x64.mjs';
import { desktopReleaseTargets } from './desktop-release-targets.mjs';
import { resolveDesktopBuildVersion, resolveRuntimeHostSetupPackage } from './desktop-nightly.mjs';
import { assertPackagedUpdateConfiguration } from './desktop-update-contract.mjs';

const run = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider.js');

test('a nightly package embeds only the Apache GitHub dev update authority', () => {
  const version = '0.2.0-dev.42.20260829';
  const config = resolveDesktopBuilderConfig({
    MAKA_DESKTOP_NIGHTLY_VERSION: version,
  });

  assert.equal(config.extraMetadata.version, version);
  assert.equal(config.extraMetadata.runtimeHostSetupPackage, `maka-agent@${version}`);
  assert.equal(config.extraMetadata.makaUpdateChannel, 'nightly');
  assert.equal(config.publish.length, 1);
  assert.deepEqual(config.publish[0], {
    provider: 'github',
    owner: 'apache',
    repo: 'maka',
    channel: 'dev',
  });
});

test('the macOS Nightly wrapper accepts dev update metadata', async () => {
  const version = '0.2.0-dev.42.20260829';
  const macosTarget = desktopReleaseTargets(version, { nightly: true }).find(
    (entry) => entry.name === 'macos-arm64',
  );
  const dmgPath = await packageMacos({
    targetArch: 'arm64',
    platform: 'darwin',
    arch: 'arm64',
    env: {
      MAKA_DESKTOP_NIGHTLY_VERSION: version,
      CSC_LINK: 'fixture',
      CSC_KEY_PASSWORD: 'fixture',
      APPLE_API_KEY: 'fixture',
      APPLE_API_KEY_ID: 'fixture',
      APPLE_API_ISSUER: 'fixture',
    },
    run: async () => {},
    remove: async () => {},
    move: async (source, destination) => {
      // The feed leaves packaging under its architecture so the two macOS
      // uploads cannot overwrite each other.
      assert.equal(basename(source), 'dev-mac.yml');
      assert.equal(basename(destination), macosTarget.feed);
      assert.equal(basename(destination), 'dev-mac-arm64.yml');
    },
    assertFile: async (path) => {
      if (path.endsWith('.yml')) assert.equal(basename(path), 'dev-mac.yml');
    },
  });
  // Nothing here spells a distributable's name: the descriptor does.
  assert.equal(
    basename(dmgPath),
    macosTarget.payloads.find((name) => name.endsWith('.dmg')),
  );
});

test('the Windows Nightly wrapper accepts dev update metadata', async () => {
  const version = '0.2.0-dev.42.20260829';
  const windowsTarget = desktopReleaseTargets(version, { nightly: true }).find(
    (entry) => entry.name === 'windows-x64',
  );
  const { exePath, zipPath } = await packageWindowsX64({
    platform: 'win32',
    arch: 'x64',
    env: { MAKA_DESKTOP_NIGHTLY_VERSION: version },
    run: async () => {},
    remove: async () => {},
    makeDirectory: async () => {},
    copy: async () => {},
    assertFile: async (path) => {
      if (path.endsWith('.yml')) {
        assert.equal(basename(path), windowsTarget.feed);
        assert.equal(basename(path), 'dev.yml');
      }
    },
  });
  // Nothing here spells a distributable's name: the descriptor does.
  assert.equal(
    basename(exePath),
    windowsTarget.payloads.find((name) => name.endsWith('.exe')),
  );
  assert.equal(
    basename(zipPath),
    windowsTarget.payloads.find((name) => name.endsWith('.zip')),
  );
});

test('the Linux Nightly wrapper builds the AppImage before the deb and merges one feed', async () => {
  const version = '0.2.0-dev.42.20260829';
  const events = [];
  await packageLinux({
    platform: 'linux',
    arch: 'x64',
    env: { MAKA_DESKTOP_NIGHTLY_VERSION: version },
    run: async (_command, args) => {
      const script = args.at(-1);
      if (script.startsWith('package:')) events.push(script);
    },
    remove: async () => {},
    move: async (source, destination) => {
      events.push(`move ${basename(source)} ${basename(destination)}`);
    },
    mergeFeeds: async ({ sourcePaths, outputPath }) => {
      events.push(
        `merge ${sourcePaths.map((path) => basename(path)).join(' ')} ${basename(outputPath)}`,
      );
    },
    assertFile: async () => {},
  });
  // The deb run writes a `package-type` marker into the tree both targets share,
  // and an AppImage carrying it updates itself by installing a deb. Building the
  // AppImage first, in a run of its own, is the only thing keeping it out — and
  // the second run rewrites the feed, so the two are merged back afterwards.
  assert.deepEqual(events, [
    'package:linux-appimage-x64',
    'move dev-linux.yml dev-linux.yml.appimage',
    'package:linux-deb-x64',
    'merge dev-linux.yml.appimage dev-linux.yml dev-linux.yml',
  ]);
});

test('a packaged Nightly accepts the pinned GitHub dev update channel', async () => {
  const packagedConfiguration = `provider: github
owner: apache
repo: maka
channel: dev
updaterCacheDirName: '@makadesktop-updater'
`;

  await assertPackagedUpdateConfiguration('/fixture', {
    channel: 'nightly',
    read: async () => packagedConfiguration,
  });
});

test('the GitHub dev provider resolves each platform payload to its absolute Release asset URL', () => {
  const version = '0.2.0-dev.42.20260829';
  for (const { platform, channel, name } of [
    {
      platform: 'darwin',
      channel: 'dev-mac',
      name: `Maka-${version}-mac-arm64.zip`,
    },
    { platform: 'win32', channel: 'dev', name: `Maka-${version}-win-x64.exe` },
  ]) {
    const provider = new GitHubProvider(
      { provider: 'github', owner: 'apache', repo: 'maka', channel: 'dev' },
      {
        allowPrerelease: true,
        channel: undefined,
        currentVersion: { raw: version },
      },
      { executor: {}, platform },
    );
    const [resolved] = provider.resolveFiles({
      tag: `v${version}`,
      files: [{ url: name, sha512: 'fixture' }],
    });

    assert.equal(provider.channel, channel);
    assert.equal(
      resolved.url.href,
      `https://github.com/apache/maka/releases/download/v${version}/${name}`,
    );
  }
});

test('GitHub differential updates derive the previous blockmap from the previous versioned tag', () => {
  const previous = '0.2.0-dev.41.20260828';
  const current = '0.2.0-dev.42.20260829';
  const provider = new GitHubProvider(
    { provider: 'github', owner: 'apache', repo: 'maka', channel: 'dev' },
    {
      allowPrerelease: true,
      channel: undefined,
      currentVersion: { raw: previous },
    },
    { executor: {}, platform: 'win32' },
  );
  const currentAsset = new URL(
    `https://github.com/apache/maka/releases/download/v${current}/Maka-${current}-win-x64.exe`,
  );

  const [oldBlockmap, newBlockmap] = provider.getBlockMapFiles(currentAsset, previous, current);

  assert.equal(
    oldBlockmap.href,
    `https://github.com/apache/maka/releases/download/v${previous}/Maka-${previous}-win-x64.exe.blockmap`,
  );
  assert.equal(newBlockmap.href, `${currentAsset.href}.blockmap`);
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
