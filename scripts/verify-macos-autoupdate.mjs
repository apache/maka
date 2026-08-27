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
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  assertPackagedUpdateConfiguration,
  feedServed,
  startDesktopUpdateFeed,
  verifyDesktopUpdateArtifacts,
} from './desktop-update-contract.mjs';
import {
  evaluateInRenderer,
  findRendererTarget,
  isolatedUserEnv,
  runCommand,
  smokePackagedRenderer,
  stopChild,
  waitForDevToolsPort,
  waitForUsableRenderer,
} from './verify-packaged-app.mjs';
import { compareProductReleaseVersions } from './release-version.mjs';

const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const step = (label) => console.log(`[verify-macos-autoupdate] ${label}`);
const { extractFile } = createRequire(import.meta.url)('@electron/asar');

function packagedManifest(appPath) {
  const archive = join(appPath, 'Contents', 'Resources', 'app.asar');
  return JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
}

async function readBundleVersion(appPath, run) {
  const { stdout } = await run('plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    '-o',
    '-',
    join(appPath, 'Contents', 'Info.plist'),
  ]);
  return stdout.trim();
}

async function signingRequirement(appPath, run) {
  const { stdout, stderr } = await run('codesign', ['-d', '-r-', appPath]);
  const requirement = `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith('designated =>'));
  if (!requirement) throw new Error(`Could not read the signing requirement from ${appPath}`);
  return requirement;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)).then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  if (!exited)
    throw new Error(`Candidate process ${child.pid} did not exit for the update handoff.`);
}

async function processIdsForExecutable(executable, run) {
  const { stdout } = await run('ps', ['-axo', 'pid=,command=']);
  return (
    stdout
      .split(/\r?\n/u)
      .map((line) => /^(\s*\d+)\s+(.+)$/u.exec(line))
      // Electron child processes reuse the app executable with extra arguments.
      // Only the argument-free command is the application Squirrel relaunched.
      .filter((match) => match?.[2] === executable)
      .map((match) => Number(match[1]))
  );
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function stopProcess(processId) {
  if (!processExists(processId)) return;
  process.kill(processId, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (processExists(processId) && Date.now() < deadline) await delay(100);
  if (!processExists(processId)) return;
  process.kill(processId, 'SIGKILL');
  while (processExists(processId) && Date.now() < deadline + 5_000) await delay(100);
  if (processExists(processId)) throw new Error(`Updated process ${processId} did not exit.`);
}

/** check → download → Squirrel.Mac replacement → automatic relaunch → smoke. */
export async function verifyMacosAutoupdate(
  candidateInput,
  nextDirectoryInput,
  {
    platform = process.platform,
    arch = process.arch,
    run = runCommand,
    makeTemporaryDirectory = () => mkdtemp(join(tmpdir(), 'maka-macos-autoupdate-')),
    smokeRenderer = smokePackagedRenderer,
  } = {},
) {
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error('macOS auto-update verification requires an Apple Silicon macOS host.');
  }
  if (!candidateInput || !nextDirectoryInput) {
    throw new Error(
      'Usage: npm run verify:macos-autoupdate -- <candidate-zip> <next-release-directory>',
    );
  }

  const candidateZip = resolve(candidateInput);
  const nextDirectory = resolve(nextDirectoryInput);
  await access(candidateZip);
  const metadata = parseYaml(await readFile(join(nextDirectory, 'latest-mac.yml'), 'utf8'));
  const nextVersion = metadata?.version;
  const nextZipName = metadata?.path;
  if (typeof nextVersion !== 'string' || typeof nextZipName !== 'string') {
    throw new Error(`latest-mac.yml in ${nextDirectory} has no update identity.`);
  }
  await verifyDesktopUpdateArtifacts({
    directory: nextDirectory,
    metadataName: 'latest-mac.yml',
    version: nextVersion,
    artifactName: nextZipName,
  });

  const temporaryDirectory = await makeTemporaryDirectory();
  const candidateRoot = join(temporaryDirectory, 'candidate');
  const nextRoot = join(temporaryDirectory, 'next');
  const candidateApp = join(candidateRoot, 'Maka.app');
  const nextApp = join(nextRoot, 'Maka.app');
  let executable = join(candidateApp, 'Contents', 'MacOS', 'Maka');
  let feed;
  let child;
  let relaunchedPid;
  let primaryError;

  try {
    await Promise.all([mkdir(candidateRoot), mkdir(nextRoot)]);
    step('extracting and verifying both signed application bundles');
    await run('ditto', ['-x', '-k', candidateZip, candidateRoot]);
    await run('ditto', ['-x', '-k', join(nextDirectory, nextZipName), nextRoot]);
    await Promise.all([
      run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', candidateApp]),
      run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', nextApp]),
      assertPackagedUpdateConfiguration(join(candidateApp, 'Contents', 'Resources')),
      assertPackagedUpdateConfiguration(join(nextApp, 'Contents', 'Resources')),
    ]);
    if (packagedManifest(candidateApp).makaUpdateTestProfile !== undefined) {
      throw new Error('The production candidate must not carry the update-test profile marker.');
    }
    if (packagedManifest(nextApp).makaUpdateTestProfile !== true) {
      throw new Error('The test successor must carry the isolated relaunch profile marker.');
    }
    // macOS reports /private/var in process commands even when mkdtemp handed
    // the harness /var. Compare the filesystem identity, not either spelling.
    executable = await realpath(executable);
    const [candidateRequirement, nextRequirement] = await Promise.all([
      signingRequirement(candidateApp, run),
      signingRequirement(nextApp, run),
    ]);
    if (candidateRequirement !== nextRequirement) {
      throw new Error('Candidate and next app do not have the same macOS signing identity.');
    }
    const candidateVersion = await readBundleVersion(candidateApp, run);
    if (compareProductReleaseVersions(nextVersion, candidateVersion) <= 0) {
      throw new Error(`The served version ${nextVersion} is not newer than ${candidateVersion}.`);
    }

    feed = await startDesktopUpdateFeed(
      new Map([
        ['latest-mac.yml', join(nextDirectory, 'latest-mac.yml')],
        [nextZipName, join(nextDirectory, nextZipName)],
        [`${nextZipName}.blockmap`, join(nextDirectory, `${nextZipName}.blockmap`)],
        [`${basename(candidateZip)}.blockmap`, `${candidateZip}.blockmap`],
      ]),
    );

    const home = join(temporaryDirectory, 'home');
    const userData = join(candidateRoot, '.maka-update-test-user-data');
    await Promise.all([mkdir(home), mkdir(userData)]);
    const childEnv = {
      ...process.env,
      ...isolatedUserEnv(home),
      MAKA_SKIP_SHELL_ENV: '1',
      MAKA_UPDATE_TEST_FEED: feed.url,
      MAKA_UPDATE_TEST_USER_DATA_DIR: userData,
    };
    delete childEnv.MAKA_UPDATE_MOCK_VERSION;
    delete childEnv.MAKA_UPDATE_MOCK_STATE;
    step(`launching candidate ${candidateVersion} against the loopback feed`);
    child = spawn(
      executable,
      ['--remote-debugging-port=0', `--user-data-dir=${userData}`, '--enable-logging=stderr'],
      { cwd: temporaryDirectory, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32_768);
    });
    const port = await waitForDevToolsPort(child);
    const target = await findRendererTarget(port, child);
    await waitForUsableRenderer(target.webSocketDebuggerUrl, child, {
      description: 'Candidate renderer',
    });

    step('driving the real update check and download');
    await evaluateInRenderer(target.webSocketDebuggerUrl, 'window.maka.app.checkForUpdates()', {
      awaitPromise: true,
      timeoutMs: 30_000,
    });
    const downloadDeadline = Date.now() + 180_000;
    let status;
    for (;;) {
      status = await evaluateInRenderer(
        target.webSocketDebuggerUrl,
        'window.maka.app.updateStatus()',
        { awaitPromise: true },
      );
      if (status?.state === 'error') {
        throw new Error(`Update ${status.operation ?? 'flow'} failed: ${status.message}`);
      }
      if (status?.state === 'downloaded') break;
      if (child.exitCode !== null) throw new Error(`Candidate exited during download.\n${stderr}`);
      if (Date.now() >= downloadDeadline) {
        throw new Error(`Update never reached downloaded: ${JSON.stringify(status)}\n${stderr}`);
      }
      await delay(500);
    }
    if (status.currentVersion !== candidateVersion || status.latestVersion !== nextVersion) {
      throw new Error(
        `Downloaded update reported ${status.currentVersion} -> ${status.latestVersion}, ` +
          `expected ${candidateVersion} -> ${nextVersion}.`,
      );
    }
    if (!feedServed(feed, 'latest-mac.yml') || !feedServed(feed, nextZipName)) {
      throw new Error(`The update did not use the loopback feed: ${JSON.stringify(feed.requests)}`);
    }
    if (feed.unexpectedCount() > 0) {
      throw new Error(`The app requested unexpected feed paths: ${JSON.stringify(feed.requests)}`);
    }

    step('handing off to Squirrel.Mac and waiting for automatic relaunch');
    try {
      const result = await evaluateInRenderer(
        target.webSocketDebuggerUrl,
        'window.maka.app.installUpdate({ allowInterruptActiveTasks: true })',
        { awaitPromise: true, timeoutMs: 30_000 },
      );
      if (result?.ok === false) throw new Error(`installUpdate refused: ${JSON.stringify(result)}`);
    } catch (error) {
      if (child.exitCode === null && !String(error.message).includes('WebSocket')) throw error;
    }
    await waitForExit(child, 60_000);

    const installDeadline = Date.now() + 180_000;
    let installedVersion;
    while (Date.now() < installDeadline) {
      try {
        installedVersion = await readBundleVersion(candidateApp, run);
        const pids = await processIdsForExecutable(executable, run);
        relaunchedPid = pids.find((pid) => pid !== child.pid);
        if (installedVersion === nextVersion && relaunchedPid) break;
      } catch {
        // Squirrel replaces the bundle through a short path-missing window.
      }
      await delay(500);
    }
    if (installedVersion !== nextVersion || !relaunchedPid) {
      throw new Error(
        `Squirrel.Mac did not replace and relaunch ${candidateVersion} as ${nextVersion}; ` +
          `installed=${installedVersion ?? 'unreadable'}, pid=${relaunchedPid ?? 'missing'}.`,
      );
    }
    await stopProcess(relaunchedPid);
    relaunchedPid = undefined;
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', candidateApp]);
    await smokeRenderer(executable, { workingDirectory: temporaryDirectory });
    step(`verified ${candidateVersion} -> ${nextVersion} replacement and relaunch`);
    return { candidateVersion, nextVersion, requests: feed.requests };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (child) await stopChild(child).catch((error) => cleanupErrors.push(error));
    if (relaunchedPid) await stopProcess(relaunchedPid).catch((error) => cleanupErrors.push(error));
    if (feed) await feed.close().catch((error) => cleanupErrors.push(error));
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5 }).catch((error) =>
      cleanupErrors.push(error),
    );
    if (!primaryError && cleanupErrors.length > 0) throw cleanupErrors[0];
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyMacosAutoupdate(process.argv[2], process.argv[3]);
}
