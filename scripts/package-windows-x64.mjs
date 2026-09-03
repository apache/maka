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
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDesktopReleaseTarget } from './desktop-nightly.mjs';
import { npmSpawnOptions } from './npm-spawn.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repoRoot, 'apps', 'desktop');
// electron is declared by apps/desktop, so resolve its install directory from
// there rather than assuming node_modules hoisted it to the repo root. This
// pre-flight guard exists to catch a missing electron dist before packaging;
// pinning it to the hoisted path would make it fail at the wrong location the
// moment an installer nests electron under apps/desktop.
const require = createRequire(join(desktopRoot, 'package.json'));
const electronDistributionDirectory = join(
  dirname(require.resolve('electron/package.json')),
  'dist',
);
const sandboxManifestPath = join(
  repoRoot,
  'experiments',
  'windows-sandbox',
  'launcher',
  'Cargo.toml',
);
const sandboxBinaryPath = join(
  repoRoot,
  'experiments',
  'windows-sandbox',
  'launcher',
  'target',
  'release',
  'maka-windows-sandbox.exe',
);
const sandboxResourceDirectory = join(desktopRoot, 'resources', 'windows-sandbox');
const sandboxResourcePath = join(sandboxResourceDirectory, 'maka-windows-sandbox.exe');
const requiredElectronLicensePaths = [
  join(electronDistributionDirectory, 'LICENSE'),
  join(electronDistributionDirectory, 'LICENSES.chromium.html'),
];

export function runCommand(
  command,
  args,
  { spawnProcess = spawn, platform = process.platform } = {},
) {
  return new Promise((resolve, reject) => {
    // Every command here is a repository constant, so the shell that Windows
    // needs to reach npm.cmd introduces no quoting concern.
    const child = spawnProcess(
      command,
      args,
      npmSpawnOptions({ cwd: repoRoot, env: process.env, stdio: 'inherit' }, platform),
    );
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

export async function packageWindowsX64({
  platform = process.platform,
  arch = process.arch,
  run = runCommand,
  env = process.env,
  remove = rm,
  assertFile = access,
  makeDirectory = mkdir,
  copy = copyFile,
} = {}) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error('Release packaging requires a Windows x64 host.');
  }

  const target = await resolveDesktopReleaseTarget('windows-x64', { environment: env });
  const exePath = target.payloadPath('.exe');
  const zipPath = target.payloadPath('.zip');
  const updateMetadataPath = join(target.releaseDirectory, target.feed);
  const unpackedDirectory = join(target.releaseDirectory, 'win-unpacked');

  for (const path of requiredElectronLicensePaths) {
    await assertFile(path);
  }

  await run('npm', ['run', 'clean']);
  await run('npm', ['run', 'build']);
  await run('npm', ['run', 'build:runtime-host-peer']);
  await run('npm', ['run', 'check:runtime-host-peer-notices']);
  await run('cargo', ['build', '--manifest-path', sandboxManifestPath, '--release', '--locked']);
  await run('npm', ['run', 'check:windows-cargo-notices']);
  await makeDirectory(sandboxResourceDirectory, { recursive: true });
  await copy(sandboxBinaryPath, sandboxResourcePath);
  await run('npm', ['run', 'check:release']);
  await remove(target.releaseDirectory, { recursive: true, force: true });
  await run('npm', ['--workspace', '@maka/desktop', 'run', 'package:windows-x64']);
  await assertFile(exePath);
  await assertFile(zipPath);
  await assertFile(updateMetadataPath);
  // win-unpacked stays: the ZIP is an archive of exactly this directory, so it
  // is what the verifier inspects. Extracting the ZIP would only rebuild a copy
  // of it, and writing tens of thousands of small files on Windows costs more
  // than the entire packaging step. It is not a release asset — the upload
  // globs match artifacts by name — and the release directory is rebuilt from
  // scratch on the next run.
  await assertFile(unpackedDirectory);

  return { exePath, zipPath, unpackedDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exePath } = await packageWindowsX64();
  console.log(`Created ${exePath}`);
}
