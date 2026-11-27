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
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { npmSpawnOptions } from '../npm-spawn.mjs';
import {
  artifactNames,
  buildAndPackageNightly,
  packageNightly,
  packNightlyNpmLaunchers,
  packNightlyNpmPlatform,
  publishNightlyNpm,
  releaseBuildEnv,
  renderInnoSetupScript,
  tarballIntegrity,
  windowsTarExecutable,
} from './package-nightly.mjs';

test('packageNightly packages linux-arm64-gnu with install.sh and all legal files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-pkg-linux-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  const outDir = join(root, 'out');
  await mkdir(binDir, { recursive: true });
  for (const name of ['maka', 'maka-desktop-shell', 'maka-python-worker']) {
    await writeFile(join(binDir, name), '#!/bin/sh\necho ' + name + '\n');
    await chmod(join(binDir, name), 0o755);
  }
  const notices = join(root, 'THIRD_PARTY_NOTICES.txt');
  await writeFile(notices, 'Third-party notices');

  const produced = await packageNightly({
    target: 'linux-arm64-gnu',
    version: '0.2.0-nightly.20261121.1',
    binary: join(binDir, 'maka'),
    notices,
    output: outDir,
  });
  assert.equal(produced.length, 2);
  assert.match(produced[1], /THIRD_PARTY_NOTICES-linux-arm64-gnu\.txt$/);
  const listing = execFileSync('tar', ['-tzf', produced[0]], { encoding: 'utf8' });
  assert.match(listing, /^maka\/maka$/m);
  assert.match(listing, /^maka\/maka-desktop-shell$/m);
  assert.match(listing, /^maka\/maka-python-worker$/m);
  assert.match(listing, /^maka\/install\.sh$/m);
  assert.match(listing, /^maka\/DISCLAIMER$/m);
  assert.match(listing, /^maka\/THIRD_PARTY_NOTICES\.txt$/m);
});

test('renderInnoSetupScript configures per-user install and user PATH without elevation', () => {
  const script = renderInnoSetupScript({
    sourceDir: 'C:\\build\\Maka',
    outputDir: 'C:\\out',
    setupBaseName: 'Maka-nightly-windows-x64-setup',
    version: '0.2.0-nightly.20261121.7',
    iconPath: 'C:\\build\\maka.ico',
  });
  assert.match(script, /PrivilegesRequired=lowest/);
  assert.match(script, /DefaultDirName=\{localappdata\}\\Programs\\Maka/);
  assert.match(script, /UninstallFilesDir=\{localappdata\}\\Programs\\Maka-Uninstall/);
  assert.match(script, /AppUserModelID: "org\.apache\.maka\.desktop"/);
  assert.match(script, /AddDirToUserPath/);
});

test('packageNightly packages self-contained Maka.app tar.gz on macOS', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-pkg-mac-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  const outDir = join(root, 'out');
  await mkdir(binDir, { recursive: true });
  for (const name of ['maka', 'maka-desktop-shell', 'maka-host-shell', 'maka-python-worker']) {
    await writeFile(join(binDir, name), '#!/bin/sh\necho ' + name + '\n');
    await chmod(join(binDir, name), 0o755);
  }
  const notices = join(root, 'THIRD_PARTY_NOTICES.txt');
  await writeFile(notices, 'Third-party notices');

  const produced = await packageNightly({
    target: 'darwin-arm64',
    version: '0.2.0-nightly.20261121.1',
    binary: join(binDir, 'maka'),
    notices,
    output: outDir,
    skipDmg: true,
  });
  assert.equal(produced.length, 2);
  assert.match(produced[1], /THIRD_PARTY_NOTICES-darwin-arm64\.txt$/);
  const listing = execFileSync('/usr/bin/tar', ['-tzf', produced[0]], { encoding: 'utf8' });
  assert.match(listing, /Maka\.app\/Contents\/MacOS\/maka-desktop-shell/);
  assert.match(listing, /Maka\.app\/Contents\/MacOS\/maka$/m);
  assert.match(listing, /Maka\.app\/Contents\/MacOS\/maka-python-worker/);
  assert.match(listing, /Maka\.app\/Contents\/Helpers\/Maka Host\.app\//);
  assert.match(listing, /Maka\.app\/Contents\/Resources\/THIRD_PARTY_NOTICES\.txt/);
});

test('maka-agent alias and @maka-agent/cli both invoke the native platform binary offline', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-npm-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  const npmDir = join(root, 'npm');
  const installDir = join(root, 'install');
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  const target =
    process.platform + '-' + process.arch + (process.platform === 'linux' ? '-gnu' : '');
  const version = '0.2.0-nightly.20261121.9';

  await writeFile(join(binDir, 'maka'), '#!/bin/sh\necho "maka-native:$*"\n');
  await chmod(join(binDir, 'maka'), 0o755);
  for (const name of ['maka-desktop-shell', 'maka-host-shell', 'maka-python-worker']) {
    await writeFile(join(binDir, name), '#!/bin/sh\necho ' + name + '\n');
    await chmod(join(binDir, name), 0o755);
  }
  const notices = join(root, 'THIRD_PARTY_NOTICES.txt');
  await writeFile(notices, 'Third-party notices');

  const nativePkg = await packNightlyNpmPlatform({
    target,
    version,
    binary: join(binDir, 'maka'),
    notices,
    output: npmDir,
  });
  const [cliPkg, aliasPkg] = await packNightlyNpmLaunchers({
    version,
    output: npmDir,
    targets: [target],
  });

  // Install maka-agent (alias) + @maka-agent/cli + native platform tarball offline.
  await writeFile(join(installDir, 'package.json'), JSON.stringify({ private: true }));
  execFileSync(
    'npm',
    [
      'install',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      nativePkg.archive,
      cliPkg.archive,
      aliasPkg.archive,
    ],
    npmSpawnOptions({ cwd: installDir, stdio: 'pipe' }),
  );
  const output = execFileSync(
    process.execPath,
    [join(installDir, 'node_modules/maka-agent/bin/maka.mjs'), '--hello', 'world'],
    { encoding: 'utf8' },
  );
  assert.equal(output.trim(), 'maka-native:--hello world');
});

test('windowsTarExecutable resolves built-in System32 bsdtar rather than PATH tar', () => {
  assert.equal(
    windowsTarExecutable({ SystemRoot: 'D:\\Windows' }),
    'D:\\Windows\\System32\\tar.exe',
  );
  assert.equal(windowsTarExecutable({ SYSTEMROOT: 'C:\\WINNT' }), 'C:\\WINNT\\System32\\tar.exe');
  assert.equal(windowsTarExecutable({}), 'C:\\Windows\\System32\\tar.exe');
});

test('release channel uses versioned archive names and rejects prerelease versions', async (t) => {
  assert.deepEqual(artifactNames('darwin-arm64', 'release', '0.3.0'), {
    archiveName: 'Maka-0.3.0-macos-arm64.tar.gz',
    installerName: 'Maka-0.3.0-macos-arm64.dmg',
  });
  assert.throws(
    () => artifactNames('linux-x64-gnu', 'release', '0.3.0-nightly.20261125.1'),
    /stable X\.Y\.Z/,
  );

  const root = await mkdtemp(join(tmpdir(), 'maka-pkg-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  const outDir = join(root, 'out');
  await mkdir(binDir, { recursive: true });
  for (const name of ['maka', 'maka-desktop-shell', 'maka-python-worker']) {
    await writeFile(join(binDir, name), '#!/bin/sh\necho ' + name + '\n');
    await chmod(join(binDir, name), 0o755);
  }
  const notices = join(root, 'THIRD_PARTY_NOTICES.txt');
  await writeFile(notices, 'Third-party notices');

  const produced = await packageNightly({
    target: 'linux-x64-gnu',
    version: '0.3.0',
    channel: 'release',
    binary: join(binDir, 'maka'),
    notices,
    output: outDir,
  });
  assert.match(produced[0], /Maka-0\.3\.0-linux-x64\.tar\.gz$/);
  const installScript = execFileSync('tar', ['-xOzf', produced[0], 'maka/install.sh'], {
    encoding: 'utf8',
  });
  assert.doesNotMatch(installScript, /nightly/i);
  assert.match(installScript, /Comment=Apache Maka \(incubating\)/);

  const releaseIss = renderInnoSetupScript({
    sourceDir: 'C:\\build\\Maka',
    outputDir: 'C:\\out',
    setupBaseName: 'Maka-0.3.0-windows-x64-setup',
    version: '0.3.0',
    iconPath: 'C:\\build\\maka.ico',
    channel: 'release',
  });
  assert.doesNotMatch(releaseIss, /nightly/i);
  assert.match(releaseIss, /AppVerName=Maka 0\.3\.0 \(incubating\)/);
  assert.match(releaseIss, /UninstallDisplayName=Maka$/m);
});

test('buildAndPackageNightly validates channel at entry and releaseBuildEnv populates native version identity', async () => {
  await assert.rejects(
    () =>
      buildAndPackageNightly({
        target: 'linux-x64-gnu',
        version: '0.3.0-nightly.20261125.1',
        output: '/tmp/unused',
        channel: 'release',
      }),
    /stable X\.Y\.Z/,
  );
  await assert.rejects(
    () =>
      buildAndPackageNightly({
        target: 'linux-x64-gnu',
        version: '0.3.0',
        output: '/tmp/unused',
        channel: 'bogus',
      }),
    /Unsupported distribution channel/,
  );

  const env = releaseBuildEnv({
    baseEnv: { MAKA_UPDATE_PUBLIC_KEY: 'pub-key', MAKA_UPDATE_REPO: 'apache/maka' },
    v8Env: { RUSTY_V8_ARCHIVE: '/tmp/v8.a' },
    channel: 'release',
    version: '0.3.0',
  });
  assert.equal(env.MAKA_UPDATE_CHANNEL, 'release');
  assert.equal(env.MAKA_BUILD_VERSION, '0.3.0');
  assert.equal(env.MAKA_NATIVE_PACKAGE_VERSION, '0.3.0');
  assert.equal(env.MAKA_UPDATE_PUBLIC_KEY, 'pub-key');
  assert.equal(env.MAKA_UPDATE_REPO, 'apache/maka');
  assert.equal(env.RUSTY_V8_ARCHIVE, '/tmp/v8.a');
});

test('publishNightlyNpm verifies tarball integrity and dist-tag before skipping published packages', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-publish-npm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const version = '0.3.0';
  const platformFile = 'maka-agent-cli-linux-x64-gnu-' + version + '.tgz';
  const launcherFile = 'maka-agent-cli-' + version + '.tgz';
  const aliasFile = 'maka-agent-' + version + '.tgz';
  await writeFile(join(dir, platformFile), 'platform-bytes');
  await writeFile(join(dir, launcherFile), 'launcher-bytes');
  await writeFile(join(dir, aliasFile), 'alias-bytes');

  const platformIntegrity = await tarballIntegrity(join(dir, platformFile));

  const launcherIntegrity = await tarballIntegrity(join(dir, launcherFile));

  // Matching integrity + dist-tag skips already-published packages under both
  // npm 12 array-wrapped --json output and npm 11 scalar/object --json output,
  // and publishes unpublished packages (empty array or E404) in order.
  const publishedCalls = [];
  await publishNightlyNpm({
    directory: dir,
    version,
    tag: 'latest',
    provenance: true,
    runNpm(args) {
      if (args[0] === 'view' && args[1] === '@maka-agent/cli-linux-x64-gnu@0.3.0') {
        return JSON.stringify([platformIntegrity]);
      }
      if (args[0] === 'view' && args[1] === '@maka-agent/cli-linux-x64-gnu') {
        return JSON.stringify([{ latest: '0.3.0', nightly: '0.3.0-nightly.20261125.1' }]);
      }
      if (args[0] === 'view' && args[1] === '@maka-agent/cli@0.3.0') {
        return JSON.stringify(launcherIntegrity);
      }
      if (args[0] === 'view' && args[1] === '@maka-agent/cli') {
        return JSON.stringify({ latest: '0.3.0' });
      }
      if (args[0] === 'view') {
        const err = new Error('404');
        err.stderr = 'npm error code E404';
        throw err;
      }
      publishedCalls.push(args);
      return '';
    },
  });
  assert.equal(publishedCalls.length, 1);
  assert.match(publishedCalls[0][1], /maka-agent-0\.3\.0\.tgz$/);
  assert.ok(publishedCalls[0].includes('--provenance'));

  // Empty array from npm 12 view --json means unpublished and proceeds to publish.
  const emptyArrayPublishes = [];
  await publishNightlyNpm({
    directory: dir,
    version,
    tag: 'latest',
    runNpm(args) {
      if (args[0] === 'view') return '[]';
      emptyArrayPublishes.push(args);
      return '';
    },
  });
  assert.equal(emptyArrayPublishes.length, 3);

  // Mismatched integrity fails explicitly instead of silently skipping.
  await assert.rejects(
    () =>
      publishNightlyNpm({
        directory: dir,
        version,
        tag: 'latest',
        runNpm(args) {
          if (args[0] === 'view' && args[1] === '@maka-agent/cli-linux-x64-gnu@0.3.0') {
            return JSON.stringify(['sha512-different']);
          }
          throw new Error('unexpected call: ' + args.join(' '));
        },
      }),
    /refusing to skip mismatched artifact/,
  );

  // Multi-entry view response fails explicitly instead of silently picking an entry.
  await assert.rejects(
    () =>
      publishNightlyNpm({
        directory: dir,
        version,
        tag: 'latest',
        runNpm(args) {
          if (args[0] === 'view' && args[1] === '@maka-agent/cli-linux-x64-gnu@0.3.0') {
            return JSON.stringify([platformIntegrity, platformIntegrity]);
          }
          throw new Error('unexpected call: ' + args.join(' '));
        },
      }),
    /Unexpected multi-entry npm view response/,
  );

  // Matching integrity with wrong dist-tag fails explicitly.
  await assert.rejects(
    () =>
      publishNightlyNpm({
        directory: dir,
        version,
        tag: 'latest',
        runNpm(args) {
          if (args[0] === 'view' && args[1] === '@maka-agent/cli-linux-x64-gnu@0.3.0') {
            return JSON.stringify([platformIntegrity]);
          }
          if (args[0] === 'view' && args[1] === '@maka-agent/cli-linux-x64-gnu') {
            return JSON.stringify([{ nightly: '0.3.0', latest: '0.2.0' }]);
          }
          throw new Error('unexpected call: ' + args.join(' '));
        },
      }),
    /dist-tag "latest" points to "0\.2\.0"/,
  );

  // Non-404 registry failures propagate instead of falling through to npm publish.
  await assert.rejects(
    () =>
      publishNightlyNpm({
        directory: dir,
        version,
        tag: 'latest',
        runNpm() {
          const err = new Error('registry unavailable');
          err.stderr = 'npm error code E503';
          throw err;
        },
      }),
    /registry unavailable/,
  );
});
