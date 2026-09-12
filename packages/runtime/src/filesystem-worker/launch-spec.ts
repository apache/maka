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
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  resolveFilesystemWorkerBundle,
  type FilesystemWorkerResourceLocation,
} from './resource-resolver.js';
import {
  resolveMacosExecutableDependencies,
  type MacosExecutableDependencyResolution,
} from './macos-executable-dependencies.js';
import {
  currentRipgrepEnvironment,
  formatRipgrepEnvironmentArg,
  type RipgrepEnvironment,
} from '../ripgrep-guidance.js';

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
  const platform = input.platform ?? process.platform;
  let base: Promise<LaunchBaseResult> | undefined;
  let ripgrep: Promise<RipgrepResolution | undefined> | undefined;
  // Mach-O inspection runs otool, so its result is kept per executable and
  // file identity: an unchanged binary is inspected once, whether it was
  // granted or refused, however often launches look for ripgrep again.
  const inspections = new Map<string, MacosInspectionRecord>();
  const resolveRipgrep = () =>
    resolveRipgrepExecutable(
      input.rgCandidates ?? defaultRipgrepCandidates(input.hostEnv ?? process.env, platform),
      platform,
      input.inspectMacosExecutableDependencies ?? resolveMacosExecutableDependencies,
      inspections,
    );
  // A resolved ripgrep stays cached while the same file is still there. A
  // missing one, or one whose file has since disappeared or changed (a package
  // upgrade removes the old keg; a reinstall in place can change its
  // libraries), is looked up again on the next launch, with the same
  // executable and dependency-root validation as the first lookup: installing
  // ripgrep where the Host runs and retrying recovers without restarting the
  // Host, and the sandbox only ever grants the copy found.
  const currentRipgrep = async (): Promise<RipgrepResolution | undefined> => {
    const known = (ripgrep ??= resolveRipgrep());
    const resolved = await known;
    if (resolved && (await fileIdentity(resolved.executable)) === resolved.identity)
      return resolved;
    // Concurrent launches share one fresh lookup.
    if (ripgrep === known) ripgrep = resolveRipgrep();
    return await ripgrep;
  };
  return async () => {
    const resolved = await (base ??= resolveLaunchBase(input, platform));
    if (!resolved.ok) return resolved;
    return { ok: true, spec: composeLaunchSpec(resolved.base, await currentRipgrep()) };
  };
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

interface RipgrepResolution {
  readonly executable: string;
  /** The file that was validated; a different file at the same path is looked up again. */
  readonly identity: string;
  readonly runtimeReadableRoots: readonly string[];
  readonly executableRoots: readonly string[];
}

interface MacosInspectionRecord {
  readonly identity: string;
  readonly result: MacosExecutableDependencyResolution;
}

/** Everything in a launch that does not depend on ripgrep; resolved once. */
interface LaunchBase {
  readonly runtime: 'node' | 'electron';
  readonly platform: NodeJS.Platform;
  readonly program: string;
  readonly bundlePath: string;
  readonly runtimeRoot: string;
  readonly dependencyRoots: readonly string[];
  readonly electronFrameworks?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly environment?: RipgrepEnvironment;
}

type LaunchBaseResult =
  | { ok: true; base: LaunchBase }
  | Extract<FilesystemWorkerLaunchSpecResult, { ok: false }>;

async function resolveLaunchBase(
  input: CreateFilesystemWorkerLaunchSpecProviderInput,
  platform: NodeJS.Platform,
): Promise<LaunchBaseResult> {
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
  const environment = currentRipgrepEnvironment(input.hostEnv ?? process.env);
  return {
    ok: true,
    base: {
      runtime: input.runtime,
      platform,
      program,
      bundlePath: bundle.path,
      runtimeRoot,
      dependencyRoots,
      ...(electronFrameworks ? { electronFrameworks } : {}),
      env: buildFilesystemWorkerEnv(input.runtime, input.hostEnv, input.tmpdir, platform),
      ...(environment ? { environment } : {}),
    },
  };
}

function composeLaunchSpec(
  base: LaunchBase,
  grep: RipgrepResolution | undefined,
): FilesystemWorkerLaunchSpec {
  return {
    program: base.program,
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
      ...(base.runtime === 'electron' && base.platform === 'win32' ? ['--no-stdio-init'] : []),
      ...(base.platform === 'win32' ? ['--preserve-symlinks-main'] : []),
      base.bundlePath,
      ...(base.environment
        ? ['--ripgrep-environment', formatRipgrepEnvironmentArg(base.environment)]
        : []),
      ...(grep ? ['--grep-executable', grep.executable] : []),
    ],
    env: base.env,
    runtimeReadableRoots: unique([
      base.bundlePath,
      base.runtimeRoot,
      ...base.dependencyRoots,
      ...(grep?.runtimeReadableRoots ?? []),
    ]),
    executableRoots: unique([
      base.program,
      base.runtimeRoot,
      ...(base.electronFrameworks ? [base.electronFrameworks] : []),
      ...base.dependencyRoots,
      ...(grep ? [grep.executable, ...grep.executableRoots] : []),
    ]),
  };
}

async function resolveRipgrepExecutable(
  candidates: readonly string[],
  platform: NodeJS.Platform,
  inspectMacosExecutableDependencies: (
    executable: string,
  ) => Promise<MacosExecutableDependencyResolution>,
  inspections: Map<string, MacosInspectionRecord>,
): Promise<RipgrepResolution | undefined> {
  const inspected = new Set<string>();
  for (const candidate of candidates) {
    const executable = await resolveExecutable(candidate);
    if (!executable || inspected.has(executable)) continue;
    inspected.add(executable);
    const identity = await fileIdentity(executable);
    if (!identity) continue;
    if (platform !== 'darwin') {
      return { executable, identity, runtimeReadableRoots: [], executableRoots: [] };
    }
    const known = inspections.get(executable);
    const inspection =
      known && known.identity === identity
        ? known
        : { identity, result: await inspectMacosExecutableDependencies(executable) };
    inspections.set(executable, inspection);
    const dependencies = inspection.result;
    if (!dependencies.ok) continue;
    return {
      executable,
      identity,
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

async function fileIdentity(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.mode}`;
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
    // winget links portable packages here and adds the directory to PATH for
    // processes started afterwards; a running Host still has the old PATH, so
    // look here too or "install, then retry" would not find the install.
    ...(platform === 'win32' && env.LOCALAPPDATA
      ? [join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', executableName)]
      : []),
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
