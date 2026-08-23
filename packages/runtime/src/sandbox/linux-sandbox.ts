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

import { posix } from 'node:path';
import { readdirSync } from 'node:fs';

import type { PermissionProfile } from '@maka/core/permission-profile';

import {
  detectLinuxSandboxCapability,
  LINUX_BWRAP_REQUIRED_NAMESPACE_ARGS,
  type LinuxSandboxCapability,
} from './linux-capability.js';
import type {
  SandboxBackend,
  SandboxCommand,
  SandboxPathContext,
  SandboxTransformRequest,
  SandboxTransformResult,
} from './types.js';

const DEFAULT_READ_ONLY_HOST_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'] as const;

export interface LinuxBubblewrapBackendOptions {
  capability?: LinuxSandboxCapability;
  bwrapPath?: string;
  arch?: NodeJS.Architecture;
  discoverProtectedMetadataPaths?: (input: {
    writableRoots: readonly string[];
    names: readonly string[];
  }) => readonly string[];
}

export interface BuildBubblewrapArgvInput {
  bwrapPath: string;
  command: SandboxCommand;
  protectedMetadataPaths?: readonly string[];
}

interface ResolvedLinuxRoots {
  readableRoots: readonly string[];
  writableRoots: readonly string[];
  tempRoots: readonly string[];
  protectedWritableRoots: readonly string[];
  protectedMetadataNames: readonly string[];
  hasDenyEntries: boolean;
}

export class LinuxBubblewrapBackend implements SandboxBackend {
  readonly type = 'linux' as const;
  private detectedCapability?: LinuxSandboxCapability;

  constructor(private readonly options: LinuxBubblewrapBackendOptions = {}) {}

  isAvailable(platform = process.platform): boolean {
    if (!this.capability(platform).available) return false;
    try {
      networkSyscalls(this.options.arch ?? process.arch);
      return true;
    } catch {
      return false;
    }
  }

  canEnforceProfile(profile: PermissionProfile): boolean {
    if (profile.type !== 'managed' || profile.fileSystem.kind !== 'restricted') return false;
    if (profile.fileSystem.entries.some((entry) => entry.access === 'deny')) return false;
    if (networkRestricted(profile)) {
      try {
        networkSyscalls(this.options.arch ?? process.arch);
      } catch {
        return false;
      }
    }
    return true;
  }

  transform(request: SandboxTransformRequest): SandboxTransformResult {
    const { command } = request;
    const preference = request.preference ?? 'auto';
    const platform = request.platform ?? process.platform;

    if (command.profile.type !== 'managed' || command.profile.fileSystem.kind !== 'restricted') {
      return failure(
        'invalid_request',
        'Linux bubblewrap backend only accepts managed restricted profiles.',
        platform,
        preference,
      );
    }

    const roots = resolveRoots(command.profile, command.pathContext);
    if (roots.hasDenyEntries) {
      return failure(
        'invalid_request',
        'Linux sandbox deny entries are not supported by the bubblewrap backend.',
        platform,
        preference,
      );
    }
    const capability = this.capability(platform);
    if (!capability.available) {
      return failure(
        'backend_not_available',
        `Linux bubblewrap sandbox is not available (${capability.reason}).`,
        platform,
        preference,
      );
    }

    let seccompFilter: Uint8Array | undefined;
    if (networkRestricted(command.profile)) {
      try {
        seccompFilter = buildNetworkSeccompFilter(this.options.arch ?? process.arch);
      } catch (error) {
        return failure(
          'backend_not_available',
          error instanceof Error ? error.message : String(error),
          platform,
          preference,
        );
      }
    }

    let nestedProtectedPaths: readonly string[];
    try {
      nestedProtectedPaths = (
        this.options.discoverProtectedMetadataPaths ?? discoverNestedProtectedMetadataPaths
      )({
        writableRoots: roots.protectedWritableRoots,
        names: roots.protectedMetadataNames,
      });
    } catch (error) {
      return failure(
        'invalid_request',
        `Unable to enumerate protected metadata: ${error instanceof Error ? error.message : String(error)}`,
        platform,
        preference,
      );
    }

    const pinnedFdInputs = command.pathContext.pinnedProfilePaths?.map(
      ({ fd, sourceFd, releaseSource }) => ({
        fd,
        sourceFd,
        ...(releaseSource ? { releaseSource } : {}),
      }),
    );
    const pinnedRuntimeWritableFdInputs = command.pathContext.pinnedRuntimeWritableRoots?.map(
      ({ fd, sourceFd, releaseSource }) => ({
        fd,
        sourceFd,
        ...(releaseSource ? { releaseSource } : {}),
      }),
    );
    const fdInputs = [
      ...(seccompFilter ? [{ fd: 3, data: seccompFilter }] : []),
      ...(pinnedFdInputs ?? []),
      ...(pinnedRuntimeWritableFdInputs ?? []),
    ];
    return {
      ok: true,
      exec: {
        argv: buildBubblewrapArgv({
          bwrapPath: capability.bwrapPath,
          command,
          protectedMetadataPaths: nestedProtectedPaths,
        }),
        ...(fdInputs.length > 0 ? { fdInputs } : {}),
        cwd: command.cwd,
        env: command.env,
        sandboxType: 'linux',
        effectiveProfile: command.profile,
      },
      sandboxType: 'linux',
      requiresSandbox: true,
      preference,
    };
  }

  private capability(platform: string): LinuxSandboxCapability {
    if (this.options.capability) return this.options.capability;
    if (this.detectedCapability) return this.detectedCapability;
    this.detectedCapability = detectLinuxSandboxCapability({
      platform,
      ...(this.options.bwrapPath ? { bwrapPath: this.options.bwrapPath } : {}),
    });
    return this.detectedCapability;
  }
}

function exactProfileRoots(
  profile: PermissionProfile,
  access: 'read' | 'write',
): ReadonlySet<string> {
  if (profile.type !== 'managed' || profile.fileSystem.kind !== 'restricted') return new Set();
  return new Set(
    profile.fileSystem.entries.flatMap((entry) =>
      entry.kind === 'path' && entry.access === access && (entry.match ?? 'subtree') === 'exact'
        ? [entry.path]
        : [],
    ),
  );
}

export function buildBubblewrapArgv(input: BuildBubblewrapArgvInput): readonly string[] {
  const { command } = input;
  const roots = resolveRoots(command.profile, command.pathContext);
  if (roots.hasDenyEntries) {
    throw new Error('Linux sandbox deny entries are not supported by the bubblewrap backend.');
  }

  const argv: string[] = [
    input.bwrapPath,
    '--die-with-parent',
    '--new-session',
    ...LINUX_BWRAP_REQUIRED_NAMESPACE_ARGS,
    '--proc',
    '/proc',
    '--dev',
    '/dev',
  ];

  if (networkRestricted(command.profile)) {
    argv.push('--unshare-net', '--seccomp', '3');
  }

  for (const path of DEFAULT_READ_ONLY_HOST_PATHS) {
    argv.push('--ro-bind-try', path, path);
  }

  const runtimeWritableRoots = removeNestedRoots(
    (command.pathContext.runtimeWritableRoots ?? []).filter(isUsableRuntimeRoot),
  );
  const unavailableProfilePaths = new Set(command.pathContext.unavailableProfilePaths ?? []);
  const pinnedRuntimeWritableRoots = new Map(
    (command.pathContext.pinnedRuntimeWritableRoots ?? []).map(
      (entry) => [entry.path, entry] as const,
    ),
  );
  const profileReadableRoots = removeRootsCoveredBy(
    roots.readableRoots,
    runtimeWritableRoots,
  ).filter((root) => !unavailableProfilePaths.has(root));
  const profileWritableRoots = removeRootsCoveredBy(
    roots.writableRoots,
    runtimeWritableRoots,
  ).filter((root) => !unavailableProfilePaths.has(root));
  const exactReadableRoots = exactProfileRoots(command.profile, 'read');
  const exactWritableRoots = exactProfileRoots(command.profile, 'write');
  const pinnedProfilePaths = new Map(
    (command.pathContext.pinnedProfilePaths ?? []).map((entry) => [entry.path, entry] as const),
  );
  for (const entry of pinnedProfilePaths.values()) {
    const effectiveRoots = entry.access === 'write' ? profileWritableRoots : profileReadableRoots;
    if (!effectiveRoots.includes(entry.path)) {
      throw new Error(
        `Pinned profile path is not an effective ${entry.access} root: ${entry.path}`,
      );
    }
    if (
      !Number.isInteger(entry.fd) ||
      entry.fd < 3 ||
      !Number.isInteger(entry.sourceFd) ||
      entry.sourceFd < 0
    ) {
      throw new Error(`Pinned writable file has invalid descriptors: ${entry.path}`);
    }
  }
  const requiredRuntimeRoots = removeNestedRoots(
    [
      ...(command.pathContext.runtimeReadableRoots ?? []),
      ...(command.pathContext.executableRoots ?? []),
    ].filter(isUsableRuntimeRoot),
  );
  const requiredRuntimeMounts = removeRootsCoveredBy(requiredRuntimeRoots, [
    ...DEFAULT_READ_ONLY_HOST_PATHS,
    ...profileReadableRoots,
    ...profileWritableRoots,
    ...runtimeWritableRoots,
  ]);
  const programDirectory = absoluteProgramDirectory(command.program);
  const profileCoverage = [
    ...DEFAULT_READ_ONLY_HOST_PATHS,
    ...profileReadableRoots,
    ...profileWritableRoots,
    ...requiredRuntimeMounts,
    ...runtimeWritableRoots,
  ];
  const needsSyntheticCwd = !isCoveredByAnyRoot(command.cwd, profileCoverage);
  const extraProgramDirectories =
    programDirectory && !isCoveredByAnyRoot(programDirectory, profileCoverage)
      ? [programDirectory]
      : [];
  const extraRuntimeRoots = removeNestedRoots(
    (command.pathContext.minimalRoots ?? [])
      .filter(isUsableRuntimeRoot)
      .filter((root) => !isCoveredByAnyRoot(root, profileCoverage)),
  );
  const mountRoots = uniqueRoots([
    ...extraProgramDirectories,
    ...extraRuntimeRoots,
    ...requiredRuntimeMounts,
    ...runtimeWritableRoots,
    ...roots.tempRoots,
    ...profileReadableRoots,
    ...profileWritableRoots,
  ]);
  for (const directory of requiredParentDirectories(mountRoots)) {
    argv.push('--dir', directory);
  }

  for (const directory of extraProgramDirectories) {
    argv.push('--ro-bind', directory, directory);
  }
  for (const directory of extraRuntimeRoots) {
    argv.push('--ro-bind-try', directory, directory);
  }
  for (const root of requiredRuntimeMounts) argv.push('--ro-bind', root, root);
  for (const root of runtimeWritableRoots) {
    const pinned = pinnedRuntimeWritableRoots.get(root);
    argv.push('--bind', pinned ? `/proc/self/fd/${pinned.fd}` : root, root);
  }
  for (const root of roots.tempRoots) argv.push('--tmpfs', root);
  if (needsSyntheticCwd) {
    for (const directory of requiredParentDirectories([command.cwd])) {
      argv.push('--dir', directory);
    }
    argv.push('--dir', command.cwd);
  }
  for (const root of profileReadableRoots) {
    const pinned = pinnedProfilePaths.get(root);
    if (exactReadableRoots.has(root) && !pinned) continue;
    argv.push('--ro-bind', pinned ? `/proc/self/fd/${pinned.fd}` : root, root);
  }
  for (const root of profileWritableRoots) {
    const pinned = pinnedProfilePaths.get(root);
    if (exactWritableRoots.has(root) && !pinned) continue;
    argv.push('--bind', pinned ? `/proc/self/fd/${pinned.fd}` : root, root);
  }

  for (const root of roots.protectedWritableRoots) {
    for (const name of roots.protectedMetadataNames) {
      const protectedPath = posix.join(root, name);
      argv.push('--ro-bind-try', protectedPath, protectedPath);
    }
  }
  for (const path of input.protectedMetadataPaths ?? []) {
    argv.push('--ro-bind', path, path);
  }

  argv.push('--chdir', command.cwd, '--', command.program, ...command.args);
  return argv;
}

/**
 * Build a compiled classic-BPF seccomp program for bubblewrap's `--seccomp FD`.
 * The filter validates the audit architecture, then denies socket creation.
 * Network-restricted sandboxes receive no inherited network descriptors, so
 * blocking socket prevents opening a new network channel. `socketpair` stays
 * available because Node uses local pairs while spawning the trusted Grep
 * helper; the separate network namespace prevents those pairs reaching the
 * host network.
 */
export function buildNetworkSeccompFilter(arch: NodeJS.Architecture = process.arch): Uint8Array {
  const syscall = networkSyscalls(arch);
  const instructions: ReadonlyArray<
    readonly [code: number, jt: number, jf: number, value: number]
  > = [
    [0x20, 0, 0, 4],
    [0x15, 1, 0, syscall.auditArch],
    [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0],
    [0x15, 0, 1, syscall.socket],
    [0x06, 0, 0, 0x00050001],
    [0x06, 0, 0, 0x7fff0000],
  ];
  const output = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, value], index) => {
    const offset = index * 8;
    output.writeUInt16LE(code, offset);
    output.writeUInt8(jt, offset + 2);
    output.writeUInt8(jf, offset + 3);
    output.writeUInt32LE(value >>> 0, offset + 4);
  });
  return output;
}

function networkSyscalls(arch: NodeJS.Architecture): {
  auditArch: number;
  socket: number;
} {
  switch (arch) {
    case 'x64':
      return { auditArch: 0xc000003e, socket: 41 };
    case 'arm64':
      return { auditArch: 0xc00000b7, socket: 198 };
    default:
      throw new Error(`Linux seccomp network filter: unsupported architecture ${arch}`);
  }
}

function failure(
  reason: 'backend_not_available' | 'invalid_request',
  message: string,
  platform: string,
  preference: 'auto' | 'require' | 'forbid',
): SandboxTransformResult {
  return {
    ok: false,
    reason,
    sandboxType: 'linux',
    requiresSandbox: true,
    platform,
    preference,
    message,
  };
}

function resolveRoots(profile: PermissionProfile, context: SandboxPathContext): ResolvedLinuxRoots {
  if (profile.type !== 'managed' || profile.fileSystem.kind !== 'restricted') {
    return {
      readableRoots: [],
      writableRoots: [],
      tempRoots: [],
      protectedWritableRoots: [],
      protectedMetadataNames: [],
      hasDenyEntries: false,
    };
  }

  const readableRoots: string[] = [];
  const writableRoots: string[] = [];
  const tempRoots: string[] = [];
  const protectedWritableRoots: string[] = [];
  let hasDenyEntries = false;

  for (const entry of profile.fileSystem.entries) {
    if (entry.access === 'deny') {
      hasDenyEntries = true;
      continue;
    }

    const roots = rootsForEntry(entry, context);
    const isTemp =
      entry.kind === 'special' && (entry.special === ':tmpdir' || entry.special === ':slash_tmp');

    if (entry.access === 'write' && isTemp) {
      addUnique(tempRoots, roots);
      continue;
    }
    if (entry.access === 'write') {
      addUnique(writableRoots, roots);
      if (entry.kind === 'special' && entry.special === ':workspace_roots') {
        addUnique(protectedWritableRoots, roots);
      }
      continue;
    }
    addUnique(readableRoots, roots);
  }

  return {
    readableRoots: removeCoveredRoots(readableRoots, writableRoots),
    writableRoots,
    tempRoots,
    protectedWritableRoots: profile.fileSystem.protectedMetadata ? protectedWritableRoots : [],
    protectedMetadataNames: profile.fileSystem.protectedMetadata?.names ?? [],
    hasDenyEntries,
  };
}

type ProfileEntry = Extract<
  PermissionProfile,
  { type: 'managed' }
>['fileSystem']['entries'][number];

function rootsForEntry(entry: ProfileEntry, context: SandboxPathContext): readonly string[] {
  if (entry.kind === 'path') return [entry.path];
  switch (entry.special) {
    case ':root':
      return ['/'];
    case ':workspace_roots':
      return context.workspaceRoots;
    case ':tmpdir':
      return context.tmpdir ? [context.tmpdir] : [];
    case ':slash_tmp':
      return [context.slashTmp ?? '/tmp'];
    case ':minimal':
      return context.minimalRoots ?? [];
  }
}

function networkRestricted(profile: PermissionProfile): boolean {
  return profile.type !== 'managed' || profile.network.kind === 'restricted';
}

function addUnique(target: string[], roots: readonly string[]): void {
  for (const root of roots) {
    if (!target.includes(root)) target.push(root);
  }
}

function uniqueRoots(roots: readonly string[]): readonly string[] {
  return [...new Set(roots)];
}

function absoluteProgramDirectory(program: string): string | undefined {
  return posix.isAbsolute(program) ? posix.dirname(program) : undefined;
}

export function linuxExecutableRoots(input: {
  execPath: string;
  path?: string;
}): readonly string[] {
  const roots: string[] = [];
  if (posix.isAbsolute(input.execPath)) {
    const executableDirectory = posix.dirname(posix.normalize(input.execPath));
    roots.push(
      posix.basename(executableDirectory) === 'bin'
        ? posix.dirname(executableDirectory)
        : executableDirectory,
    );
  }
  for (const entry of input.path?.split(':') ?? []) {
    if (posix.isAbsolute(entry) && posix.normalize(entry) !== '/') {
      roots.push(posix.normalize(entry));
    }
  }
  return removeNestedRoots(roots);
}

function isCoveredByAnyRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const relative = posix.relative(root, path);
    return relative === '' || (relative !== '..' && !relative.startsWith('../'));
  });
}

function isUsableRuntimeRoot(root: string): boolean {
  return posix.isAbsolute(root) && posix.normalize(root) !== '/';
}

function removeRootsCoveredBy(
  roots: readonly string[],
  covering: readonly string[],
): readonly string[] {
  return roots.filter((root) => !isCoveredByAnyRoot(root, covering));
}

function removeCoveredRoots(
  roots: readonly string[],
  covering: readonly string[],
): readonly string[] {
  return roots.filter((root) => !covering.includes(root));
}

function removeNestedRoots(roots: readonly string[]): readonly string[] {
  const unique = [...new Set(roots.map((root) => posix.normalize(root)))];
  return unique.filter(
    (root) =>
      !unique.some((candidate) => candidate !== root && isCoveredByAnyRoot(root, [candidate])),
  );
}

function requiredParentDirectories(roots: readonly string[]): readonly string[] {
  const parents = new Set<string>();
  for (const root of roots) {
    let current = posix.dirname(root);
    while (current !== '/' && current !== '.') {
      parents.add(current);
      current = posix.dirname(current);
    }
  }
  return [...parents].sort((left, right) => left.length - right.length);
}

const MAX_PROTECTED_SCAN_ENTRIES = 100_000;
const MAX_PROTECTED_SCAN_DEPTH = 64;

export function discoverNestedProtectedMetadataPaths(input: {
  writableRoots: readonly string[];
  names: readonly string[];
}): readonly string[] {
  const found: string[] = [];
  let visited = 0;

  for (const root of input.writableRoots) {
    walk(root, 0, true);
  }
  return found;

  function walk(directory: string, depth: number, isRoot: boolean): void {
    if (depth > MAX_PROTECTED_SCAN_DEPTH) {
      throw new Error(`protected metadata scan exceeded depth ${MAX_PROTECTED_SCAN_DEPTH}`);
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (isRoot && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_PROTECTED_SCAN_ENTRIES) {
        throw new Error(`protected metadata scan exceeded ${MAX_PROTECTED_SCAN_ENTRIES} entries`);
      }
      const path = posix.join(directory, entry.name);
      if (input.names.includes(entry.name)) {
        if (!isRoot) found.push(path);
        continue;
      }
      if (entry.isDirectory()) walk(path, depth + 1, false);
    }
  }
}
