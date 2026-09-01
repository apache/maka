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
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveDesktopBuilderConfig } from '../apps/desktop/electron-builder.config.mjs';
import { desktopPublishedFeeds, desktopReleaseTargets } from './desktop-release-targets.mjs';

// The descriptor states what electron-builder produces. Asking electron-builder
// itself is the only way to know whether that statement is true, so this test
// drives its own resolution functions rather than restating their behaviour.
const require = createRequire(import.meta.url);
const { Packager } = require('app-builder-lib');
const {
  computeArchToTargetNamesMap,
  createTargets,
} = require('app-builder-lib/out/targets/targetFactory');
const { expandMacro } = require('app-builder-lib/out/util/macroExpander');
const { Arch, getArtifactArchName } = require('builder-util/out/arch');
const { normalizeOptions } = require('electron-builder/out/builder');

const VERSION = '9.8.7';
const PLATFORM_FLAGS = new Set(['mac', 'win', 'linux']);
const ARCHITECTURE_FLAGS = new Set(['x64', 'arm64', 'ia32', 'armv7l', 'universal']);
/** The file extension each target emits, which is also the `${ext}` macro. */
const TARGET_EXTENSIONS = Object.freeze({
  dmg: 'dmg',
  zip: 'zip',
  nsis: 'exe',
  AppImage: 'AppImage',
  deb: 'deb',
});
const DESCRIPTOR_PLATFORMS = Object.freeze({ mac: 'macos', win: 'windows', linux: 'linux' });

/**
 * Only the NSIS installer and the macOS ZIP get a `<file>.blockmap` beside them:
 * ArchiveTarget calls `createBlockmap` for a ZIP on macOS and `appendBlockmap`
 * everywhere else, and NsisTarget calls `createBlockmap` for the installer. An
 * AppImage carries its block map inside itself and fpm targets build none.
 */
function hasSidecarBlockmap(platformKey, targetName) {
  if (targetName === 'nsis') return true;
  return targetName === 'zip' && platformKey === 'mac';
}

/** yargs is not involved here, so the flags the packaging scripts use are parsed directly. */
function parseElectronBuilderArguments(command) {
  const tokens = command.split(/\s+/u);
  assert.equal(tokens.shift(), 'electron-builder');
  const parsed = {};
  let openPlatform = null;
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (!token.startsWith('--')) {
      assert.ok(openPlatform, `unexpected positional ${token} in ${command}`);
      parsed[openPlatform].push(token);
      continue;
    }
    const name = token.slice(2);
    openPlatform = null;
    if (PLATFORM_FLAGS.has(name)) {
      parsed[name] = [];
      openPlatform = name;
    } else if (ARCHITECTURE_FLAGS.has(name)) {
      parsed[name] = true;
    } else if (tokens[0] && !tokens[0].startsWith('--')) {
      tokens.shift();
    }
  }
  return parsed;
}

/** What one packaging script actually leaves in the release directory. */
function producedArtifacts(command, configuration) {
  const { targets } = normalizeOptions(parseElectronBuilderArguments(command));
  const produced = [];
  for (const [platform, raw] of targets) {
    const platformKey = platform.buildConfigurationKey;
    const options = configuration[platformKey];
    const resolved = computeArchToTargetNamesMap(
      raw,
      { platformSpecificBuildOptions: options },
      platform,
    );
    for (const [arch, targetNames] of resolved) {
      for (const targetName of targetNames) {
        const ext = TARGET_EXTENSIONS[targetName];
        assert.ok(ext, `unknown target ${targetName}`);
        const pattern = options.artifactName ?? configuration.artifactName;
        const name = expandMacro(
          pattern,
          getArtifactArchName(arch, ext),
          { version: VERSION },
          {
            ext,
          },
        );
        produced.push({ platformKey, arch: Arch[arch], name });
        if (hasSidecarBlockmap(platformKey, targetName)) {
          produced.push({ platformKey, arch: Arch[arch], name: `${name}.blockmap` });
        }
      }
    }
  }
  return produced;
}

async function packagingScripts() {
  const manifest = JSON.parse(
    await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'),
  );
  return Object.entries(manifest.scripts).filter(
    ([name, command]) => name.startsWith('package:') && command.startsWith('electron-builder'),
  );
}

test('the packaging scripts produce exactly the payloads the target descriptor names', async () => {
  const configuration = resolveDesktopBuilderConfig({});
  const scripts = await packagingScripts();
  assert.ok(scripts.length > 0);

  const produced = new Map();
  for (const [, command] of scripts) {
    for (const artifact of producedArtifacts(command, configuration)) {
      const target = `${DESCRIPTOR_PLATFORMS[artifact.platformKey]}-${artifact.arch}`;
      if (!produced.has(target)) produced.set(target, []);
      produced.get(target).push(artifact.name);
    }
  }

  const expected = new Map(
    desktopReleaseTargets(VERSION, { nightly: false }).map((target) => [
      target.name,
      [...target.payloads].sort(),
    ]),
  );
  assert.deepEqual(
    [...produced.keys()].sort(),
    [...expected.keys()].sort(),
    'a packaging script builds a target the descriptor does not describe, or the reverse',
  );
  for (const [target, names] of produced) {
    assert.deepEqual([...names].sort(), expected.get(target), `payloads of ${target}`);
  }
});

test('no packaging script builds an architecture other than its own', async () => {
  const configuration = resolveDesktopBuilderConfig({});
  for (const [name, command] of await packagingScripts()) {
    const architectures = new Set(
      producedArtifacts(command, configuration).map((artifact) => artifact.arch),
    );
    // The native Runtime Host peer is built for the host, so a runner that also
    // cross-built the other architecture would ship it the wrong peer — and,
    // on macOS, one that was never notarized.
    assert.equal(architectures.size, 1, `${name} builds ${[...architectures].join(' and ')}`);
    assert.ok(name.endsWith(`-${[...architectures][0]}`), `${name} does not name its architecture`);
  }
});

/**
 * A Linux executable name reaches the desktop entry's `Exec=` and `Icon=`, so it
 * has to be a name a shell and a desktop environment will accept.
 */
const LINUX_EXECUTABLE_NAME = /^[a-z0-9][a-z0-9+._-]*$/u;
const DESKTOP_PROJECT_DIRECTORY = fileURLToPath(new URL('../apps/desktop', import.meta.url));

/**
 * electron-builder rewrites the configuration object it is handed — `normalizeFiles`
 * turns `files` into records in place — and `resolveDesktopBuilderConfig` returns one
 * shared module-level object outside the Nightly branch. Packaging calls it once, so
 * this only bites a test that builds several packagers.
 *
 * Copied through JSON rather than `structuredClone`: everything electron-builder reads
 * here has to survive serialization anyway, and the structured clone algorithm rejected
 * this object on Node 24 while accepting it on 26. `beforePack` is the one function in
 * the configuration; it is carried across by reference and never invoked by this test.
 */
function isolatedBuilderConfig() {
  const { beforePack, ...rest } = resolveDesktopBuilderConfig({});
  return { ...JSON.parse(JSON.stringify(rest)), beforePack };
}

/**
 * electron-builder settles the Linux executable name and the deb's metadata long
 * before it packages anything, and both are drawn from places the packaging
 * configuration never mentions: the executable name falls back to the npm package
 * name — which is scoped here, so it is not a legal executable name — and fpm
 * refuses to run without a project homepage the manifests do not declare. Neither
 * failure needs a build to observe, and neither is visible on macOS or Windows.
 * Asking electron-builder costs milliseconds on any host; learning it from a real
 * Linux build costs a runner, and learning it on release day costs a release.
 */
test('electron-builder accepts the configuration for every Linux target', async () => {
  const scripts = (await packagingScripts()).filter(
    ([, command]) => parseElectronBuilderArguments(command).linux,
  );
  assert.ok(scripts.length > 0, 'no Linux packaging script to check');

  for (const [name, command] of scripts) {
    const { targets } = normalizeOptions(parseElectronBuilderArguments(command));
    for (const [platform, raw] of targets) {
      const packager = new Packager({
        targets,
        projectDir: DESKTOP_PROJECT_DIRECTORY,
        config: isolatedBuilderConfig(),
      });
      await packager.validateConfig();
      const helper = await packager.createHelper(platform);

      assert.match(
        helper.executableName,
        LINUX_EXECUTABLE_NAME,
        `${name} would install the executable as ${helper.executableName}`,
      );
      // The AppImage target inherits an empty `checkOptions`, so the assertion
      // above is the only one that covers it; fpm implements it and is where the
      // packaging metadata — homepage, maintainer — is demanded.
      for (const target of createTargets(
        new Map(),
        [...raw.values()].flat(),
        packager.projectDir,
        helper,
      )) {
        await target.checkOptions();
      }
    }
  }
});

test('every payload a runner uploads is advertised or accounted for by one feed', () => {
  const targets = desktopReleaseTargets(VERSION, { nightly: false });
  const feeds = desktopPublishedFeeds(VERSION, { nightly: false });
  const advertised = new Set(feeds.flatMap((feed) => feed.advertised));
  for (const target of targets) {
    for (const name of target.advertised) {
      assert.ok(target.payloads.includes(name), `${target.name} advertises an unbuilt ${name}`);
      assert.ok(advertised.has(name), `${name} is advertised by no published feed`);
    }
    for (const name of target.checksums) {
      assert.ok(target.payloads.includes(name), `${target.name} checksums an unbuilt ${name}`);
    }
  }
  // A merged feed exists only for macOS, and it must consume every feed the
  // macOS runners write — publishing one alone would offer one architecture an
  // update it cannot install.
  const merged = feeds.filter((feed) => feed.mergedFrom);
  assert.deepEqual(
    merged.flatMap((feed) => feed.mergedFrom).toSorted(),
    targets
      .filter((target) => target.platform === 'macos')
      .map((target) => target.feed)
      .toSorted(),
  );
});
