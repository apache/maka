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

import type { PermissionProfile } from '@maka/core/permission-profile';

import type {
  SandboxBackend,
  SandboxPathContext,
  SandboxTransformRequest,
  SandboxTransformResult,
} from './types.js';

export const MACOS_SEATBELT_EXECUTABLE = '/usr/bin/sandbox-exec';

export const MACOS_SEATBELT_BASE_POLICY = `(version 1)
(deny default)

(allow process*)
(allow signal (target same-sandbox))
(allow sysctl*)
(allow file-read-metadata)
(allow file-read*
  (subpath "/System")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/Library/Apple")
  (literal "/dev/null")
  (literal "/dev/zero"))`;

export const MACOS_SEATBELT_PLATFORM_DEFAULTS_POLICY = `; macOS platform defaults for launching standard system tools.
(allow file-read* file-test-existence
  (subpath "/Library/Apple")
  (subpath "/Library/Filesystems/NetFSPlugins")
  (subpath "/Library/Preferences")
  (subpath "/Library/Preferences/Logging")
  (subpath "/private/var/db")
  (subpath "/private/var/db/DarwinDirectory/local/recordStore.data")
  (subpath "/private/var/db/timezone")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/var/db"))

(allow file-map-executable
  (subpath "/Library/Apple/System/Library/Frameworks")
  (subpath "/Library/Apple/System/Library/PrivateFrameworks")
  (subpath "/Library/Apple/usr/lib")
  (subpath "/System/Library/Extensions")
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/SubFrameworks")
  (subpath "/System/iOSSupport/System/Library/Frameworks")
  (subpath "/System/iOSSupport/System/Library/PrivateFrameworks")
  (subpath "/System/iOSSupport/System/Library/SubFrameworks")
  (subpath "/usr/lib"))

(allow file-read* file-test-existence
  (subpath "/Library/Apple/System/Library/Frameworks")
  (subpath "/Library/Apple/System/Library/PrivateFrameworks")
  (subpath "/Library/Apple/usr/lib")
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/SubFrameworks")
  (subpath "/System/iOSSupport/System/Library/Frameworks")
  (subpath "/System/iOSSupport/System/Library/PrivateFrameworks")
  (subpath "/System/iOSSupport/System/Library/SubFrameworks")
  (subpath "/usr/lib"))

(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall
  (require-all
    (mac-policy-name "Sandbox")
    (mac-syscall-number 67)))

(allow file-read-metadata file-test-existence
  (literal "/etc")
  (literal "/tmp")
  (literal "/var")
  (literal "/private/etc/localtime"))

(allow file-read-metadata file-test-existence
  (path-ancestors "/System/Volumes/Data/private"))

(allow file-read* file-test-existence
  (literal "/"))

(allow system-fsctl (fsctl-command FSIOC_CAS_BSDFLAGS))

(allow file-read* file-test-existence
  (literal "/dev/autofs_nowait")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/private/etc/master.passwd")
  (literal "/private/etc/passwd")
  (literal "/private/etc/protocols")
  (literal "/private/etc/services"))

(allow file-read* file-test-existence file-write-data
  (literal "/dev/null")
  (literal "/dev/zero"))

(allow file-read-data file-test-existence file-write-data
  (subpath "/dev/fd"))

(allow file-read* file-test-existence file-write-data file-ioctl
  (literal "/dev/dtracehelper"))

(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "/private/etc"))

(allow file-read* file-test-existence
  (literal "/System/Library/CoreServices")
  (literal "/System/Library/CoreServices/.SystemVersionPlatform.plist")
  (literal "/System/Library/CoreServices/SystemVersion.plist"))

(allow file-read-metadata (subpath "/var"))
(allow file-read-metadata (subpath "/private/var"))

(allow mach-lookup
  (global-name "com.apple.analyticsd")
  (global-name "com.apple.analyticsd.messagetracer")
  (global-name "com.apple.appsleep")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.dt.automationmode.reader")
  (global-name "com.apple.espd")
  (global-name "com.apple.logd")
  (global-name "com.apple.logd.events")
  (global-name "com.apple.runningboard")
  (global-name "com.apple.secinitd")
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.xpc.activity.unmanaged")
  (local-name "com.apple.cfprefsd.agent"))

(allow ipc-posix-shm-read*
  (ipc-posix-name "apple.shm.notification_center"))

(allow file-read*
  (literal "/private/var/db/eligibilityd/eligibility.plist"))

(allow mach-lookup (global-name "com.apple.audio.audiohald"))
(allow mach-lookup (global-name "com.apple.audio.AudioComponentRegistrar"))

(allow file-read-data (subpath "/bin"))
(allow file-read-metadata (subpath "/bin"))
(allow file-read-data (subpath "/sbin"))
(allow file-read-metadata (subpath "/sbin"))
(allow file-read-data (subpath "/usr/bin"))
(allow file-read-metadata (subpath "/usr/bin"))
(allow file-read-data (subpath "/usr/sbin"))
(allow file-read-metadata (subpath "/usr/sbin"))
(allow file-read-data (subpath "/usr/libexec"))
(allow file-read-metadata (subpath "/usr/libexec"))

(allow file-read* (subpath "/opt/homebrew/lib"))
(allow file-read* (subpath "/usr/local/lib"))

(allow file-read* (regex "^/dev/fd/(0|1|2)$"))
(allow file-write* (regex "^/dev/fd/(1|2)$"))
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read* file-write* (literal "/dev/tty"))
(allow file-read-metadata (literal "/dev"))
(allow file-read-metadata (regex "^/dev/.*$"))
(allow file-read-metadata (literal "/dev/stdin"))
(allow file-read-metadata (literal "/dev/stdout"))
(allow file-read-metadata (literal "/dev/stderr"))
(allow file-read-metadata (regex "^/dev/tty[^/]*$"))
(allow file-read-metadata (regex "^/dev/pty[^/]*$"))
(allow file-read* file-write* (regex "^/dev/ttys[0-9]+$"))
(allow file-read* file-write* (literal "/dev/ptmx"))
(allow file-ioctl (regex "^/dev/ttys[0-9]+$"))

(allow file-read-metadata (literal "/System/Volumes") (vnode-type DIRECTORY))
(allow file-read-metadata (literal "/System/Volumes/Data") (vnode-type DIRECTORY))
(allow file-read-metadata (literal "/System/Volumes/Data/Users") (vnode-type DIRECTORY))

(allow file-read* (extension "com.apple.app-sandbox.read"))
(allow file-read* file-write* (extension "com.apple.app-sandbox.read-write"))`;

export interface BuildSeatbeltPolicyInput {
  profile: PermissionProfile;
  pathContext: SandboxPathContext;
}

export interface BuildSeatbeltPolicyResult {
  policy: string;
  definitionArgs: readonly string[];
}

export interface CreateSeatbeltExecArgsInput extends BuildSeatbeltPolicyInput {
  innerArgv: readonly string[];
}

interface ResolvedRoots {
  readableRoots: readonly ResolvedRoot[];
  writableRoots: readonly ResolvedRoot[];
  deniedRoots: readonly ResolvedRoot[];
  protectedWritableRoots: readonly string[];
  protectedMetadataNames: readonly string[];
  runtimeReadableRoots: readonly string[];
  executableRoots: readonly string[];
}

interface ResolvedRoot {
  path: string;
  match: 'exact' | 'subtree';
}

export function escapeSeatbeltRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

export function buildSeatbeltPolicy(input: BuildSeatbeltPolicyInput): BuildSeatbeltPolicyResult {
  const roots = resolveRoots(input.profile, input.pathContext);
  const definitionArgs = [
    ...roots.readableRoots.map((root, index) => `-DREADABLE_ROOT_${index}=${root.path}`),
    ...roots.writableRoots.map((root, index) => `-DWRITABLE_ROOT_${index}=${root.path}`),
    ...roots.runtimeReadableRoots.map((root, index) => `-DRUNTIME_READABLE_ROOT_${index}=${root}`),
    ...roots.executableRoots.map((root, index) => `-DEXECUTABLE_ROOT_${index}=${root}`),
  ];

  const sections = [
    MACOS_SEATBELT_BASE_POLICY,
    MACOS_SEATBELT_PLATFORM_DEFAULTS_POLICY,
    buildReadableRootsPolicy(roots),
    buildWritableRootsPolicy(roots),
    buildRuntimeRootsPolicy(roots),
    buildNetworkPolicy(input.profile),
  ].filter(Boolean);

  return {
    policy: `${sections.join('\n\n')}\n`,
    definitionArgs,
  };
}

export function createSeatbeltExecArgs(input: CreateSeatbeltExecArgsInput): readonly string[] {
  const { policy, definitionArgs } = buildSeatbeltPolicy(input);
  return ['-p', policy, ...definitionArgs, '--', ...input.innerArgv];
}

export class MacosSeatbeltBackend implements SandboxBackend {
  readonly type = 'macos-seatbelt' as const;

  transform(request: SandboxTransformRequest): SandboxTransformResult {
    const { command } = request;
    const preference = request.preference ?? 'auto';
    const platform = request.platform ?? process.platform;

    if (command.profile.type !== 'managed' || command.profile.fileSystem.kind !== 'restricted') {
      return {
        ok: false,
        reason: 'invalid_request',
        sandboxType: 'macos-seatbelt',
        requiresSandbox: true,
        platform,
        preference,
        message: 'macOS Seatbelt backend only accepts managed restricted profiles.',
      };
    }

    const sandboxArgs = createSeatbeltExecArgs({
      profile: command.profile,
      pathContext: command.pathContext,
      innerArgv: [command.program, ...command.args],
    });

    return {
      ok: true,
      exec: {
        argv: [MACOS_SEATBELT_EXECUTABLE, ...sandboxArgs],
        cwd: command.cwd,
        env: command.env,
        sandboxType: 'macos-seatbelt',
        effectiveProfile: command.profile,
      },
      sandboxType: 'macos-seatbelt',
      requiresSandbox: true,
      preference,
    };
  }
}

function resolveRoots(profile: PermissionProfile, pathContext: SandboxPathContext): ResolvedRoots {
  if (profile.type !== 'managed' || profile.fileSystem.kind !== 'restricted') {
    return {
      readableRoots: [],
      writableRoots: [],
      deniedRoots: [],
      protectedWritableRoots: [],
      protectedMetadataNames: [],
      runtimeReadableRoots: [],
      executableRoots: [],
    };
  }

  const readableRoots: ResolvedRoot[] = [];
  const writableRoots: ResolvedRoot[] = [];
  const deniedRoots: ResolvedRoot[] = [];
  const protectedWritableRoots: string[] = [];

  for (const entry of profile.fileSystem.entries) {
    const roots = rootsForEntry(entry, pathContext);
    if (entry.access === 'deny') {
      addUniqueResolvedRoots(deniedRoots, roots);
      continue;
    }

    if (entry.access === 'read' || entry.access === 'write') {
      addUniqueResolvedRoots(readableRoots, roots);
    }
    if (entry.access === 'write') {
      addUniqueResolvedRoots(writableRoots, roots);
      if (entry.kind === 'special' && entry.special === ':workspace_roots') {
        addUniqueRoots(
          protectedWritableRoots,
          roots.map((root) => root.path),
        );
      }
    }
  }

  return {
    readableRoots,
    writableRoots,
    deniedRoots,
    protectedWritableRoots:
      profile.fileSystem.protectedMetadata && writableRoots.length > 0
        ? uniqueRoots([...protectedWritableRoots, ...pathContext.workspaceRoots])
        : [],
    protectedMetadataNames: profile.fileSystem.protectedMetadata?.names ?? [],
    runtimeReadableRoots: uniqueRoots(pathContext.runtimeReadableRoots ?? []),
    executableRoots: uniqueRoots(pathContext.executableRoots ?? []),
  };
}

function rootsForEntry(
  entry: PermissionProfileManagedEntry,
  pathContext: SandboxPathContext,
): readonly ResolvedRoot[] {
  if (entry.kind === 'path') {
    return [{ path: entry.path, match: entry.match ?? 'subtree' }];
  }

  switch (entry.special) {
    case ':root':
      return [{ path: '/', match: 'subtree' }];
    case ':workspace_roots':
      return pathContext.workspaceRoots.map((path) => ({ path, match: 'subtree' as const }));
    case ':tmpdir':
      return pathContext.tmpdir ? [{ path: pathContext.tmpdir, match: 'subtree' }] : [];
    case ':slash_tmp':
      return [{ path: pathContext.slashTmp ?? '/tmp', match: 'subtree' }];
    case ':minimal':
      return (pathContext.minimalRoots ?? []).map((path) => ({ path, match: 'subtree' as const }));
  }
}

function addUniqueResolvedRoots(target: ResolvedRoot[], roots: readonly ResolvedRoot[]): void {
  for (const root of roots) {
    if (!target.some((existing) => existing.path === root.path && existing.match === root.match)) {
      target.push(root);
    }
  }
}

function addUniqueRoots(target: string[], roots: readonly string[]): void {
  for (const root of roots) {
    if (!target.includes(root)) target.push(root);
  }
}

function uniqueRoots(roots: readonly string[]): readonly string[] {
  const unique: string[] = [];
  addUniqueRoots(unique, roots);
  return unique;
}

function buildReadableRootsPolicy(roots: ResolvedRoots): string {
  if (roots.readableRoots.length === 0) return '';

  const denyRequirements = deniedRootRequirements(roots.deniedRoots);
  const params = roots.readableRoots
    .map((root, index) =>
      accessRootClause(seatbeltPathClause(root, `READABLE_ROOT_${index}`), denyRequirements),
    )
    .join('\n');
  return `(allow file-read*\n${params})`;
}

function buildWritableRootsPolicy(roots: ResolvedRoots): string {
  if (roots.writableRoots.length === 0) return '';

  const params = roots.writableRoots
    .map((root, index) => writableRootClause(root, index, roots))
    .join('\n');
  return `(allow file-write*\n${params})`;
}

function buildRuntimeRootsPolicy(roots: ResolvedRoots): string {
  const sections: string[] = [];
  if (roots.runtimeReadableRoots.length > 0) {
    const clauses = roots.runtimeReadableRoots
      .map((_, index) => `  (subpath (param "RUNTIME_READABLE_ROOT_${index}"))`)
      .join('\n');
    sections.push(`(allow file-read* file-test-existence\n${clauses})`);
  }
  if (roots.executableRoots.length > 0) {
    const clauses = roots.executableRoots
      .map((_, index) => `  (subpath (param "EXECUTABLE_ROOT_${index}"))`)
      .join('\n');
    sections.push(`(allow file-read* file-test-existence file-map-executable\n${clauses})`);
  }
  return sections.join('\n\n');
}

function writableRootClause(root: ResolvedRoot, index: number, roots: ResolvedRoots): string {
  const rootParam = seatbeltPathClause(root, `WRITABLE_ROOT_${index}`);
  const requirements = [...deniedRootRequirements(roots.deniedRoots)];

  if (roots.protectedWritableRoots.includes(root.path)) {
    requirements.push(
      ...roots.protectedMetadataNames.map((name) => protectedMetadataRequirement(root.path, name)),
    );
  }

  return accessRootClause(rootParam, requirements);
}

function accessRootClause(rootParam: string, requirements: readonly string[]): string {
  if (requirements.length === 0) return `  ${rootParam}`;

  const requirementLines = requirements.map((requirement) => `    ${requirement}`).join('\n');
  return `  (require-all\n    ${rootParam}\n${requirementLines}\n  )`;
}

function deniedRootRequirements(deniedRoots: readonly ResolvedRoot[]): readonly string[] {
  return deniedRoots.map(deniedRootRequirement);
}

function deniedRootRequirement(root: ResolvedRoot): string {
  const trimmedRoot = trimTrailingSlash(root.path);
  if (root.match === 'exact') {
    return `(require-not (literal "${escapeSeatbeltString(trimmedRoot)}"))`;
  }
  if (trimmedRoot === '/') return '(require-not (regex #"^/.*$"))';
  return `(require-not (regex #"^${escapeSeatbeltRegex(trimmedRoot)}(/.*)?$"))`;
}

function seatbeltPathClause(root: ResolvedRoot, parameter: string): string {
  return `(${root.match === 'exact' ? 'literal' : 'subpath'} (param "${parameter}"))`;
}

function escapeSeatbeltString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function protectedMetadataRequirement(root: string, name: string): string {
  const escapedRoot = escapeSeatbeltRegex(trimTrailingSlash(root));
  const escapedName = escapeSeatbeltRegex(name);
  return `(require-not (regex #"^${escapedRoot}/(.*/)?${escapedName}(/.*)?$"))`;
}

function trimTrailingSlash(path: string): string {
  if (path === '/') return path;
  return path.replace(/\/+$/g, '');
}

function buildNetworkPolicy(profile: PermissionProfile): string {
  if (profile.type === 'managed' && profile.network.kind === 'enabled') {
    return '(allow network*)';
  }
  if (profile.type === 'external' && profile.network.kind === 'enabled') {
    return '(allow network*)';
  }
  return '(deny network*)';
}

type PermissionProfileManagedEntry = Extract<
  PermissionProfile,
  { type: 'managed' }
>['fileSystem']['entries'][number];
