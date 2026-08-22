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
import { access, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repoRoot, 'apps', 'desktop');
const releaseDirectory = join(desktopRoot, 'release');
const electronDistributionDirectory = join(repoRoot, 'node_modules', 'electron', 'dist');
const requiredElectronLicensePaths = [
  join(electronDistributionDirectory, 'LICENSE'),
  join(electronDistributionDirectory, 'LICENSES.chromium.html'),
];
const requiredSigningEnvironment = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
];

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

export async function packageMacosArm64({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  run = runCommand,
  remove = rm,
  assertFile = access,
} = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error('Release packaging requires an Apple Silicon macOS host.');
  }

  for (const name of requiredSigningEnvironment) {
    if (!env[name]?.trim()) {
      throw new Error(`Release packaging requires ${name}.`);
    }
  }

  const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
  const dmgPath = join(releaseDirectory, `Maka-${manifest.version}-mac-arm64.dmg`);
  const zipPath = join(releaseDirectory, `Maka-${manifest.version}-mac-arm64.zip`);
  const updateMetadataPath = join(releaseDirectory, 'latest-mac.yml');

  for (const path of requiredElectronLicensePaths) {
    await assertFile(path);
  }

  await run('npm', ['run', 'clean']);
  await run('npm', ['run', 'build']);
  await run('npm', ['run', 'check:release']);
  await remove(releaseDirectory, { recursive: true, force: true });
  await run('npm', ['--workspace', '@maka/desktop', 'run', 'package:macos-arm64']);
  await assertFile(dmgPath);
  await assertFile(zipPath);
  await assertFile(updateMetadataPath);
  await remove(join(releaseDirectory, 'mac-arm64'), { recursive: true, force: true });

  return dmgPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dmgPath = await packageMacosArm64();
  console.log(`Created ${dmgPath}`);
}
