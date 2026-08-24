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
import { access, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { npmSpawnOptions } from './npm-spawn.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repoRoot, 'apps', 'desktop');
const releaseDirectory = join(desktopRoot, 'release');
const electronDistributionDirectory = join(repoRoot, 'node_modules', 'electron', 'dist');
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
  remove = rm,
  assertFile = access,
} = {}) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error('Release packaging requires a Windows x64 host.');
  }

  const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
  const exePath = join(releaseDirectory, `Maka-${manifest.version}-win-x64.exe`);
  const zipPath = join(releaseDirectory, `Maka-${manifest.version}-win-x64.zip`);
  const updateMetadataPath = join(releaseDirectory, 'latest.yml');
  const unpackedDirectory = join(releaseDirectory, 'win-unpacked');

  for (const path of requiredElectronLicensePaths) {
    await assertFile(path);
  }

  await run('npm', ['run', 'clean']);
  await run('npm', ['run', 'build']);
  await run('cargo', ['build', '--manifest-path', sandboxManifestPath, '--release', '--locked']);
  await run('npm', ['run', 'check:windows-cargo-notices']);
  await mkdir(sandboxResourceDirectory, { recursive: true });
  await copyFile(sandboxBinaryPath, sandboxResourcePath);
  await run('npm', ['run', 'check:release']);
  await remove(releaseDirectory, { recursive: true, force: true });
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
