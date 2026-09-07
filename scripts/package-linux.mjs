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

import { spawn } from 'node:child_process';
import { access, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeDesktopUpdateFeeds } from './desktop-update-contract.mjs';
import { resolveDesktopReleaseTarget } from './desktop-nightly.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repoRoot, 'apps', 'desktop');
// electron is declared by apps/desktop, so resolve its install directory from
// there rather than assuming node_modules hoisted it to the repo root.
const require = createRequire(join(desktopRoot, 'package.json'));
const electronDistributionDirectory = join(
  dirname(require.resolve('electron/package.json')),
  'dist',
);
const requiredElectronLicensePaths = [
  join(electronDistributionDirectory, 'LICENSE'),
  join(electronDistributionDirectory, 'LICENSES.chromium.html'),
];

const linuxPackageArchitectures = Object.freeze(['x64', 'arm64']);

/** electron-builder names the unpacked staging directory after the target. */
function linuxUnpackedDirectoryName(arch) {
  return arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${
            signal ? `signal ${signal}` : `exit code ${code}`
          }`,
        ),
      );
    });
  });
}

export async function packageLinux({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  run = runCommand,
  remove = rm,
  move = rename,
  mergeFeeds = mergeDesktopUpdateFeeds,
  assertFile = access,
} = {}) {
  // The native Runtime Host peer is built for the host, so each architecture
  // ships from a runner of its own rather than cross-building both from one.
  if (platform !== 'linux' || !linuxPackageArchitectures.includes(arch)) {
    throw new Error(
      `Release packaging requires a Linux ${linuxPackageArchitectures.join(' or ')} host.`,
    );
  }

  const target = await resolveDesktopReleaseTarget(`linux-${arch}`, { environment: env });
  const appImagePath = target.payloadPath('.AppImage');
  const debPath = target.payloadPath('.deb');
  const updateMetadataPath = join(target.releaseDirectory, target.feed);
  // electron-builder rewrites the feed on every run rather than adding to it, so
  // the AppImage's copy is moved aside and merged back once the deb has run.
  const appImageMetadataPath = `${updateMetadataPath}.appimage`;

  for (const path of requiredElectronLicensePaths) {
    await assertFile(path);
  }

  await run('npm', ['run', 'clean']);
  await run('npm', ['run', 'build']);
  await run('npm', ['run', 'build:runtime-host-peer']);
  await run('npm', ['run', 'check:runtime-host-peer-notices']);
  await run('npm', ['run', 'check:release']);
  await remove(target.releaseDirectory, { recursive: true, force: true });
  // Both distributables come out of one unpacked tree, and the deb target writes
  // a `package-type` marker into it that makes electron-updater drive an install
  // through DebUpdater. Building the AppImage in a run of its own is what keeps
  // that marker out of the AppImage, which has to update itself in place.
  await run('npm', ['--workspace', '@maka/desktop', 'run', `package:linux-appimage-${arch}`]);
  await assertFile(appImagePath);
  await assertFile(updateMetadataPath);
  await move(updateMetadataPath, appImageMetadataPath);
  await run('npm', ['--workspace', '@maka/desktop', 'run', `package:linux-deb-${arch}`]);
  await assertFile(debPath);
  await assertFile(updateMetadataPath);
  await mergeFeeds({
    sourcePaths: [appImageMetadataPath, updateMetadataPath],
    outputPath: updateMetadataPath,
  });
  await remove(appImageMetadataPath, { force: true });
  await remove(join(target.releaseDirectory, linuxUnpackedDirectoryName(arch)), {
    recursive: true,
    force: true,
  });

  return { appImagePath, debPath, updateMetadataPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { appImagePath, debPath } = await packageLinux();
  console.log(`Created ${appImagePath}`);
  console.log(`Created ${debPath}`);
}
