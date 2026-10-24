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

// Opt-in deployment gate, never part of startup or CI. Accepts no workspace path.
// Exit 2 = unavailable; exit 1 = probe/cleanup error; exit 0 = create/delete only.
// Even exit 0 DOES NOT qualify a production snapshot authority. Mounting, stable
// reads, signing/distribution, state alignment and crash recovery remain untested.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function classifyProbeResult(result, exitCode) {
  if (exitCode === 0 && result?.created === true && result?.deleted === true) {
    return 'create_delete_only_mount_and_distribution_unverified';
  }
  if (
    exitCode === 2 &&
    result?.created === false &&
    result?.deleteAttempted === false &&
    [1, 13, 45].includes(result?.createErrno)
  ) {
    return 'unavailable';
  }
  return 'probe_error';
}

function command(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`${file} failed: ${result.error?.message ?? result.stderr ?? result.signal}`);
  }
  return result.stdout;
}

async function main() {
  if (process.argv.slice(2).length !== 0) {
    throw new Error('No arguments accepted. The probe creates its own disposable test volume.');
  }
  if (process.platform !== 'darwin') {
    console.log(JSON.stringify({ status: 'unavailable', reason: 'macOS required' }));
    process.exitCode = 2;
    return;
  }
  if (process.getuid() === 0 || process.geteuid() === 0) {
    throw new Error('Do not run this development probe as root or through sudo.');
  }

  const root = await mkdtemp(join(await realpath(tmpdir()), 'maka-checkpoint-capability-'));
  const live = join(root, 'live');
  const image = join(root, 'probe.sparseimage');
  const binary = join(root, 'probe');
  // Report ownership before any external operation. If interrupted, retain this
  // exact path for manual diagnosis; never use a broad unmount or forced detach.
  console.error(`Disposable probe directory: ${root}`);
  let attachAttempted = false;
  let report;
  try {
    command('/usr/bin/xcrun', [
      'clang',
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-framework',
      'Security',
      '-framework',
      'CoreFoundation',
      fileURLToPath(new URL('./macos-checkpoint-capability-probe.c', import.meta.url)),
      '-o',
      binary,
    ]);
    // Read the actual signature, rather than adding an entitlement or changing
    // the user's signing configuration to make the probe pass.
    const signature = command('/usr/bin/codesign', ['-d', '--entitlements', ':-', binary]);
    await mkdir(live);
    command('/usr/bin/hdiutil', [
      'create',
      '-size',
      '128m',
      '-fs',
      'APFS',
      '-volname',
      'MakaCheckpointProbe',
      '-type',
      'SPARSE',
      '-o',
      image,
    ]);
    attachAttempted = true;
    command('/usr/bin/hdiutil', [
      'attach',
      '-nobrowse',
      '-owners',
      'on',
      '-mountpoint',
      live,
      image,
    ]);
    const native = spawnSync(binary, [live], { encoding: 'utf8', timeout: 15_000 });
    if (native.error || native.signal) throw native.error ?? new Error(native.signal);
    const result = JSON.parse(native.stdout);
    const status = classifyProbeResult(result, native.status);
    report = {
      status,
      productionAuthorityReady: false,
      signatureHasSnapshotEntitlement:
        /com\.apple\.(developer\.vfs|private\.vfs|private\.apfs\.arv\.limited)\.snapshot/.test(
          signature,
        ),
      result,
      nativeExitCode: native.status,
      temporaryDirectory: root,
    };
    process.exitCode = status === 'unavailable' ? 2 : status === 'probe_error' ? 1 : 0;
  } finally {
    try {
      if (attachAttempted) command('/usr/bin/hdiutil', ['detach', live]);
      // Non-recursive removal only, after successful detach. A failed attach or
      // busy mount leaves the directory/image for diagnosis instead of guessing.
      await rmdir(live).catch(ignoreMissing);
      await unlink(image).catch(ignoreMissing);
      await unlink(binary).catch(ignoreMissing);
      await rmdir(root);
      if (report) report.temporaryResourcesRemoved = true;
    } catch (error) {
      process.exitCode = 1;
      if (report) {
        report.status = 'probe_error';
        report.temporaryResourcesRemoved = false;
        report.cleanupError = error.message;
      }
      console.error(`Cleanup failed; inspect only ${root}: ${error.message}`);
    }
    if (report) console.log(JSON.stringify(report, null, 2));
  }
}

function ignoreMissing(error) {
  if (error.code !== 'ENOENT') throw error;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
