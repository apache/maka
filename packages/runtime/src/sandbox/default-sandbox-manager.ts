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
 * hiccup). Caching it for only this window bounds how long one blip poisons the
 * module-scoped cache: a *later* composition build re-probes instead of
 * inheriting a stale negative. It does not make an already-running host recover
 * — the filesystem worker is published once, when a composition is built (see
 * `isBuiltinFilesystemWorkerSandboxAvailable` and RFC §6.4), so a composition
 * that resolved availability negative stays without the worker for its lifetime;
 * recovery is scoped to the next composition build or a Runtime Host restart.
 * Positive results are cached permanently: host capability does not regress
 * within a process lifetime.
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
 * probe; distinct paths (tests, side-by-side installs) stay independent. A
 * negative entry carries a bounded expiry so it does not poison availability for
 * the whole process lifetime — the *next composition build* re-probes (see
 * `WINDOWS_READINESS_NEGATIVE_TTL_MS`); this is not an in-composition retry.
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
 * so a transient failure does not poison the module cache past that window — the
 * *next composition build* re-probes. This is not a running-host retry: the
 * warmer runs at composition-build time and the worker is published once, so a
 * host that already resolved availability negative recovers only on a new
 * composition or a restart (RFC §6.4). Anything other than a clean exit 0 fails
 * closed (a non-zero status, a spawn error, or an external timeout that leaves
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
    // Runtime Host composition calls this once when it builds (and again only
    // when a *new* composition is built), warming `windowsReadinessCache` via the
    // spawning probe. It is not re-run when a cache entry expires, so recovery
    // from a transient negative is scoped to the next composition build or a
    // restart (RFC §6.4). The backend's synchronous `isAvailable` on the
    // operation hot path is strictly cache-only (`readCachedWindowsReadiness`)
    // and never spawns. File presence is no longer a second availability
    // authority.
    const clientPath = builtinWindowsClientPath(platform, resourcesPath);
    return clientPath !== undefined && probeWindowsReadiness(clientPath);
  }
  return (
    platform === 'linux' &&
    linuxCapability !== undefined &&
    new LinuxBubblewrapBackend({ capability: linuxCapability, arch }).isAvailable('linux')
  );
}
