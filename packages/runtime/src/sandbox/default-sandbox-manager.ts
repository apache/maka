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
 * A negative readiness result may be transient (a spawn timeout under load, an
 * antivirus scan briefly holding the launcher, a momentary AppContainer service
 * hiccup), so it is cached only for this window before the next warmer re-probes.
 * A single blip must not disable the Windows sandbox until the Runtime Host
 * restarts. Positive results are cached permanently: host capability does not
 * regress within a process lifetime.
 */
const WINDOWS_READINESS_NEGATIVE_TTL_MS = 60_000;

interface WindowsReadinessCacheEntry {
  readonly available: boolean;
  /** Epoch ms after which this entry is stale; `Infinity` for positive results. */
  readonly expiresAt: number;
}

/**
 * Availability is a property of the host and the launcher binary, not of any one
 * backend instance, so the probe result is cached at module scope keyed by the
 * resolved client path. Two backends built for the same launcher share the one
 * probe; distinct paths (tests, side-by-side installs) stay independent. Entries
 * carry an expiry so a transient negative result re-probes (see
 * `WINDOWS_READINESS_NEGATIVE_TTL_MS`) instead of poisoning availability for the
 * process lifetime.
 */
const windowsReadinessCache = new Map<string, WindowsReadinessCacheEntry>();

/** Outcome of one launcher `--readiness-probe` invocation. */
export interface WindowsReadinessSpawnResult {
  readonly status: number | null;
  readonly error?: Error;
}

/** Runs one readiness probe. Injectable so tests can drive it deterministically. */
export type WindowsReadinessSpawn = (clientPath: string) => WindowsReadinessSpawnResult;

function spawnReadinessProbe(clientPath: string): WindowsReadinessSpawnResult {
  const result = spawnSync(clientPath, ['--readiness-probe'], {
    timeout: WINDOWS_READINESS_PROBE_TIMEOUT_MS,
    windowsHide: true,
    stdio: 'ignore',
  });
  return { status: result.status, error: result.error };
}

/**
 * Production-identity readiness probe for the Windows backend (RFC §6.4). This
 * is the *spawning* entry point, called by the Runtime Host composition warmer;
 * it may block on `spawnSync`, so it must never run on the operation hot path
 * (use `readCachedWindowsReadiness` there).
 *
 * `existsSync` alone only proves the packaged launcher is present, not that the
 * OS can actually create the AppContainer identity, token, and Job on this
 * machine (AppContainer can be disabled by policy, the edition may not support
 * it, etc.). This runs the launcher's `--readiness-probe`, which stands up the
 * real production identity and launches a throwaway confined child. A fresh,
 * unexpired cache entry short-circuits the spawn; a positive result is cached
 * permanently and a negative one only for `WINDOWS_READINESS_NEGATIVE_TTL_MS`,
 * so one transient failure re-probes on the next warmer rather than disabling
 * the sandbox until restart. Anything other than a clean exit 0 fails closed (a
 * non-zero status, a spawn error, or an external timeout that leaves
 * `status === null`).
 */
export function probeWindowsReadiness(
  clientPath: string,
  spawn: WindowsReadinessSpawn = spawnReadinessProbe,
  now: () => number = Date.now,
): boolean {
  const cached = windowsReadinessCache.get(clientPath);
  if (cached !== undefined && now() < cached.expiresAt) return cached.available;
  let available = false;
  if (existsSync(clientPath)) {
    try {
      const result = spawn(clientPath);
      available = result.error === undefined && result.status === 0;
    } catch {
      available = false;
    }
  }
  const expiresAt = available ? Infinity : now() + WINDOWS_READINESS_NEGATIVE_TTL_MS;
  windowsReadinessCache.set(clientPath, { available, expiresAt });
  return available;
}

/**
 * Strictly cache-only readiness read for the synchronous `isAvailable` hot path.
 * It never spawns: it returns the warmed result when a fresh entry exists and
 * fails closed (`false`) otherwise — including when a negative entry has expired
 * — so the event loop is never blocked on `spawnSync`. The composition warmer
 * (`probeWindowsReadiness`) is responsible for (re)populating the cache.
 */
export function readCachedWindowsReadiness(
  clientPath: string,
  now: () => number = Date.now,
): boolean {
  const cached = windowsReadinessCache.get(clientPath);
  return cached !== undefined && now() < cached.expiresAt ? cached.available : false;
}

function createWindowsReadinessProbe(clientPath: string): () => boolean {
  return () => readCachedWindowsReadiness(clientPath);
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
  if (platform === 'win32') {
    // Single source of truth for Windows availability: file presence only
    // discovers the launcher path; the readiness probe decides availability.
    // Runtime Host composition calls this at startup (and again as the cache
    // expires), which warms `windowsReadinessCache` via the spawning probe. The
    // backend's synchronous `isAvailable` on the operation hot path is strictly
    // cache-only (`readCachedWindowsReadiness`) and never spawns. File presence
    // is no longer a second availability authority.
    const clientPath = builtinWindowsClientPath(platform, resourcesPath);
    return clientPath !== undefined && probeWindowsReadiness(clientPath);
  }
  return (
    platform === 'linux' &&
    linuxCapability !== undefined &&
    new LinuxBubblewrapBackend({ capability: linuxCapability, arch }).isAvailable('linux')
  );
}
