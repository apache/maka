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
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  evaluateInRenderer,
  findRendererTarget,
  isolatedUserEnv,
  waitForDevToolsPort,
  waitForUsableRenderer,
  runCommand,
  stopChild,
} from './verify-packaged-app.mjs';
import {
  completeInstalledApplicationUninstall,
  installerVersion,
  readUninstallDisplayVersions,
  terminateInstalledProcesses,
  waitForInstalledProcessAppearance,
  waitForInstalledProcessesToExit,
} from './verify-windows-installer-lifecycle.mjs';
import {
  assertWindowsProductVersion,
  powerShellLiteral,
  verifyPackagedWindowsApp,
} from './verify-windows-x64.mjs';

const uninstallExecutableName = 'Uninstall Maka.exe';
const executableName = 'Maka.exe';

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function step(label) {
  console.log(`[verify-windows-autoupdate] ${label}`);
}

function compareStableVersions(left, right) {
  const parse = (value) => value.split('.').map(Number);
  const [lMaj, lMin, lPat] = parse(left);
  const [rMaj, rMin, rPat] = parse(right);
  if (lMaj !== rMaj) return lMaj - rMaj;
  if (lMin !== rMin) return lMin - rMin;
  return lPat - rPat;
}

/**
 * Loopback static file server for the update feed. Serves exactly the mapped
 * root-level paths (`/latest.yml`, `/<installer>`, …) — the *full* request
 * path is matched, so a nested `/x/latest.yml` counts as unexpected; a wrong
 * updater request shape must surface, not be absorbed. A mapped path whose
 * file is absent 404s without counting: the updater legitimately probes the
 * *previous* version's blockmap for a differential download and falls back to
 * the full installer when the feed does not have it. Bodies are read once at
 * startup — electron-updater issues many ranged requests against the
 * multi-hundred-megabyte installer, and re-reading it per request could push
 * the download stage past its deadline. Supports single-range GETs because
 * differential downloads use ranged requests.
 */
async function startFeedServer(files) {
  const requests = [];
  let unexpectedRequests = 0;
  const bodies = new Map();
  for (const [name, filePath] of files) {
    try {
      bodies.set(`/${name}`, await readFile(filePath));
    } catch {
      // Mapped but absent (the previous blockmap): served as an expected 404.
    }
  }
  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    // The raw path segment is matched without decoding, so `/%6catest.yml`
    // cannot alias `/latest.yml`. The query is allowed and recorded, not
    // matched: electron-updater cache-busts its channel request with
    // `?noCache=<id>`, so rejecting queries rejects the updater's own
    // documented request shape (the first live run proved exactly that).
    const target = request.url ?? '/';
    const queryIndex = target.indexOf('?');
    const pathName = queryIndex === -1 ? target : target.slice(0, queryIndex);
    const record = { method, path: pathName, target, status: 0 };
    requests.push(record);
    const known = [...files.keys()].some((name) => `/${name}` === pathName);
    if ((method !== 'GET' && method !== 'HEAD') || !known) {
      unexpectedRequests += 1;
      record.status = 404;
      response.writeHead(404).end();
      return;
    }
    const body = bodies.get(pathName);
    if (body === undefined) {
      // Known path, absent file: the expected 404 shape (previous blockmap).
      record.status = 404;
      response.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1);
      if (start > end || start >= body.length) {
        record.status = 416;
        response.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
        return;
      }
      record.status = 206;
      response.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      response.end(method === 'HEAD' ? undefined : body.subarray(start, end + 1));
      return;
    }
    record.status = 200;
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length,
      'Accept-Ranges': 'bytes',
    });
    response.end(method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not start the loopback update feed.');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    unexpectedCount: () => unexpectedRequests,
    close: () =>
      new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections?.();
      }),
  };
}

export async function waitForInstalledProductVersion(
  executablePath,
  {
    run = runCommand,
    timeoutMs = 60_000,
    probeTimeoutMs = 10_000,
    pollIntervalMs = 1_000,
    sleep = delay,
  } = {},
) {
  const script = `(Get-Item ${powerShellLiteral(executablePath)}).VersionInfo.ProductVersion`;
  const deadline = Date.now() + timeoutMs;
  let lastProbeError;
  for (;;) {
    try {
      const { stdout } = await run(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeoutMs: Math.max(1, Math.min(probeTimeoutMs, deadline - Date.now())) },
      );
      return stdout;
    } catch (error) {
      lastProbeError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Could not read the installed ProductVersion within ${timeoutMs}ms: ${lastProbeError.message}`,
        { cause: lastProbeError },
      );
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * End-to-end Windows automatic-update verification.
 *
 * Installs the candidate build, points its packaged updater at a loopback feed
 * serving a version-bumped installer, and asserts the complete in-app path:
 * check → background download (feed request log) → `downloaded` status →
 * `installUpdate` handoff → old process exit → NSIS upgrade → automatic
 * relaunch as the new version → full packaged smoke of the upgraded install →
 * silent uninstall. Every stage has its own deadline and named failure; the
 * overall shape fails closed rather than reporting a partial success.
 */
export async function verifyWindowsAutoupdate(
  candidateInputPath,
  nextDirectoryInput,
  {
    platform = process.platform,
    makeTemporaryDirectory = () => mkdtemp(join(tmpdir(), 'maka-autoupdate-')),
    run = runCommand,
  } = {},
) {
  if (platform !== 'win32') {
    throw new Error('Windows auto-update verification requires Windows.');
  }
  if (!candidateInputPath || !nextDirectoryInput) {
    throw new Error(
      'Usage: npm run verify:windows-autoupdate -- <candidate-exe> <next-release-directory>',
    );
  }

  const candidateInstaller = resolve(candidateInputPath);
  const nextDirectory = resolve(nextDirectoryInput);
  const candidateVersion = installerVersion(candidateInstaller);
  await access(candidateInstaller);
  const latestYml = await readFile(join(nextDirectory, 'latest.yml'), 'utf8');
  const nextVersion = /^version:\s*(.+)\s*$/m.exec(latestYml)?.[1]?.trim();
  if (!nextVersion) {
    throw new Error(`latest.yml in ${nextDirectory} does not advertise a version.`);
  }
  if (compareStableVersions(nextVersion, candidateVersion) <= 0) {
    throw new Error(
      `The served version ${nextVersion} must be newer than the candidate ${candidateVersion}.`,
    );
  }
  const nextInstallerName = `Maka-${nextVersion}-win-x64.exe`;
  installerVersion(join(nextDirectory, nextInstallerName));
  await access(join(nextDirectory, nextInstallerName));
  await access(join(nextDirectory, `${nextInstallerName}.blockmap`));

  const temporaryDirectory = await makeTemporaryDirectory();
  const installDirectory = join(temporaryDirectory, 'installed');
  const uninstaller = join(installDirectory, uninstallExecutableName);
  const installedExecutable = join(installDirectory, executableName);
  let installationStarted = false;
  let uninstallCompleted = false;
  let feed;
  let child;
  let primaryError;

  try {
    step('starting the loopback update feed');
    // The candidate's own blockmap is served too, exactly as a GitHub release
    // hosts the previous version's assets: the updater requests it to attempt
    // a differential download. If the file is missing next to the candidate
    // installer, the mapped-but-absent 404 makes the updater fall back to the
    // full download — both are valid production shapes.
    feed = await startFeedServer(
      new Map([
        ['latest.yml', join(nextDirectory, 'latest.yml')],
        [nextInstallerName, join(nextDirectory, nextInstallerName)],
        [`${nextInstallerName}.blockmap`, join(nextDirectory, `${nextInstallerName}.blockmap`)],
        [`${basename(candidateInstaller)}.blockmap`, `${candidateInstaller}.blockmap`],
      ]),
    );

    step(`installing candidate ${candidateVersion} into ${installDirectory}`);
    installationStarted = true;
    await run(candidateInstaller, ['/S', `/D=${installDirectory}`], { timeoutMs: 120_000 });
    await access(uninstaller);

    step('launching the installed candidate against the loopback feed');
    const home = join(temporaryDirectory, 'home');
    const userData = join(temporaryDirectory, 'user-data');
    const userEnv = isolatedUserEnv(home);
    await mkdir(home, { recursive: true });
    await mkdir(userData, { recursive: true });
    await mkdir(userEnv.APPDATA, { recursive: true });
    await mkdir(userEnv.LOCALAPPDATA, { recursive: true });
    const childEnv = {
      ...process.env,
      MAKA_SKIP_SHELL_ENV: '1',
      ...userEnv,
      MAKA_UPDATE_TEST_FEED: feed.url,
    };
    // The mocks short-circuit before the real updater; leaking them from the
    // caller's environment would turn this into a fixture test.
    delete childEnv.MAKA_UPDATE_MOCK_VERSION;
    delete childEnv.MAKA_UPDATE_MOCK_STATE;
    child = spawn(
      installedExecutable,
      ['--remote-debugging-port=0', `--user-data-dir=${userData}`, '--enable-logging=stderr'],
      { cwd: temporaryDirectory, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });

    const cdpPort = await waitForDevToolsPort(child);
    // On a CDP attach failure the app's own stderr tail is the only evidence
    // of what the packaged process was doing (renderer crash, GPU fallback,
    // profile lock); the bare "fetch failed" without it has already burned
    // full CI cycles on this exact stage.
    const target = await findRendererTarget(cdpPort, child).catch((error) => {
      throw new Error(
        `${error.message}${stderr.trim() ? `\napp stderr tail:\n${stderr.trim()}` : ''}`,
        { cause: error },
      );
    });
    await waitForUsableRenderer(target.webSocketDebuggerUrl, child, {
      description: 'Candidate renderer',
    }).catch((error) => {
      throw new Error(`${error.message}${stderr.trim() ? `\n${stderr.trim()}` : ''}`, {
        cause: error,
      });
    });

    step('driving an update check through the renderer bridge');
    await evaluateInRenderer(target.webSocketDebuggerUrl, 'window.maka.app.checkForUpdates()', {
      awaitPromise: true,
      timeoutMs: 30_000,
    });

    step('waiting for the update to reach the downloaded state');
    const downloadDeadline = Date.now() + 180_000;
    let status;
    for (;;) {
      status = await evaluateInRenderer(
        target.webSocketDebuggerUrl,
        'window.maka.app.updateStatus()',
        {
          awaitPromise: true,
        },
      );
      if (status?.state === 'error') {
        throw new Error(
          `Update ${status.operation ?? 'flow'} failed: ${status.message ?? '<no message>'}`,
        );
      }
      if (status?.state === 'downloaded') break;
      if (child.exitCode !== null) {
        throw new Error(`Candidate exited while downloading the update.\n${stderr.trim()}`);
      }
      if (Date.now() >= downloadDeadline) {
        throw new Error(`Update never reached 'downloaded': ${JSON.stringify(status)}`);
      }
      await delay(500);
    }
    if (status.currentVersion !== candidateVersion || status.latestVersion !== nextVersion) {
      throw new Error(
        `Downloaded update advertises ${status.currentVersion} -> ${status.latestVersion}, ` +
          `expected ${candidateVersion} -> ${nextVersion}.`,
      );
    }

    step('asserting the download really came from the loopback feed');
    // Exact root-level paths, matching the server's own allowlist shape.
    const served = (name) =>
      feed.requests.some(
        (request) =>
          request.method === 'GET' &&
          request.path === `/${name}` &&
          (request.status === 200 || request.status === 206),
      );
    if (!served('latest.yml')) {
      throw new Error(
        `The app never fetched latest.yml from the loopback feed: ${JSON.stringify(feed.requests)}`,
      );
    }
    if (!served(nextInstallerName)) {
      throw new Error(
        `The app never downloaded the installer from the loopback feed: ${JSON.stringify(feed.requests)}`,
      );
    }
    // The differential probe is a deterministic part of the flow: the updater
    // asks for the running version's blockmap before deciding between a
    // differential and a full download. Both outcomes are valid production
    // shapes; the probe itself must have happened. The mode is reported from
    // the installer transfer responses themselves — a served previous blockmap
    // alone proves nothing about which download the updater then performed.
    const oldBlockmapProbe = feed.requests.find(
      (request) => request.path === `/${basename(candidateInstaller)}.blockmap`,
    );
    if (!oldBlockmapProbe) {
      throw new Error(
        `The updater never probed the previous blockmap for a differential download: ${JSON.stringify(feed.requests)}`,
      );
    }
    const installerResponses = feed.requests
      .filter((request) => request.method === 'GET' && request.path === `/${nextInstallerName}`)
      .map((request) => request.status);
    step(
      `installer transfer observed: previous blockmap ${oldBlockmapProbe.status}, ` +
        `installer responses [${installerResponses.join(', ')}] ` +
        `(${installerResponses.includes(206) ? 'ranged/differential transfer' : 'single full download'})`,
    );
    if (feed.unexpectedCount() > 0) {
      throw new Error(`The app requested unexpected feed paths: ${JSON.stringify(feed.requests)}`);
    }

    step('handing off to the installer via installUpdate');
    let installResult;
    try {
      installResult = await evaluateInRenderer(
        target.webSocketDebuggerUrl,
        'window.maka.app.installUpdate({ allowInterruptActiveTasks: true })',
        { awaitPromise: true, timeoutMs: 30_000 },
      );
    } catch (error) {
      // The evaluation races the app quitting for the installer handoff; a
      // dropped socket here is the expected shape of success. A structured
      // failure is not.
      installResult = { racedAppExit: true, message: error.message };
    }
    if (installResult && installResult.ok === false) {
      throw new Error(`installUpdate refused: ${JSON.stringify(installResult)}`);
    }

    step('waiting for the candidate process to exit for the installer');
    await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Candidate did not exit for the installer within 60s.')),
        60_000,
      );
      if (child.exitCode !== null) {
        clearTimeout(timeout);
        resolvePromise();
        return;
      }
      child.once('exit', () => {
        clearTimeout(timeout);
        resolvePromise();
      });
    });

    step('waiting for the upgraded app to relaunch automatically');
    const relaunched = await waitForInstalledProcessAppearance(installDirectory, executableName, {
      timeoutMs: 120_000,
    });
    const productVersion = await waitForInstalledProductVersion(installedExecutable, { run });
    try {
      assertWindowsProductVersion(productVersion, nextVersion);
    } catch (error) {
      // Nondeterministic CI state observed once: a Maka.exe process is
      // running from the install directory while the on-disk executable is
      // still the previous version. The only code path in the NSIS template
      // that launches the app is StartApp at full Section success, which
      // contradicts old bytes on disk — so on mismatch, capture the raw
      // state needed to attribute the launch and the transaction stage:
      // each process's command line (StartApp passes `--updated`), the
      // pre-upgrade backup directory (exists ⇒ the upgrade quit between
      // customInit and customInstall), the uninstall registration, and the
      // executable timestamps (rewritten ⇒ extraction ran).
      const evidence = [`relaunched processes: ${JSON.stringify(relaunched)}`];
      try {
        const commandLines = await run(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Get-CimInstance Win32_Process -Filter "Name='${executableName}'" | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`,
          ],
          // Bounded: this probe runs on a machine already in a wedged state,
          // and an evidence collector that hangs destroys the evidence — the
          // catch below keeps a timeout from aborting the rest of the capture.
          { timeoutMs: 30_000 },
        );
        evidence.push(`process command lines: ${commandLines.stdout.trim() || '<none>'}`);
      } catch (processError) {
        evidence.push(`process command lines unavailable: ${processError.message}`);
      }
      const backupDirectory = `${installDirectory}.pre-upgrade-backup`;
      evidence.push(
        `backup directory ${backupDirectory}: ${existsSync(backupDirectory) ? 'present' : 'absent'}`,
      );
      try {
        const registrations = await readUninstallDisplayVersions({ run });
        evidence.push(`uninstall registrations: ${JSON.stringify(registrations)}`);
      } catch (registryError) {
        evidence.push(`uninstall registrations unavailable: ${registryError.message}`);
      }
      for (const name of [executableName, uninstallExecutableName]) {
        const filePath = join(installDirectory, name);
        try {
          const fileStat = await stat(filePath);
          evidence.push(`${name}: mtime ${fileStat.mtime.toISOString()}, ${fileStat.size} bytes`);
        } catch (statError) {
          evidence.push(`${name}: ${statError.code ?? statError.message}`);
        }
      }
      throw new Error(`${error.message}\n${evidence.join('\n')}`, { cause: error });
    }

    step('stopping the relaunched instance');
    // isForceRunAfter relaunches without our CDP/user-data arguments, so the
    // instance is observed (it exists, and the image on disk is the new
    // version) and then stopped before it can touch further state; the
    // environment it inherited still points at the isolated home. The
    // tolerant kill-then-prove policy lives in terminateInstalledProcesses,
    // shared with the cleanup path below.
    await terminateInstalledProcesses(installDirectory, { run });

    step('running the full packaged smoke against the upgraded install');
    // The sandbox probe writes its manifest into workingDirectory before the
    // renderer smoke would have created any subdirectories, so the directory
    // must exist first.
    const smokeDirectory = join(temporaryDirectory, 'smoke');
    await mkdir(smokeDirectory, { recursive: true });
    const upgradedStatusExpression = 'window.maka.app.updateStatus()';
    await verifyPackagedWindowsApp(installDirectory, {
      workingDirectory: smokeDirectory,
      expectedVersion: nextVersion,
      smokeRenderer: async (executable, { workingDirectory }) => {
        const smokeHome = join(workingDirectory, 'home');
        const smokeUserData = join(workingDirectory, 'user-data');
        const smokeEnv = isolatedUserEnv(smokeHome);
        await mkdir(smokeHome, { recursive: true });
        await mkdir(smokeUserData, { recursive: true });
        await mkdir(smokeEnv.APPDATA, { recursive: true });
        await mkdir(smokeEnv.LOCALAPPDATA, { recursive: true });
        const smokeChild = spawn(
          executable,
          [
            '--remote-debugging-port=0',
            `--user-data-dir=${smokeUserData}`,
            '--enable-logging=stderr',
          ],
          {
            cwd: workingDirectory,
            env: { ...process.env, MAKA_SKIP_SHELL_ENV: '1', ...smokeEnv },
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        );
        smokeChild.stderr.setEncoding('utf8');
        // A persistent collector, like every sibling smoke: without one the
        // piped stream pauses once waitForDevToolsPort removes its listener,
        // Chromium's stderr logging can fill the pipe and block the child,
        // and the failure evidence this capture exists for is lost.
        let smokeStderr = '';
        smokeChild.stderr.on('data', (chunk) => {
          smokeStderr = `${smokeStderr}${chunk}`.slice(-16_384);
        });
        try {
          const smokePort = await waitForDevToolsPort(smokeChild);
          const smokeTarget = await findRendererTarget(smokePort, smokeChild);
          await waitForUsableRenderer(smokeTarget.webSocketDebuggerUrl, smokeChild, {
            description: 'Upgraded renderer',
          }).catch((error) => {
            throw new Error(
              `${error.message}${smokeStderr.trim() ? `\n${smokeStderr.trim()}` : ''}`,
              { cause: error },
            );
          });
          const upgradedStatus = await evaluateInRenderer(
            smokeTarget.webSocketDebuggerUrl,
            upgradedStatusExpression,
            { awaitPromise: true },
          );
          if (upgradedStatus?.currentVersion !== nextVersion) {
            throw new Error(
              `Upgraded app reports version ${upgradedStatus?.currentVersion}, expected ${nextVersion}.`,
            );
          }
        } finally {
          await stopChild(smokeChild);
        }
      },
    });
    await waitForInstalledProcessesToExit(installDirectory);

    step('uninstalling the upgraded application');
    // Files gone is not uninstall over: the detached uninstaller deletes the
    // uninstall registry keys as its last action, tens of seconds later on a
    // busy runner. Declaring success on files alone let the next verify step
    // install inside that window and lose its fresh registration to this
    // step's stale uninstaller (see waitForUninstallRegistrationToClear).
    await completeInstalledApplicationUninstall(installDirectory, uninstaller, { run });
    uninstallCompleted = true;
    step(`verified automatic update ${candidateVersion} -> ${nextVersion}`);
    return { candidateVersion, nextVersion, installDirectory };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (child) {
      try {
        await stopChild(child);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (feed) {
      try {
        await feed.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (installationStarted && !uninstallCompleted) {
      let exited = false;
      try {
        // Same stop-and-prove policy as the main path: a stale-PID exit 128
        // from cleanup's own taskkill (run 32378497920) must not skip the
        // authoritative exit wait and the uninstall/registration barrier.
        await terminateInstalledProcesses(installDirectory, { run });
        exited = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (exited) {
        try {
          await completeInstalledApplicationUninstall(installDirectory, uninstaller, { run });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    try {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      const cleanupFailure = new AggregateError(
        cleanupErrors,
        'Auto-update verifier cleanup failed.',
      );
      if (!primaryError) throw cleanupFailure;
      if (primaryError instanceof Error && primaryError.cause === undefined) {
        primaryError.cause = cleanupFailure;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyWindowsAutoupdate(process.argv[2], process.argv[3]);
  console.log(`Verified automatic update ${result.candidateVersion} -> ${result.nextVersion}`);
}
