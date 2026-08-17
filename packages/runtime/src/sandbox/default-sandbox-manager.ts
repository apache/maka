import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SandboxManager } from './sandbox-manager.js';
import { MacosSeatbeltBackend } from './macos-seatbelt.js';
import { LinuxBubblewrapBackend } from './linux-sandbox.js';
import { detectLinuxSandboxCapability, type LinuxSandboxCapability } from './linux-capability.js';
import type { SandboxPlatform } from './types.js';
import {
  createWindowsBrokerManifestWriter,
  WindowsBrokerSandboxBackend,
} from './windows-sandbox.js';

interface ElectronProcess extends NodeJS.Process {
  readonly resourcesPath?: string;
}

function builtinWindowsClientPath(
  platform: SandboxPlatform,
  resourcesPath: string | undefined,
): string | undefined {
  if (platform !== 'win32' || !resourcesPath) return undefined;
  const clientPath = join(resourcesPath, 'windows-sandbox', 'maka-windows-sandbox.exe');
  return existsSync(clientPath) ? clientPath : undefined;
}

/**
 * Upper bound for the launcher's own readiness probe (10s) plus process spawn
 * overhead. If the probe cannot answer within this window the host cannot stand
 * up the boundary quickly enough, so availability fails closed.
 */
const WINDOWS_READINESS_PROBE_TIMEOUT_MS = 15_000;

/**
 * Production-identity readiness probe for the Windows backend (RFC §6.4).
 *
 * `existsSync` alone only proves the packaged launcher is present, not that the
 * OS can actually create the AppContainer identity, token, and Job on this
 * machine (AppContainer can be disabled by policy, the edition may not support
 * it, etc.). This runs the launcher's `--readiness-probe`, which stands up the
 * real production identity and launches a throwaway confined child, and caches
 * the result for the process lifetime — availability is stable per host, and
 * the sync `SandboxBackend.isAvailable` contract must stay cheap after the
 * first call. Anything other than a clean exit 0 fails closed.
 */
function createWindowsReadinessProbe(clientPath: string): () => boolean {
  let cached: boolean | undefined;
  return () => {
    if (cached !== undefined) return cached;
    if (!existsSync(clientPath)) {
      cached = false;
      return cached;
    }
    try {
      const result = spawnSync(clientPath, ['--readiness-probe'], {
        timeout: WINDOWS_READINESS_PROBE_TIMEOUT_MS,
        windowsHide: true,
        stdio: 'ignore',
      });
      cached = result.error === undefined && result.status === 0;
    } catch {
      cached = false;
    }
    return cached;
  };
}

function builtinWindowsBackend(
  platform: SandboxPlatform,
  resourcesPath: string | undefined,
): WindowsBrokerSandboxBackend | undefined {
  const clientPath = builtinWindowsClientPath(platform, resourcesPath);
  if (!clientPath) return undefined;
  return new WindowsBrokerSandboxBackend({
    clientPath,
    writeManifest: createWindowsBrokerManifestWriter(),
    isAvailable: createWindowsReadinessProbe(clientPath),
  });
}

export function createDefaultSandboxManager(): SandboxManager {
  return new SandboxManager([new MacosSeatbeltBackend(), new LinuxBubblewrapBackend()]);
}

export function createBuiltinSandboxManager(
  platform: SandboxPlatform = process.platform,
  resourcesPath: string | undefined = (process as ElectronProcess).resourcesPath,
): SandboxManager {
  const windows = builtinWindowsBackend(platform, resourcesPath);
  return windows
    ? new SandboxManager([new MacosSeatbeltBackend(), new LinuxBubblewrapBackend(), windows])
    : createDefaultSandboxManager();
}

export function isBuiltinFilesystemWorkerSandboxAvailable(
  platform: SandboxPlatform = process.platform,
  linuxCapability: LinuxSandboxCapability | undefined = platform === 'linux'
    ? detectLinuxSandboxCapability({ platform })
    : undefined,
  arch: NodeJS.Architecture = process.arch,
  resourcesPath: string | undefined = (process as ElectronProcess).resourcesPath,
): boolean {
  if (platform === 'darwin') return true;
  if (platform === 'win32') return builtinWindowsClientPath(platform, resourcesPath) !== undefined;
  return (
    platform === 'linux' &&
    linuxCapability !== undefined &&
    new LinuxBubblewrapBackend({ capability: linuxCapability, arch }).isAvailable('linux')
  );
}
