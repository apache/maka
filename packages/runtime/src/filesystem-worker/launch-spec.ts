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

import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  resolveFilesystemWorkerBundle,
  type FilesystemWorkerResourceLocation,
} from './resource-resolver.js';
import {
  resolveMacosExecutableDependencies,
  type MacosExecutableDependencyResolution,
} from './macos-executable-dependencies.js';

export interface FilesystemWorkerLaunchSpec {
  program: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  runtimeReadableRoots: readonly string[];
  executableRoots: readonly string[];
}

export type FilesystemWorkerLaunchSpecResult =
  | { ok: true; spec: FilesystemWorkerLaunchSpec }
  | {
      ok: false;
      reason: 'worker_bundle_unavailable' | 'runtime_executable_unavailable';
      message: string;
    };

export type FilesystemWorkerLaunchSpecProvider = () => Promise<FilesystemWorkerLaunchSpecResult>;

export interface CreateFilesystemWorkerLaunchSpecProviderInput {
  runtime: 'node' | 'electron';
  platform?: NodeJS.Platform;
  executable?: string;
  resourceLocation: FilesystemWorkerResourceLocation;
  hostEnv?: NodeJS.ProcessEnv;
  rgCandidates?: readonly string[];
  tmpdir?: string;
  /** @internal Test seam for deterministic Mach-O dependency inspection. */
  inspectMacosExecutableDependencies?: (
    executable: string,
  ) => Promise<MacosExecutableDependencyResolution>;
}

export function createFilesystemWorkerLaunchSpecProvider(
  input: CreateFilesystemWorkerLaunchSpecProviderInput,
): FilesystemWorkerLaunchSpecProvider {
  let cached: Promise<FilesystemWorkerLaunchSpecResult> | undefined;
  return () => (cached ??= resolveLaunchSpec(input));
}

export function buildFilesystemWorkerEnv(
  runtime: 'node' | 'electron',
  hostEnv: NodeJS.ProcessEnv = process.env,
  controlledTmpdir = '/tmp',
  platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = { TMPDIR: controlledTmpdir, OPENSSL_CONF: '/dev/null' };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE'] as const) {
    const value = hostEnv[key];
    if (value) env[key] = value;
  }
  if (platform === 'win32') {
    // A Windows process launched with an explicit environment block needs
    // SystemRoot for the loader, and AppContainer creation fails with
    // ERROR_ENVVAR_NOT_FOUND unless LOCALAPPDATA is present — the LowBox
    // infrastructure rewrites it to the container's redirected location.
    for (const key of ['SystemRoot', 'SystemDrive', 'LOCALAPPDATA'] as const) {
      const value = hostEnv[key];
      if (value) env[key] = value;
    }
  }
  if (runtime === 'electron') env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

async function resolveLaunchSpec(
  input: CreateFilesystemWorkerLaunchSpecProviderInput,
): Promise<FilesystemWorkerLaunchSpecResult> {
  const bundle = await resolveFilesystemWorkerBundle(input.resourceLocation);
  if (!bundle.ok) {
    return {
      ok: false,
      reason: 'worker_bundle_unavailable',
      message: `Filesystem worker bundle is unavailable (${bundle.reason}).`,
    };
  }
  const program = await resolveExecutable(input.executable ?? process.execPath);
  if (!program) {
    return {
      ok: false,
      reason: 'runtime_executable_unavailable',
      message: 'Filesystem worker runtime is unavailable.',
    };
  }
  const platform = input.platform ?? process.platform;
  // A packaged Windows executable lives directly inside the product-owned app
  // directory. Granting its parent would widen a normal install from
  // `...\Programs\Maka` to every application under `...\Programs` (or from
  // `C:\Program Files\Maka` to all of `C:\Program Files`). The executable's
  // own directory contains the DLL/resource substrate it needs and is the
  // narrowest recursive root that works for both installed and ZIP layouts.
  const runtimeRootCandidate =
    platform === 'win32' ? dirname(program) : resolve(dirname(program), '..');
  const runtimeRoot = await resolveReadableRoot(runtimeRootCandidate);
  if (!runtimeRoot) {
    return {
      ok: false,
      reason: 'runtime_executable_unavailable',
      message: 'Filesystem worker runtime root is unavailable.',
    };
  }
  const dependencyRoots = await resolveRuntimeDependencyRoots(program);
  const grep = await resolveRipgrepExecutable(
    input.rgCandidates ?? defaultRipgrepCandidates(input.hostEnv ?? process.env, platform),
    platform,
    input.inspectMacosExecutableDependencies ?? resolveMacosExecutableDependencies,
  );
  const electronFrameworks =
    input.runtime === 'electron' && platform === 'darwin'
      ? await resolveReadableRoot(resolve(dirname(program), '..', 'Frameworks'))
      : undefined;
  if (input.runtime === 'electron' && platform === 'darwin' && !electronFrameworks) {
    return {
      ok: false,
      reason: 'runtime_executable_unavailable',
      message: 'Electron framework roots are unavailable.',
    };
  }
  return {
    ok: true,
    spec: {
      program,
      // --preserve-symlinks-main skips the module loader's realpath of the
      // bundle path. Inside the Windows AppContainer that realpath would
      // lstat every ancestor directory (up to the volume root), which the
      // sandbox grants deliberately do not allow.
      //
      // --no-stdio-init: Electron's run-as-node entry opens the NUL device to
      // backfill missing standard handles before Node starts, and the
      // AppContainer denies that device open, which aborts startup (FATAL
      // node_main.cc "Unable to open nul device"). The broker always relays
      // three valid standard handles into the child, so the backfill is
      // unnecessary; the switch skips it and is consumed before Node's own
      // option parsing.
      args: [
        ...(input.runtime === 'electron' && platform === 'win32' ? ['--no-stdio-init'] : []),
        ...(platform === 'win32' ? ['--preserve-symlinks-main'] : []),
        bundle.path,
        ...(grep ? ['--grep-executable', grep.executable] : []),
      ],
      env: buildFilesystemWorkerEnv(input.runtime, input.hostEnv, input.tmpdir, platform),
      runtimeReadableRoots: unique([
        bundle.path,
        runtimeRoot,
        ...dependencyRoots,
        ...(grep?.runtimeReadableRoots ?? []),
      ]),
      executableRoots: unique([
        program,
        runtimeRoot,
        ...(electronFrameworks ? [electronFrameworks] : []),
        ...dependencyRoots,
        ...(grep ? [grep.executable, ...grep.executableRoots] : []),
      ]),
    },
  };
}

async function resolveRipgrepExecutable(
  candidates: readonly string[],
  platform: NodeJS.Platform,
  inspectMacosExecutableDependencies: (
    executable: string,
  ) => Promise<MacosExecutableDependencyResolution>,
): Promise<
  | {
      executable: string;
      runtimeReadableRoots: readonly string[];
      executableRoots: readonly string[];
    }
  | undefined
> {
  const inspected = new Set<string>();
  for (const candidate of candidates) {
    const executable = await resolveExecutable(candidate);
    if (!executable || inspected.has(executable)) continue;
    inspected.add(executable);
    if (platform !== 'darwin') {
      return { executable, runtimeReadableRoots: [], executableRoots: [] };
    }
    const dependencies = await inspectMacosExecutableDependencies(executable);
    if (!dependencies.ok) continue;
    return {
      executable,
      runtimeReadableRoots: dependencies.runtimeReadableRoots,
      executableRoots: dependencies.executableRoots,
    };
  }
  return undefined;
}

async function resolveExecutable(candidate: string): Promise<string | undefined> {
  if (!candidate || !isAbsolute(candidate)) return undefined;
  try {
    await access(candidate, constants.X_OK);
    return await realpath(candidate);
  } catch {
    return undefined;
  }
}

async function resolveReadableRoot(candidate: string): Promise<string | undefined> {
  try {
    return await realpath(candidate);
  } catch {
    return undefined;
  }
}

function defaultRipgrepCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const executableName = platform === 'win32' ? 'rg.exe' : 'rg';
  return [
    ...(env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, executableName)),
    ...(platform === 'win32' ? [] : ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg']),
  ];
}

async function resolveRuntimeDependencyRoots(program: string): Promise<readonly string[]> {
  const candidates = program.startsWith('/opt/homebrew/')
    ? ['/opt/homebrew/opt', '/opt/homebrew/Cellar']
    : program.startsWith('/usr/local/')
      ? ['/usr/local/opt', '/usr/local/Cellar']
      : [];
  const roots = await Promise.all(candidates.map(resolveReadableRoot));
  return roots.filter((root): root is string => root !== undefined);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
