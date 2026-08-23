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
import { access, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  diffTreeManifests,
  directoryTreeManifest,
  findRendererTarget,
  isolatedUserEnv,
  waitForDevToolsPort,
  waitForUsableRenderer,
  runCommand,
  stopChild,
} from './verify-packaged-app.mjs';
import {
  installerVersion,
  waitForInstalledProcessesToExit,
  waitForUninstallRegistrationToClear,
  waitUntilMissing,
} from './verify-windows-installer-lifecycle.mjs';
import { assertWindowsProductVersion, powerShellLiteral } from './verify-windows-x64.mjs';

const uninstallExecutableName = 'Uninstall Maka.exe';
const executableName = 'Maka.exe';
// Exit-code and naming contract with apps/desktop/build/installer.nsh — keep
// in sync.
const exitBackupFailed = 101;
const exitRollbackCompleted = 102;
const exitRollbackFailed = 103;
const backupSuffix = '.pre-upgrade-backup';
const backupMarkerName = '.maka-backup-complete';

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function step(label) {
  console.log(`[verify-windows-installer-rollback] ${label}`);
}

/**
 * Runs a command whose exit code is the assertion, so unlike the shared
 * `runCommand` a non-zero exit resolves instead of rejecting.
 */
function runExpectingExit(command, args, { env, timeoutMs } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: env ?? process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    const deadline =
      timeoutMs === undefined
        ? null
        : setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${command} did not finish within ${timeoutMs}ms`));
          }, timeoutMs);
    child.once('error', (error) => {
      if (deadline) clearTimeout(deadline);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (deadline) clearTimeout(deadline);
      if (signal) {
        reject(new Error(`${command} was terminated by signal ${signal}`));
        return;
      }
      resolvePromise({ code, stderr });
    });
  });
}

async function readInstalledProductVersion(executablePath, { run = runCommand } = {}) {
  const script = `(Get-Item ${powerShellLiteral(executablePath)}).VersionInfo.ProductVersion`;
  const { stdout } = await run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeoutMs: 30_000,
    },
  );
  return stdout;
}

function scopedUninstallRegistrationScript(uninstallerPath) {
  return String.raw`
$expectedUninstaller = [IO.Path]::GetFullPath(${powerShellLiteral(uninstallerPath)})
$entries = @(
  Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
    ForEach-Object {
      $entry = $_
      $properties = $entry | Get-ItemProperty
      $command = [string]$properties.UninstallString
      $match = [regex]::Match($command, '^"([^"]+)"(?:\s|$)')
      if ($match.Success) {
        try {
          $actualUninstaller = [IO.Path]::GetFullPath($match.Groups[1].Value)
          if ([String]::Equals(
            $actualUninstaller,
            $expectedUninstaller,
            [StringComparison]::OrdinalIgnoreCase
          )) {
            [PSCustomObject]@{
              Path = $entry.PSPath
              DisplayVersion = [string]$properties.DisplayVersion
            }
          }
        } catch {
          # A malformed foreign registration is not this fixture's authority.
        }
      }
    }
)
`;
}

export async function readUninstallDisplayVersionsForInstall(
  uninstallerPath,
  { run = runCommand } = {},
) {
  const script = `${scopedUninstallRegistrationScript(uninstallerPath)}
@($entries | ForEach-Object { $_.DisplayVersion }) -join ','
`;
  const { stdout } = await run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeoutMs: 30_000 },
  );
  return stdout.trim();
}

/**
 * Deletes only this fixture installation's uninstall registration, emulating
 * the state the fail-closed branch exists for (a user- or tool-cleaned
 * registry). The installer's own pre-upgrade snapshot key is left alone on
 * purpose: without a complete backup the snapshot must not be sufficient to
 * proceed.
 */
export async function deleteUninstallRegistrationForInstall(
  uninstallerPath,
  { run = runCommand } = {},
) {
  const script = `${scopedUninstallRegistrationScript(uninstallerPath)}
$entries | ForEach-Object { Remove-Item -LiteralPath $_.Path -Recurse -Force }
`;
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: 30_000,
  });
}

async function assertLaunchable(installedExecutable, workingDirectory, expectedVersion) {
  const home = join(workingDirectory, 'home');
  const userData = join(workingDirectory, 'user-data');
  const userEnv = isolatedUserEnv(home);
  await mkdir(home, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(userEnv.APPDATA, { recursive: true });
  await mkdir(userEnv.LOCALAPPDATA, { recursive: true });
  const child = spawn(
    installedExecutable,
    ['--remote-debugging-port=0', `--user-data-dir=${userData}`, '--enable-logging=stderr'],
    {
      cwd: workingDirectory,
      env: { ...process.env, MAKA_SKIP_SHELL_ENV: '1', ...userEnv },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  try {
    const cdpPort = await waitForDevToolsPort(child);
    const target = await findRendererTarget(cdpPort, child);
    await waitForUsableRenderer(target.webSocketDebuggerUrl, child, {
      description: 'Restored app renderer',
    }).catch((error) => {
      throw new Error(`${error.message}${stderr.trim() ? `\n${stderr.trim()}` : ''}`, {
        cause: error,
      });
    });
    const productVersion = await readInstalledProductVersion(installedExecutable);
    assertWindowsProductVersion(productVersion, expectedVersion);
  } finally {
    await stopChild(child);
  }
}

/**
 * Exercises the Abort-path rollback contract of
 * apps/desktop/build/installer.nsh, scenario by scenario:
 *
 * 1. A deterministic Abort after extraction (the worst moment) leaves the
 *    previous installation byte-identical (per-file SHA-256 over the whole
 *    tree), registered, and launchable (exit 102).
 * 2. A forced registry read-back mismatch returns 103, retains recovery
 *    evidence, and a no-failpoint rerun recovers cleanly.
 * 3. The very same installer succeeds without the failpoint, leaving no
 *    backup residue (the hook does not break normal upgrades).
 * 4. A leftover backup with either a stale version marker or no executable
 *    witness fails closed before anything destructive runs.
 * 5. Gap pin: a Quit at the same moment runs no hook — extracted files stay,
 *    the registration stays gone, and the verified backup is retained.
 * 6. Recovery: rerunning the installer adopts that backup and its persisted
 *    registry snapshot and completes the upgrade cleanly.
 * 7. Fail closed: an upgrade over an installation with no uninstall
 *    registration and no adoptable backup is refused (exit 101) with the
 *    files untouched.
 */
export async function verifyWindowsInstallerRollback(
  candidateInputPath,
  nextDirectoryInput,
  {
    platform = process.platform,
    makeTemporaryDirectory = () => mkdtemp(join(tmpdir(), 'maka-rollback-')),
    run = runCommand,
  } = {},
) {
  if (platform !== 'win32') {
    throw new Error('Windows installer rollback verification requires Windows.');
  }
  if (!candidateInputPath || !nextDirectoryInput) {
    throw new Error(
      'Usage: npm run verify:windows-installer-rollback -- <candidate-exe> <next-release-directory>',
    );
  }

  const candidateInstaller = resolve(candidateInputPath);
  const nextDirectory = resolve(nextDirectoryInput);
  const candidateVersion = installerVersion(candidateInstaller);
  await access(candidateInstaller);
  // The next directory is the autoupdate-next output; find its installer by
  // the release naming contract rather than trusting directory listing order.
  const nextInstallerName = (await readdir(nextDirectory)).find((name) =>
    /^Maka-\d+\.\d+\.\d+-win-x64\.exe$/u.test(name),
  );
  if (!nextInstallerName) {
    throw new Error(`No Maka installer found in ${nextDirectory}.`);
  }
  const nextInstaller = join(nextDirectory, nextInstallerName);
  const nextVersion = installerVersion(nextInstaller);
  if (nextVersion === candidateVersion) {
    throw new Error('The rollback check needs a next installer with a different version.');
  }

  const temporaryDirectory = await makeTemporaryDirectory();
  const installDirectory = join(temporaryDirectory, 'installed');
  const backupDirectory = `${installDirectory}${backupSuffix}`;
  const staleBackupFixture = join(temporaryDirectory, 'candidate-backup-fixture');
  const uninstaller = join(installDirectory, uninstallExecutableName);
  const installedExecutable = join(installDirectory, executableName);
  let installationStarted = false;
  let uninstallCompleted = false;
  let primaryError;

  try {
    // An earlier verify step in the same job ends with a detached NSIS
    // uninstall whose LAST action deletes the uninstall registry keys, well
    // after its files are gone (see waitForUninstallRegistrationToClear).
    // Installing inside that window lets the stale uninstaller delete the
    // candidate's fresh registration, which then makes the upgrade's registry
    // snapshot legitimately empty — the failure surfaces two steps later as a
    // missing restored registration. Barrier first, then install.
    step('waiting for any earlier uninstall to finish clearing its registration');
    await waitForUninstallRegistrationToClear({ run });

    step(`installing candidate ${candidateVersion} into ${installDirectory}`);
    installationStarted = true;
    await run(candidateInstaller, ['/S', `/D=${installDirectory}`], { timeoutMs: 120_000 });
    await access(uninstaller);

    step('asserting the candidate registered its uninstall entry');
    const preUpgradeRegistration = await readUninstallDisplayVersionsForInstall(uninstaller, {
      run,
    });
    if (!preUpgradeRegistration.split(',').includes(candidateVersion)) {
      throw new Error(
        `Precondition failed: candidate install registered DisplayVersion ` +
          `${JSON.stringify(preUpgradeRegistration)}, expected to include ${candidateVersion}. ` +
          `The registry snapshot the rollback must restore does not exist yet.`,
      );
    }

    step('recording the pre-upgrade tree manifest');
    const manifestBefore = await directoryTreeManifest(installDirectory);
    step(`manifest covers ${manifestBefore.length} files`);
    await cp(installDirectory, staleBackupFixture, { recursive: true });

    step(`upgrading to ${nextVersion} with the after-extract failpoint armed`);
    const failpointEnv = { ...process.env, MAKA_INSTALLER_TEST_FAILPOINT: 'after-extract' };
    const failed = await runExpectingExit(nextInstaller, ['/S', `/D=${installDirectory}`], {
      env: failpointEnv,
      timeoutMs: 300_000,
    });
    if (failed.code !== exitRollbackCompleted) {
      const diagnosis =
        failed.code === exitRollbackFailed
          ? 'the rollback itself failed (backup kept for inspection)'
          : failed.code === exitBackupFailed
            ? 'the pre-upgrade backup failed before anything destructive ran'
            : failed.code === 0
              ? 'the failpoint never fired and the upgrade succeeded'
              : 'the installer failed outside the Abort-path rollback contract';
      throw new Error(
        `Failpoint upgrade exited with ${failed.code}, expected ${exitRollbackCompleted}: ${diagnosis}` +
          `${failed.stderr.trim() ? `\nstderr: ${failed.stderr.trim()}` : ''}`,
      );
    }

    step('asserting the previous installation is byte-identical');
    const manifestAfter = await directoryTreeManifest(installDirectory);
    const difference = diffTreeManifests(manifestBefore, manifestAfter);
    if (
      difference.missing.length > 0 ||
      difference.extra.length > 0 ||
      difference.changed.length > 0
    ) {
      throw new Error(
        `Restored installation differs from the pre-upgrade tree: ${JSON.stringify(difference)}`,
      );
    }
    step(`0 differing files across ${manifestAfter.length} entries`);
    for (const residue of [backupDirectory, `${installDirectory}.failed-upgrade`]) {
      try {
        await access(residue);
        throw new Error(`Residue left behind after rollback: ${residue}`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }

    step('asserting the uninstall registration was restored');
    const displayVersion = await readUninstallDisplayVersionsForInstall(uninstaller, { run });
    if (!displayVersion.split(',').includes(candidateVersion)) {
      throw new Error(
        `Uninstall registry DisplayVersion is ${JSON.stringify(displayVersion)}, expected to include ${candidateVersion}.`,
      );
    }

    step('asserting the restored installation launches');
    await assertLaunchable(
      installedExecutable,
      join(temporaryDirectory, 'restored-smoke'),
      candidateVersion,
    );
    await waitForInstalledProcessesToExit(installDirectory);

    step('control run: the same installer must succeed without the failpoint');
    const controlEnv = { ...process.env };
    delete controlEnv.MAKA_INSTALLER_TEST_FAILPOINT;
    await run(nextInstaller, ['/S', `/D=${installDirectory}`], {
      env: controlEnv,
      timeoutMs: 300_000,
    });
    await access(uninstaller);
    const upgradedVersion = await readInstalledProductVersion(installedExecutable, { run });
    assertWindowsProductVersion(upgradedVersion, nextVersion);
    try {
      await access(backupDirectory);
      throw new Error(`Backup residue left behind after a successful upgrade: ${backupDirectory}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await waitForInstalledProcessesToExit(installDirectory);

    step('registry mismatch: return 103 and retain evidence for a recovery rerun');
    const registryMismatchEnv = {
      ...process.env,
      MAKA_INSTALLER_TEST_FAILPOINT: 'after-extract-registry-mismatch',
    };
    const registryMismatch = await runExpectingExit(
      nextInstaller,
      ['/S', `/D=${installDirectory}`],
      { env: registryMismatchEnv, timeoutMs: 300_000 },
    );
    if (registryMismatch.code !== exitRollbackFailed) {
      throw new Error(
        `Registry-mismatch rollback exited with ${registryMismatch.code}, expected ${exitRollbackFailed}.` +
          `${registryMismatch.stderr.trim() ? `\nstderr: ${registryMismatch.stderr.trim()}` : ''}`,
      );
    }
    const mismatchVersion = await readInstalledProductVersion(installedExecutable, { run });
    assertWindowsProductVersion(mismatchVersion, nextVersion);
    await access(join(backupDirectory, backupMarkerName));
    await access(join(backupDirectory, 'RECOVERY-README.txt'));
    await access(join(`${installDirectory}.failed-upgrade`, executableName));

    step('registry mismatch recovery: rerun without the failpoint');
    await run(nextInstaller, ['/S', `/D=${installDirectory}`], {
      env: controlEnv,
      timeoutMs: 300_000,
    });
    const recoveredFromRegistryMismatch = await readInstalledProductVersion(installedExecutable, {
      run,
    });
    assertWindowsProductVersion(recoveredFromRegistryMismatch, nextVersion);
    const mismatchRecoveryRegistration = await readUninstallDisplayVersionsForInstall(uninstaller, {
      run,
    });
    if (!mismatchRecoveryRegistration.split(',').includes(nextVersion)) {
      throw new Error(
        `Registry-mismatch recovery did not restore the uninstall registration: ` +
          `${JSON.stringify(mismatchRecoveryRegistration)}, expected ${nextVersion}.`,
      );
    }
    for (const residue of [backupDirectory, `${installDirectory}.failed-upgrade`]) {
      try {
        await access(residue);
        throw new Error(`Residue left behind after registry-mismatch recovery: ${residue}`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await waitForInstalledProcessesToExit(installDirectory);

    step('stale backup identity: refuse before changing the current installation');
    await cp(staleBackupFixture, backupDirectory, { recursive: true });
    await writeFile(join(backupDirectory, backupMarkerName), `version=${candidateVersion}`, 'utf8');
    const staleBackup = await runExpectingExit(nextInstaller, ['/S', `/D=${installDirectory}`], {
      env: controlEnv,
      timeoutMs: 300_000,
    });
    if (staleBackup.code !== exitBackupFailed) {
      throw new Error(
        `Stale-backup upgrade exited with ${staleBackup.code}, expected ${exitBackupFailed}.` +
          `${staleBackup.stderr.trim() ? `\nstderr: ${staleBackup.stderr.trim()}` : ''}`,
      );
    }
    const unchangedAfterStaleBackup = await readInstalledProductVersion(installedExecutable, {
      run,
    });
    assertWindowsProductVersion(unchangedAfterStaleBackup, nextVersion);
    const registrationAfterStaleBackup = await readUninstallDisplayVersionsForInstall(uninstaller, {
      run,
    });
    if (!registrationAfterStaleBackup.split(',').includes(nextVersion)) {
      throw new Error(
        `Stale backup refusal changed the uninstall registration: ` +
          `${JSON.stringify(registrationAfterStaleBackup)}, expected ${nextVersion}.`,
      );
    }

    step('incomplete backup identity: a matching marker without Maka.exe is refused');
    await writeFile(join(backupDirectory, backupMarkerName), `version=${nextVersion}`, 'utf8');
    await rm(join(backupDirectory, executableName), { force: true });
    const incompleteBackup = await runExpectingExit(
      nextInstaller,
      ['/S', `/D=${installDirectory}`],
      { env: controlEnv, timeoutMs: 300_000 },
    );
    if (incompleteBackup.code !== exitBackupFailed) {
      throw new Error(
        `Incomplete-backup upgrade exited with ${incompleteBackup.code}, expected ${exitBackupFailed}.` +
          `${incompleteBackup.stderr.trim() ? `\nstderr: ${incompleteBackup.stderr.trim()}` : ''}`,
      );
    }
    const unchangedAfterIncompleteBackup = await readInstalledProductVersion(installedExecutable, {
      run,
    });
    assertWindowsProductVersion(unchangedAfterIncompleteBackup, nextVersion);
    const registrationAfterIncompleteBackup = await readUninstallDisplayVersionsForInstall(
      uninstaller,
      { run },
    );
    if (!registrationAfterIncompleteBackup.split(',').includes(nextVersion)) {
      throw new Error(
        `Incomplete backup refusal changed the uninstall registration: ` +
          `${JSON.stringify(registrationAfterIncompleteBackup)}, expected ${nextVersion}.`,
      );
    }
    await rm(backupDirectory, { recursive: true, force: true });

    // The template's real failure branches exit via Quit, which NSIS gives
    // no hook for: no rollback runs there, by design and by documentation.
    // Pin that gap precisely instead of assuming it, and then prove the
    // documented recovery story: running the installer again adopts the
    // retained backup and completes the upgrade.
    step('gap pin: a Quit at the worst moment leaves no hook and keeps the backup');
    const quitEnv = { ...process.env, MAKA_INSTALLER_TEST_FAILPOINT: 'after-extract-quit' };
    const quit = await runExpectingExit(nextInstaller, ['/S', `/D=${installDirectory}`], {
      env: quitEnv,
      timeoutMs: 300_000,
    });
    // State first, exit code last: the state assertions carry the semantic
    // pin (extracted files present, registration gone, backup retained), and
    // on an exit-code drift they are the evidence that says what actually
    // happened.
    await access(join(backupDirectory, backupMarkerName));
    // The recovery note is written at backup-creation time precisely so the
    // hookless Quit paths leave it behind; assert that here.
    await access(join(backupDirectory, 'RECOVERY-README.txt'));
    const orphanVersion = await readInstalledProductVersion(installedExecutable, { run });
    assertWindowsProductVersion(orphanVersion, nextVersion);
    const orphanRegistration = await readUninstallDisplayVersionsForInstall(uninstaller, { run });
    if (orphanRegistration !== '') {
      throw new Error(
        `After the Quit failpoint the uninstall registration should be gone (the old ` +
          `uninstaller removed it and nothing rewrote it), found ${JSON.stringify(orphanRegistration)}.`,
      );
    }
    // Executed evidence, not inference: run 32384536035 measured a bare Quit
    // at this point exiting 2 (the silent installer's generic failure code,
    // shared with a hookless Abort default) — not 0 as NSIS source reading
    // suggested. The state assertions above establish that the Quit branch
    // (extraction completed, nothing registered) is the one that ran.
    if (quit.code !== 2) {
      throw new Error(
        `Quit-failpoint upgrade exited with ${quit.code}, expected 2 (measured template-style ` +
          `hookless Quit, run 32384536035): the pinned no-hook behavior changed — re-derive the gap.` +
          `${quit.stderr.trim() ? `\nstderr: ${quit.stderr.trim()}` : ''}`,
      );
    }

    step('recovery: rerunning the installer adopts the backup and completes the upgrade');
    await run(nextInstaller, ['/S', `/D=${installDirectory}`], {
      env: controlEnv,
      timeoutMs: 300_000,
    });
    await access(uninstaller);
    const recoveredVersion = await readInstalledProductVersion(installedExecutable, { run });
    assertWindowsProductVersion(recoveredVersion, nextVersion);
    const recoveredRegistration = await readUninstallDisplayVersionsForInstall(uninstaller, {
      run,
    });
    if (!recoveredRegistration.split(',').includes(nextVersion)) {
      throw new Error(
        `Recovery rerun did not restore the uninstall registration: ` +
          `${JSON.stringify(recoveredRegistration)}, expected to include ${nextVersion}.`,
      );
    }
    try {
      await access(backupDirectory);
      throw new Error(`Backup residue left behind after the recovery rerun: ${backupDirectory}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await waitForInstalledProcessesToExit(installDirectory);

    step('fail closed: an upgrade with no registration and no backup is refused');
    await deleteUninstallRegistrationForInstall(uninstaller, { run });
    const refused = await runExpectingExit(nextInstaller, ['/S', `/D=${installDirectory}`], {
      env: controlEnv,
      timeoutMs: 300_000,
    });
    if (refused.code !== exitBackupFailed) {
      throw new Error(
        `Registration-less upgrade exited with ${refused.code}, expected ${exitBackupFailed} ` +
          `(fail closed before anything destructive).` +
          `${refused.stderr.trim() ? `\nstderr: ${refused.stderr.trim()}` : ''}`,
      );
    }
    const untouchedVersion = await readInstalledProductVersion(installedExecutable, { run });
    assertWindowsProductVersion(untouchedVersion, nextVersion);
    try {
      await access(backupDirectory);
      throw new Error(`The refused upgrade must not leave a backup: ${backupDirectory}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    step('uninstalling');
    await run(uninstaller, ['/S'], { timeoutMs: 120_000 });
    await waitUntilMissing(installDirectory);
    // The detached uninstaller deletes the registry keys after the files; do
    // not leave that race armed for whatever runs after this step.
    await waitForUninstallRegistrationToClear({ run });
    uninstallCompleted = true;
    step(
      `verified Abort-path rollback and its boundaries for ${candidateVersion} -> ${nextVersion}`,
    );
    return { candidateVersion, nextVersion, installDirectory };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (installationStarted && !uninstallCompleted) {
      try {
        await waitForInstalledProcessesToExit(installDirectory);
        await access(uninstaller);
        await run(uninstaller, ['/S'], { timeoutMs: 120_000 });
      } catch (error) {
        cleanupErrors.push(error);
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
      const cleanupFailure = new AggregateError(cleanupErrors, 'Rollback verifier cleanup failed.');
      if (!primaryError) throw cleanupFailure;
      if (primaryError instanceof Error && primaryError.cause === undefined) {
        primaryError.cause = cleanupFailure;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyWindowsInstallerRollback(process.argv[2], process.argv[3]);
  console.log(
    `Verified Abort-path installer rollback for ${result.candidateVersion} -> ${result.nextVersion}`,
  );
}
