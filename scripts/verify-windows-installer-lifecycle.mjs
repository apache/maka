import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCommand } from './verify-packaged-app.mjs';
import { powerShellLiteral, verifyPackagedWindowsApp } from './verify-windows-x64.mjs';

const uninstallExecutableName = 'Uninstall Maka.exe';
const temporaryCleanupRetries = 20;
const temporaryCleanupRetryDelayMs = 250;

export function installerVersion(path) {
  const match = basename(path).match(/^Maka-(\d+\.\d+\.\d+)-win-x64\.exe$/u);
  if (!match) {
    throw new Error(`Cannot infer a release version from ${basename(path)}.`);
  }
  return match[1];
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function listInstalledProcesses(installDirectory, { run = runCommand } = {}) {
  const root = `${resolve(installDirectory)}${sep}`;
  const script = String.raw`
$root = [IO.Path]::GetFullPath(${powerShellLiteral(root)})
$matches = @(
  Get-CimInstance Win32_Process | ForEach-Object {
    if ($_.ExecutablePath) {
      $path = [IO.Path]::GetFullPath($_.ExecutablePath)
      if ($path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        [PSCustomObject]@{ processId = $_.ProcessId; name = $_.Name; path = $path }
      }
    }
  }
)
$matches | ConvertTo-Json -Compress
`;
  // Bounded: this probe runs inside polling loops whose deadline is the
  // authority. An unbounded WMI query that wedges would otherwise turn a
  // 60-second wait into the workflow timeout with no diagnostic.
  const { stdout } = await run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeoutMs: 30_000,
    },
  );
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function waitForInstalledProcessesToExit(
  installDirectory,
  {
    listProcesses = listInstalledProcesses,
    timeoutMs = 60_000,
    pollIntervalMs = 1_000,
    sleep = delay,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastProbeError;
  for (;;) {
    // A failed enumeration is retried, never treated as "no processes":
    // this wait exists to prove exit, so an unreadable state must keep
    // polling and fail at the deadline, not pass or die on one hiccup.
    let processes;
    try {
      processes = await listProcesses(installDirectory);
      lastProbeError = undefined;
    } catch (error) {
      lastProbeError = error;
    }
    if (processes && processes.length === 0) return;
    if (Date.now() >= deadline) {
      if (lastProbeError) {
        throw new Error(
          `Could not enumerate installed Maka processes within ${timeoutMs}ms: ` +
            `${lastProbeError.message}`,
          { cause: lastProbeError },
        );
      }
      const summary = processes.map(({ processId, name }) => `${name} (${processId})`).join(', ');
      throw new Error(
        `Installed Maka processes did not exit within ${timeoutMs}ms: ${summary || '<unknown>'}.`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

export async function waitUntilMissing(
  path,
  { probe = access, timeoutMs = 30_000, pollIntervalMs = 250 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await probe(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Installer cleanup did not remove ${path} within ${timeoutMs}ms.`);
    }
    await delay(pollIntervalMs);
  }
}

/**
 * Every HKCU `DisplayVersion` registered under the Maka display name, joined
 * with commas ('' when none). One PowerShell scan, shared by the harnesses
 * that assert on — or wait out — the uninstall registration.
 */
export async function readUninstallDisplayVersions({ run = runCommand } = {}) {
  // electron-builder's default uninstallDisplayName is
  // "${productName} ${version}" (NsisTarget: UNINSTALL_DISPLAY_NAME), so the
  // registered DisplayName is "Maka 0.1.11", never the bare product name. The
  // trailing space in the wildcard keeps other products starting with "Maka"
  // out; the bare-name arm covers a configured uninstallDisplayName without a
  // version, should one ever be set.
  const script = String.raw`
$entries = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
  ForEach-Object { Get-ItemProperty $_.PSPath } |
  Where-Object { $_.DisplayName -eq 'Maka' -or $_.DisplayName -like 'Maka *' }
@($entries | ForEach-Object { $_.DisplayVersion }) -join ','
`;
  // Bounded for the same reason as listInstalledProcesses: the enclosing
  // waits own the deadline, so one stalled registry query must fail this
  // probe, not the whole lane.
  const { stdout } = await run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeoutMs: 30_000,
    },
  );
  return stdout.trim();
}

/**
 * An NSIS uninstall is not over when the files are gone. Launched without
 * `_?=`, "Uninstall Maka.exe" copies itself to %TEMP% and detaches; the copy
 * removes $INSTDIR first and deletes the uninstall/install registry keys as
 * its LAST action (uninstaller.nsh: RMDir /r, then shortcuts, SHChangeNotify
 * and app-data handling, then DeleteRegKey), which on a busy runner lands tens
 * of seconds after `waitUntilMissing` saw the files disappear. Anything that
 * installs into that window gets its freshly written registration deleted by
 * the stale uninstaller — observed as an empty uninstall entry two steps
 * later. The uninstall registration's disappearance is the near-final
 * signal, not the final one: the uninstaller deletes the uninstall key at
 * uninstaller.nsh:250 and the install key at :254, so when the registration
 * vanishes the detached copy still has one registry deletion left. A fresh
 * install writes both keys after this wait returns, so the residual window
 * is the width of two adjacent registry calls — accepted, and stated here
 * so the premise is re-checked if the uninstaller's ordering ever changes.
 */
export async function waitForUninstallRegistrationToClear({
  run = runCommand,
  timeoutMs = 120_000,
  pollIntervalMs = 2_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastProbeError;
  for (;;) {
    // One stalled or failed probe is tolerated and retried — the deadline
    // below is the authority, and a transient WMI/registry hiccup must not
    // end a wait that owns two minutes of budget.
    let versions;
    try {
      versions = await readUninstallDisplayVersions({ run });
      lastProbeError = undefined;
    } catch (error) {
      lastProbeError = error;
    }
    if (versions === '') return;
    if (Date.now() >= deadline) {
      if (lastProbeError) {
        throw new Error(
          `Could not read the Maka uninstall registration within ${timeoutMs}ms: ` +
            `${lastProbeError.message}`,
          { cause: lastProbeError },
        );
      }
      throw new Error(
        `A Maka uninstall registration (DisplayVersion ${JSON.stringify(versions)}) is still ` +
          `present after ${timeoutMs}ms — a detached uninstaller has not finished, or an ` +
          `earlier step leaked an installation.`,
      );
    }
    await delay(pollIntervalMs);
  }
}

export async function verifyWindowsInstallerLifecycle(
  inputPath,
  previousInputPath,
  {
    platform = process.platform,
    makeTemporaryDirectory = () => mkdtemp(join(tmpdir(), 'maka-installer-lifecycle-')),
    run = runCommand,
    verifyApp = verifyPackagedWindowsApp,
    requirePath = access,
    waitForMissing = waitUntilMissing,
    waitForProcessesToExit = waitForInstalledProcessesToExit,
    remove = rm,
    resolvePath = resolve,
  } = {},
) {
  if (platform !== 'win32') {
    throw new Error('Windows installer lifecycle verification requires Windows.');
  }
  if (!inputPath) {
    throw new Error('Usage: npm run verify:windows-installer -- <path-to-exe>');
  }

  const installer = resolvePath(inputPath);
  if (!installer.endsWith('.exe')) {
    throw new Error(`Expected the NSIS installer .exe, found ${basename(installer)}.`);
  }
  await requirePath(installer);
  const previousInstaller = previousInputPath ? resolvePath(previousInputPath) : undefined;
  if (previousInstaller) {
    installerVersion(previousInstaller);
    await requirePath(previousInstaller);
  }

  const temporaryDirectory = await makeTemporaryDirectory();
  const installDirectory = join(temporaryDirectory, 'installed');
  const smokeDirectory = join(temporaryDirectory, 'smoke');
  const uninstaller = join(installDirectory, uninstallExecutableName);
  let installationStarted = false;
  let uninstallCompleted = false;
  let primaryError;

  try {
    installationStarted = true;
    if (previousInstaller) {
      const previousVersion = installerVersion(previousInstaller);
      console.log(
        `[verify-windows-installer] installing previous version ${previousVersion} into ${installDirectory}`,
      );
      await run(previousInstaller, ['/S', `/D=${installDirectory}`], { timeoutMs: 120_000 });
      await requirePath(uninstaller);
      console.log('[verify-windows-installer] verifying the previous installed application');
      await verifyApp(installDirectory, {
        workingDirectory: smokeDirectory,
        expectedVersion: previousVersion,
      });
      console.log('[verify-windows-installer] waiting for previous-version processes to exit');
      await waitForProcessesToExit(installDirectory);
      console.log(`[verify-windows-installer] upgrading to ${installerVersion(installer)}`);
    } else {
      console.log(`[verify-windows-installer] installing into ${installDirectory}`);
    }
    // NSIS requires /D to be the final argument. spawn passes it directly, so
    // spaces in a runner path do not need shell quoting.
    await run(installer, ['/S', `/D=${installDirectory}`], { timeoutMs: 120_000 });
    await requirePath(uninstaller);

    console.log('[verify-windows-installer] verifying the installed application');
    await verifyApp(installDirectory, { workingDirectory: smokeDirectory });

    console.log('[verify-windows-installer] waiting for installed processes to exit');
    await waitForProcessesToExit(installDirectory);

    console.log('[verify-windows-installer] uninstalling');
    await run(uninstaller, ['/S'], { timeoutMs: 120_000 });
    await waitForMissing(installDirectory);
    // The registration's disappearance, not the files', is the uninstall's
    // final action; the next verify step in this job installs immediately and
    // must not race the detached uninstaller's DeleteRegKey (see
    // waitForUninstallRegistrationToClear).
    await waitForUninstallRegistrationToClear({ run });
    uninstallCompleted = true;
    console.log('[verify-windows-installer] lifecycle verified');

    return { installer, installDirectory };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (installationStarted && !uninstallCompleted) {
      let installedProcessesExited = false;
      try {
        await waitForProcessesToExit(installDirectory);
        installedProcessesExited = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (installedProcessesExited) {
        try {
          await requirePath(uninstaller);
          await run(uninstaller, ['/S'], { timeoutMs: 120_000 });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    try {
      await remove(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: temporaryCleanupRetries,
        retryDelay: temporaryCleanupRetryDelayMs,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      const cleanupFailure = new AggregateError(
        cleanupErrors,
        'Installer verifier cleanup failed.',
      );
      if (!primaryError) throw cleanupFailure;
      if (primaryError instanceof Error && primaryError.cause === undefined) {
        primaryError.cause = cleanupFailure;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyWindowsInstallerLifecycle(process.argv[2], process.argv[3]);
  console.log(`Verified installer lifecycle for ${result.installer}`);
}
