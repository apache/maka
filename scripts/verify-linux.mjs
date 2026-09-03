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

import { access, chmod, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDesktopReleaseTarget } from './desktop-nightly.mjs';
import {
  assertPackagedUpdateConfiguration,
  verifyDesktopUpdateArtifacts,
} from './desktop-update-contract.mjs';
import {
  assertMissing,
  assertPackagedDependencyClosure,
  assertPackagedResources,
  runCommand,
  sha256File,
  smokePackagedRenderer,
} from './verify-packaged-app.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * `e_machine`, at offset 18 of every ELF header. This is the one field that
 * says which processor the file was built for.
 */
const ELF_MACHINES = Object.freeze({ x64: 0x3e, arm64: 0xb7 });

/**
 * Debian policy allows only lowercase letters, digits and `-+.` in a package
 * name, and `dpkg` refuses to install one that breaks the rule. The name is
 * derived from the product name rather than configured, so nothing else in
 * this repository would notice a capital letter reaching it.
 */
const DEBIAN_PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]+$/u;

function runCommandFromRepo(command, args, options = {}) {
  return runCommand(command, args, { cwd: repoRoot, ...options });
}

/**
 * The packaging scripts refuse to cross-build because the Runtime Host peer is
 * a host binary, and a runner that shipped the other architecture's peer would
 * produce a package that installs and then fails at launch. Only reading the
 * ELF header proves which one is actually inside.
 */
export async function assertElfArchitecture(path, arch) {
  const handle = await open(path);
  let header;
  try {
    header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, 20, 0);
    if (bytesRead < 20 || header.toString('latin1', 0, 4) !== '\x7fELF') {
      throw new Error(`${basename(path)} is not an ELF binary`);
    }
  } finally {
    await handle.close();
  }
  // EI_DATA: every architecture this project builds is little-endian, and
  // reading `e_machine` the wrong way round would silently compare garbage.
  if (header[5] !== 1) {
    throw new Error(`${basename(path)} is not a little-endian ELF binary`);
  }
  const machine = header.readUInt16LE(18);
  if (machine !== ELF_MACHINES[arch]) {
    throw new Error(
      `${basename(path)} is built for ELF machine 0x${machine.toString(16)}, not ${arch}`,
    );
  }
}

/**
 * Where fpm placed the application is discovered from the extracted tree rather
 * than derived from electron-builder's install prefix and product name. Deriving
 * what a payload should contain, instead of reading what it does, is exactly how
 * this verifier came to hand a checksum to a file it had never opened. Exactly
 * one match is required: `find` would silently pick either of two.
 */
async function debResourcesDirectory(root) {
  const suffix = join('resources', 'app.asar');
  const entries = await readdir(root, { recursive: true });
  const matches = entries.filter((entry) => entry.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`The deb contains ${matches.length} resources/app.asar entries, expected 1`);
  }
  return join(root, dirname(matches[0]));
}

/**
 * Both Linux distributables are verified here, and each is opened. They are
 * built by two separate electron-builder runs — the split is what keeps the
 * deb's `package-type` marker out of the AppImage — so nothing proven about one
 * carries over to the other. `--appimage-extract` is handled by the AppImage
 * runtime itself and needs no FUSE mount; `dpkg-deb` ships with the runner.
 *
 * The renderer smoke test needs a display, so the caller runs this whole script
 * under `xvfb-run`. It is applied to the AppImage only: extracting it produces
 * the same tree its runtime mounts at launch, so running that tree is running
 * the artifact. A deb extracted with `dpkg-deb -x` is not an installation —
 * `dpkg` would still have to set the sandbox helper's setuid bit — so launching
 * it would prove something about a tree no user ever has.
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
    smokeRenderer = smokePackagedRenderer,
    assertArchitecture = assertElfArchitecture,
  } = {},
) {
  if (platform !== 'linux') {
    throw new Error('Linux release verification requires Linux.');
  }

  // The AppImage and the deb never share a spelling of the architecture, so the
  // target descriptor is the only place that knows both names.
  const target = await resolveDesktopReleaseTarget(`linux-${arch}`, { environment });
  const appImagePath = resolve(target.payloadPath('.AppImage'));
  const debPath = resolve(target.payloadPath('.deb'));
  await access(appImagePath);
  await access(debPath);
  // The descriptor already resolved and validated the channel when it resolved
  // the version; re-reading the environment here would let an unvalidated value
  // name one channel while the artifacts it just named came from the other.
  const channel = target.nightly ? 'nightly' : 'release';
  const workingDirectory = await mkdtemp(join(tmpdir(), 'maka-release-verify-'));
  const peerBinary = join('runtime-host-peer', 'maka_runtime_host_peer.node');

  try {
    await chmod(appImagePath, 0o755);
    await run(appImagePath, ['--appimage-extract'], { cwd: workingDirectory });
    const squashfsRoot = join(workingDirectory, 'squashfs-root');
    const appImageResources = join(squashfsRoot, 'resources');

    await assertPackagedResources(appImageResources, { requirePath, forbidPath });
    // The deb target writes this marker into the shared unpacked tree, and it is
    // what electron-updater reads to pick DebUpdater over AppImageUpdater. An
    // AppImage carrying it would try to update itself by installing a deb.
    await forbidPath(join(appImageResources, 'package-type'));
    await assertPackagedUpdateConfiguration(appImageResources, { channel });
    await assertPackagedDependencyClosure(appImageResources);
    await assertArchitecture(join(appImageResources, peerBinary), arch);

    const debRoot = join(workingDirectory, 'deb');
    await run('dpkg-deb', ['-x', debPath, debRoot]);
    const debResources = await debResourcesDirectory(debRoot);

    await assertPackagedResources(debResources, { requirePath, forbidPath });
    await assertPackagedUpdateConfiguration(debResources, { channel });
    await assertPackagedDependencyClosure(debResources);
    await assertArchitecture(join(debResources, peerBinary), arch);
    // The mirror of the AppImage assertion above. This marker is what sends the
    // packaged updater down DebUpdater, and the deb is the one payload that has
    // to carry it: without it an installed deb would try to update itself by
    // replacing an AppImage that is not there.
    const packageType = (await readFile(join(debResources, 'package-type'), 'utf8')).trim();
    if (packageType !== 'deb') {
      throw new Error(`The deb declares package-type ${packageType || '(empty)'}`);
    }
    // electron-builder builds this name out of the product name, so nothing
    // else here would catch a capital letter reaching `dpkg`, which rejects it.
    const { stdout: declaredName } = await run('dpkg-deb', ['-f', debPath, 'Package']);
    if (!DEBIAN_PACKAGE_NAME.test(declaredName.trim())) {
      throw new Error(`The deb declares an uninstallable package name: ${declaredName.trim()}`);
    }
    // fpm records the architecture it was told to build; the descriptor names
    // the file after the architecture it asked for. A runner that produced the
    // wrong one would otherwise publish it under the right name.
    const namedArchitecture = /-([^-]+)\.deb$/u.exec(basename(debPath))?.[1];
    const { stdout } = await run('dpkg-deb', ['-f', debPath, 'Architecture']);
    if (stdout.trim() !== namedArchitecture) {
      throw new Error(`${basename(debPath)} contains architecture ${stdout.trim() || '(none)'}`);
    }

    // Every assertion above reads files. This one runs the application, the way
    // the macOS and Windows verifications already do, and is the only thing here
    // that can fail on a package that is structurally perfect and still cannot
    // start — a missing shared library, or a sandbox the host will not grant.
    await requirePath(join(squashfsRoot, 'AppRun'));
    await smokeRenderer(join(squashfsRoot, 'AppRun'), { workingDirectory });

    // Linux is the one platform whose update feed this repository assembles
    // itself: `package:linux` runs electron-builder twice and merges the two
    // feeds, so the merged bytes are the only ones no build step ever wrote as
    // a whole. Reading them here, against the payloads just verified, is what
    // keeps a dropped entry or a stale digest from surviving until publication.
    await verifyDesktopUpdateArtifacts({
      directory: target.releaseDirectory,
      metadataName: target.feed,
      version: target.version,
      artifactNames: target.advertised,
    });

    // A formal release publishes a checksum beside each distributable, the way
    // the Windows verification does for its installer and archive. Each one is
    // issued only for a payload every assertion above has already accepted.
    const checksums = [];
    for (const path of target.checksumPaths()) {
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
