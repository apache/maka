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

import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDesktopBuildVersion } from './desktop-nightly.mjs';
import { desktopReleaseTargets } from './desktop-release-targets.mjs';
import { assertPackagedUpdateConfiguration } from './desktop-update-contract.mjs';
import {
  assertMissing,
  assertPackagedDependencyClosure,
  assertPackagedResources,
  runCommand,
  sha256File,
} from './verify-packaged-app.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDirectory = join(repoRoot, 'apps', 'desktop', 'release');

function runCommandFromRepo(command, args, options = {}) {
  return runCommand(command, args, { cwd: repoRoot, ...options });
}

/**
 * The AppImage and the deb never share a spelling of the architecture, so the
 * target descriptor is the only place that knows both names.
 */
async function linuxDistributables(arch, environment) {
  const manifest = JSON.parse(
    await readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
  );
  const version = resolveDesktopBuildVersion(manifest.version, environment);
  const target = desktopReleaseTargets(version, { nightly: version !== manifest.version }).find(
    (entry) => entry.name === `linux-${arch}`,
  );
  if (!target) {
    throw new Error('Usage: npm run verify:linux -- <x64|arm64>');
  }
  return {
    appImagePath: join(
      releaseDirectory,
      target.payloads.find((name) => name.endsWith('.AppImage')),
    ),
    checksumSubjects: target.checksums.map((name) => join(releaseDirectory, name)),
  };
}

/**
 * The AppImage and the deb are produced from one unpacked tree, so proving the
 * contract on the AppImage proves it for both. `--appimage-extract` is handled
 * by the AppImage runtime itself and needs no FUSE mount.
 */
export async function verifyLinuxAppImage(
  arch,
  {
    platform = process.platform,
    run = runCommandFromRepo,
    requirePath = access,
    forbidPath = assertMissing,
    environment = process.env,
    checksum = sha256File,
  } = {},
) {
  if (platform !== 'linux') {
    throw new Error('AppImage verification requires Linux.');
  }

  const { appImagePath: appImage, checksumSubjects } = await linuxDistributables(arch, environment);
  const appImagePath = resolve(appImage);
  await access(appImagePath);
  const workingDirectory = await mkdtemp(join(tmpdir(), 'maka-release-verify-'));

  try {
    await chmod(appImagePath, 0o755);
    await run(appImagePath, ['--appimage-extract'], { cwd: workingDirectory });
    const resources = join(workingDirectory, 'squashfs-root', 'resources');

    await assertPackagedResources(resources, { requirePath, forbidPath });
    // The deb target writes this marker into the shared unpacked tree, and it is
    // what electron-updater reads to pick DebUpdater over AppImageUpdater. An
    // AppImage carrying it would try to update itself by installing a deb.
    await forbidPath(join(resources, 'package-type'));
    await assertPackagedUpdateConfiguration(resources, {
      channel: environment.MAKA_DESKTOP_NIGHTLY_VERSION ? 'nightly' : 'release',
    });
    await assertPackagedDependencyClosure(resources);

    // A formal release publishes a checksum beside each distributable, the way
    // the Windows verification does for its installer and archive.
    const checksums = [];
    for (const path of checksumSubjects) {
      const sha256 = await checksum(path);
      const checksumPath = `${path}.sha256`;
      await writeFile(checksumPath, `${sha256}  ${basename(path)}\n`, 'utf8');
      checksums.push({ path, checksumPath, sha256 });
    }

    return { appImagePath, checksums };
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyLinuxAppImage(process.argv[2] ?? process.arch);
  console.log(`Verified ${result.appImagePath}`);
  for (const { path, sha256 } of result.checksums) {
    console.log(`SHA-256 ${sha256}  ${basename(path)}`);
  }
}
