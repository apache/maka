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

function builtinWindowsBackend(
  platform: SandboxPlatform,
  resourcesPath: string | undefined,
): WindowsBrokerSandboxBackend | undefined {
  const clientPath = builtinWindowsClientPath(platform, resourcesPath);
  if (!clientPath) return undefined;
  return new WindowsBrokerSandboxBackend({
    clientPath,
    writeManifest: createWindowsBrokerManifestWriter(),
    isAvailable: () => existsSync(clientPath),
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
