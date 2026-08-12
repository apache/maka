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
  const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
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
  let processes = await listProcesses(installDirectory);
  while (processes.length > 0) {
    if (Date.now() >= deadline) {
      const summary = processes.map(({ processId, name }) => `${name} (${processId})`).join(', ');
      throw new Error(
        `Installed Maka processes did not exit within ${timeoutMs}ms: ${summary || '<unknown>'}.`,
      );
    }
    await sleep(pollIntervalMs);
    processes = await listProcesses(installDirectory);
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
