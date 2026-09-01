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

import { access, chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    debPath: join(
      releaseDirectory,
      target.payloads.find((name) => name.endsWith('.deb')),
    ),
    checksumSubjects: target.checksums.map((name) => join(releaseDirectory, name)),
  };
}

/**
 * Where fpm placed the application is discovered from the extracted tree rather
 * than derived from electron-builder's install prefix and product name. Deriving
 * what a payload should contain, instead of reading what it does, is exactly how
 * this verifier came to hand a checksum to a file it had never opened.
 */
async function debResourcesDirectory(root) {
  const suffix = join('resources', 'app.asar');
  const entries = await readdir(root, { recursive: true });
  const asar = entries.find((entry) => entry.endsWith(suffix));
  if (!asar) {
    throw new Error('The deb contains no resources/app.asar');
  }
  return join(root, dirname(asar));
}

/**
 * Both Linux distributables are verified here, and each is opened. They are
 * built by two separate electron-builder runs — the split is what keeps the
 * deb's `package-type` marker out of the AppImage — so nothing proven about one
 * carries over to the other. `--appimage-extract` is handled by the AppImage
 * runtime itself and needs no FUSE mount; `dpkg-deb` ships with the runner.
 */
export async function verifyLinuxRelease(
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
    throw new Error('Linux release verification requires Linux.');
  }

  const distributables = await linuxDistributables(arch, environment);
  const appImagePath = resolve(distributables.appImagePath);
  const debPath = resolve(distributables.debPath);
  await access(appImagePath);
  await access(debPath);
  const channel = environment.MAKA_DESKTOP_NIGHTLY_VERSION ? 'nightly' : 'release';
  const workingDirectory = await mkdtemp(join(tmpdir(), 'maka-release-verify-'));

  try {
    await chmod(appImagePath, 0o755);
    await run(appImagePath, ['--appimage-extract'], { cwd: workingDirectory });
    const appImageResources = join(workingDirectory, 'squashfs-root', 'resources');

    await assertPackagedResources(appImageResources, { requirePath, forbidPath });
    // The deb target writes this marker into the shared unpacked tree, and it is
    // what electron-updater reads to pick DebUpdater over AppImageUpdater. An
    // AppImage carrying it would try to update itself by installing a deb.
    await forbidPath(join(appImageResources, 'package-type'));
    await assertPackagedUpdateConfiguration(appImageResources, { channel });
    await assertPackagedDependencyClosure(appImageResources);

    const debRoot = join(workingDirectory, 'deb');
    await run('dpkg-deb', ['-x', debPath, debRoot]);
    const debResources = await debResourcesDirectory(debRoot);

    await assertPackagedResources(debResources, { requirePath, forbidPath });
    await assertPackagedUpdateConfiguration(debResources, { channel });
    await assertPackagedDependencyClosure(debResources);
    // The mirror of the AppImage assertion above. This marker is what sends the
    // packaged updater down DebUpdater, and the deb is the one payload that has
    // to carry it: without it an installed deb would try to update itself by
    // replacing an AppImage that is not there.
    const packageType = (await readFile(join(debResources, 'package-type'), 'utf8')).trim();
    if (packageType !== 'deb') {
      throw new Error(`The deb declares package-type ${packageType || '(empty)'}`);
    }
    // fpm records the architecture it was told to build; the descriptor names
    // the file after the architecture it asked for. A runner that produced the
    // wrong one would otherwise publish it under the right name.
    const namedArchitecture = /-([^-]+)\.deb$/u.exec(basename(debPath))?.[1];
    const { stdout } = await run('dpkg-deb', ['-f', debPath, 'Architecture']);
    if (stdout.trim() !== namedArchitecture) {
      throw new Error(`${basename(debPath)} contains architecture ${stdout.trim() || '(none)'}`);
    }

    // A formal release publishes a checksum beside each distributable, the way
    // the Windows verification does for its installer and archive. Each one is
    // issued only for a payload every assertion above has already accepted.
    const checksums = [];
    for (const path of distributables.checksumSubjects) {
      const sha256 = await checksum(path);
      const checksumPath = `${path}.sha256`;
      await writeFile(checksumPath, `${sha256}  ${basename(path)}\n`, 'utf8');
      checksums.push({ path, checksumPath, sha256 });
    }

    return { appImagePath, debPath, checksums };
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyLinuxRelease(process.argv[2] ?? process.arch);
  console.log(`Verified ${result.appImagePath}`);
  console.log(`Verified ${result.debPath}`);
  for (const { path, sha256 } of result.checksums) {
    console.log(`SHA-256 ${sha256}  ${basename(path)}`);
  }
}
