import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { compilePermissionProfile } from '@maka/core/permission-profile-compiler';

import { type PermissionMode } from '@maka/core/permission';

import { type PermissionProfile } from '@maka/core/permission-profile';

import type { FilesystemWorkerLaunchSpecProvider } from '../filesystem-worker/launch-spec.js';
import type { SandboxManager } from './sandbox-manager.js';
import type {
  SandboxPlatform,
  SandboxSelectionReason,
  SandboxTransformFailureReason,
  SandboxType,
} from './types.js';

export type SandboxDiagnosticFileSystemMode =
  | 'read-only'
  | 'workspace-write'
  | 'unrestricted'
  | 'custom-restricted'
  | 'external'
  | 'disabled';

export type SandboxDiagnosticNetworkMode = 'restricted' | 'enabled' | 'unmanaged';
export type SandboxDiagnosticCapabilityStatus =
  | 'available'
  | 'unavailable'
  | 'not_required'
  | 'external';
export type SandboxDiagnosticFailureStage = 'selection' | 'transform' | 'launch' | 'capability';
export type SandboxDiagnosticFailureReason =
  | SandboxTransformFailureReason
  | 'filesystem_worker_unavailable'
  | 'worker_bundle_unavailable'
  | 'runtime_executable_unavailable'
  | 'executable_unavailable'
  | 'capability_probe_failed';

export interface SandboxDiagnosticCapability {
  readonly status: SandboxDiagnosticCapabilityStatus;
  readonly backend: SandboxType;
  readonly selectionReason?: SandboxSelectionReason;
  readonly failure?: {
    readonly stage: SandboxDiagnosticFailureStage;
    readonly reason: SandboxDiagnosticFailureReason;
  };
}

export interface SandboxDiagnosticsSnapshot {
  readonly schemaVersion: 1;
  readonly platform: string;
  readonly profile: {
    readonly name: string;
    readonly type: PermissionProfile['type'];
    readonly fileSystem: SandboxDiagnosticFileSystemMode;
    readonly network: SandboxDiagnosticNetworkMode;
    readonly cwd: string;
    readonly workspaceRoots: readonly string[];
    readonly protectedMetadata: readonly string[];
  };
  readonly capabilities: {
    readonly command: SandboxDiagnosticCapability;
    readonly filesystem: SandboxDiagnosticCapability;
  };
}

/** Path-free projection suitable for durable diagnostics and telemetry. */
export interface SandboxRunTraceProjection {
  readonly schemaVersion: 1;
  readonly platform: string;
  readonly profile: {
    readonly name: string;
    readonly type: PermissionProfile['type'];
    readonly fileSystem: SandboxDiagnosticFileSystemMode;
    readonly network: SandboxDiagnosticNetworkMode;
    readonly protectedMetadata: readonly string[];
  };
  readonly capabilities: SandboxDiagnosticsSnapshot['capabilities'];
}

export interface ResolveSandboxDiagnosticsInput {
  mode: PermissionMode;
  cwd: string;
  workspaceRoots?: readonly string[];
  permissionProfile?: PermissionProfile;
}

export interface SandboxDiagnosticsProvider {
  resolve(input: ResolveSandboxDiagnosticsInput): Promise<SandboxDiagnosticsSnapshot>;
}

export interface CreateSandboxDiagnosticsProviderInput {
  sandboxManager?: SandboxManager;
  getFilesystemWorkerLaunchSpec?: FilesystemWorkerLaunchSpecProvider;
  platform?: SandboxPlatform;
  isExecutable?: (path: string) => Promise<boolean>;
  canonicalizePath?: (path: string) => Promise<string>;
}

export function createSandboxDiagnosticsProvider(
  input: CreateSandboxDiagnosticsProviderInput,
): SandboxDiagnosticsProvider {
  return {
    resolve: async (request) => {
      const canonicalize = input.canonicalizePath ?? canonicalPath;
      const cwd = await canonicalize(request.cwd);
      const workspaceRoots = await Promise.all((request.workspaceRoots ?? [cwd]).map(canonicalize));
      const compiled = request.permissionProfile
        ? { profile: request.permissionProfile, workspaceRoots }
        : compilePermissionProfile({ mode: request.mode, cwd, workspaceRoots });
      const platform = input.platform ?? process.platform;
      const capabilityInput: ProbeCapabilityInput = {
        profile: compiled.profile,
        cwd,
        workspaceRoots: compiled.workspaceRoots,
        platform,
        sandboxManager: input.sandboxManager,
        isExecutable: input.isExecutable ?? defaultIsExecutable,
      };
      const command = await probeCommandCapability(capabilityInput);
      const filesystem = await probeFilesystemCapability({
        ...capabilityInput,
        getLaunchSpec: input.getFilesystemWorkerLaunchSpec,
      });

      return {
        schemaVersion: 1,
        platform,
        profile: {
          name: profileName(compiled.profile),
          type: compiled.profile.type,
          fileSystem: summarizeFileSystem(compiled.profile),
          network: summarizeNetwork(compiled.profile),
          cwd,
          workspaceRoots: [...new Set(compiled.workspaceRoots)],
          protectedMetadata: protectedMetadataNames(compiled.profile),
        },
        capabilities: { command, filesystem },
      };
    },
  };
}

export function toSandboxRunTraceProjection(
  snapshot: SandboxDiagnosticsSnapshot,
): SandboxRunTraceProjection {
  return {
    schemaVersion: snapshot.schemaVersion,
    platform: snapshot.platform,
    profile: {
      name: snapshot.profile.name,
      type: snapshot.profile.type,
      fileSystem: snapshot.profile.fileSystem,
      network: snapshot.profile.network,
      protectedMetadata: [...snapshot.profile.protectedMetadata],
    },
    capabilities: {
      command: cloneCapability(snapshot.capabilities.command),
      filesystem: cloneCapability(snapshot.capabilities.filesystem),
    },
  };
}

interface ProbeCapabilityInput {
  profile: PermissionProfile;
  cwd: string;
  workspaceRoots: readonly string[];
  platform: SandboxPlatform;
  sandboxManager?: SandboxManager;
  isExecutable: (path: string) => Promise<boolean>;
}

async function probeCommandCapability(
  input: ProbeCapabilityInput,
): Promise<SandboxDiagnosticCapability> {
  const passive = passiveCapability(input.profile);
  if (passive) return passive;
  const manager = input.sandboxManager;
  if (!manager) {
    return unavailable(
      expectedSandboxType(input.platform),
      'selection',
      input.platform === 'darwin' || input.platform === 'linux'
        ? 'backend_not_available'
        : 'unsupported_platform',
    );
  }

  const selection = manager.selectInitial({ profile: input.profile, platform: input.platform });
  if (!selection.ok) {
    return unavailable(
      selection.sandboxType ?? expectedSandboxType(input.platform),
      'selection',
      selection.reason,
    );
  }
  if (selection.sandboxType === 'none') {
    return {
      status: 'not_required',
      backend: 'none',
      selectionReason: selection.reason,
    };
  }

  try {
    const transformed = manager.transform({
      platform: input.platform,
      command: {
        program: '/bin/sh',
        args: ['-c', 'true'],
        cwd: input.cwd,
        env: {},
        profile: input.profile,
        pathContext: {
          workspaceRoots: input.workspaceRoots,
          tmpdir: await canonicalPath(tmpdir()),
          slashTmp: await canonicalPath('/tmp'),
        },
      },
    });
    if (!transformed.ok) {
      return unavailable(
        transformed.sandboxType ?? selection.sandboxType,
        'transform',
        transformed.reason,
        selection.reason,
      );
    }
    const executable = transformed.exec.argv[0];
    if (!executable || !(await safelyCheckExecutable(executable, input.isExecutable))) {
      return unavailable(
        transformed.sandboxType,
        'capability',
        'executable_unavailable',
        selection.reason,
      );
    }
    return {
      status: 'available',
      backend: transformed.sandboxType,
      selectionReason: selection.reason,
    };
  } catch {
    return unavailable(
      selection.sandboxType,
      'capability',
      'capability_probe_failed',
      selection.reason,
    );
  }
}

async function probeFilesystemCapability(
  input: ProbeCapabilityInput & { getLaunchSpec?: FilesystemWorkerLaunchSpecProvider },
): Promise<SandboxDiagnosticCapability> {
  const passive = passiveCapability(input.profile);
  if (passive) return passive;
  if (!input.sandboxManager) {
    return unavailable(expectedSandboxType(input.platform), 'selection', 'backend_not_available');
  }

  const selection = input.sandboxManager.selectInitial({
    profile: input.profile,
    platform: input.platform,
  });
  if (!selection.ok) {
    return unavailable(
      selection.sandboxType ?? expectedSandboxType(input.platform),
      'selection',
      selection.reason,
    );
  }
  if (!input.getLaunchSpec) {
    return unavailable(
      selection.sandboxType,
      'launch',
      'filesystem_worker_unavailable',
      selection.reason,
    );
  }

  let launch: Awaited<ReturnType<FilesystemWorkerLaunchSpecProvider>>;
  try {
    launch = await input.getLaunchSpec();
  } catch {
    return unavailable(
      selection.sandboxType,
      'capability',
      'capability_probe_failed',
      selection.reason,
    );
  }
  if (!launch.ok) {
    return unavailable(selection.sandboxType, 'launch', launch.reason, selection.reason);
  }

  try {
    const transformed = input.sandboxManager.transform({
      platform: input.platform,
      command: {
        program: launch.spec.program,
        args: launch.spec.args,
        cwd: input.cwd,
        env: launch.spec.env,
        profile: input.profile,
        pathContext: {
          workspaceRoots: input.workspaceRoots,
          tmpdir: await canonicalPath(tmpdir()),
          slashTmp: await canonicalPath('/tmp'),
          runtimeReadableRoots: launch.spec.runtimeReadableRoots,
          executableRoots: launch.spec.executableRoots,
        },
      },
    });
    if (!transformed.ok) {
      return unavailable(
        transformed.sandboxType ?? selection.sandboxType,
        'transform',
        transformed.reason,
        selection.reason,
      );
    }
    const executable = transformed.exec.argv[0];
    if (!executable || !(await safelyCheckExecutable(executable, input.isExecutable))) {
      return unavailable(
        transformed.sandboxType,
        'capability',
        'executable_unavailable',
        selection.reason,
      );
    }
    return {
      status: 'available',
      backend: transformed.sandboxType,
      selectionReason: selection.reason,
    };
  } catch {
    return unavailable(
      selection.sandboxType,
      'capability',
      'capability_probe_failed',
      selection.reason,
    );
  }
}

function passiveCapability(profile: PermissionProfile): SandboxDiagnosticCapability | undefined {
  if (profile.type === 'external') return { status: 'external', backend: 'none' };
  if (
    profile.type === 'disabled' ||
    (profile.type === 'managed' && profile.fileSystem.kind !== 'restricted')
  ) {
    return {
      status: 'not_required',
      backend: 'none',
      selectionReason: 'sandbox_not_required',
    };
  }
  return undefined;
}

function unavailable(
  backend: SandboxType,
  stage: SandboxDiagnosticFailureStage,
  reason: SandboxDiagnosticFailureReason,
  selectionReason?: SandboxSelectionReason,
): SandboxDiagnosticCapability {
  return {
    status: 'unavailable',
    backend,
    ...(selectionReason ? { selectionReason } : {}),
    failure: { stage, reason },
  };
}

function expectedSandboxType(platform: SandboxPlatform): SandboxType {
  if (platform === 'darwin') return 'macos-seatbelt';
  if (platform === 'linux') return 'linux';
  return 'none';
}

function profileName(profile: PermissionProfile): string {
  return profile.name ?? profile.type;
}

function summarizeFileSystem(profile: PermissionProfile): SandboxDiagnosticFileSystemMode {
  if (profile.type === 'disabled') return 'disabled';
  if (profile.type === 'external') return 'external';
  if (profile.fileSystem.kind === 'unrestricted') return 'unrestricted';
  if (profile.fileSystem.kind === 'external_sandbox') return 'external';
  if (!profile.fileSystem.entries.some((entry) => entry.access === 'write')) return 'read-only';
  return profile.fileSystem.entries.some(
    (entry) =>
      entry.kind === 'special' && entry.special === ':workspace_roots' && entry.access === 'write',
  )
    ? 'workspace-write'
    : 'custom-restricted';
}

function summarizeNetwork(profile: PermissionProfile): SandboxDiagnosticNetworkMode {
  return profile.type === 'disabled' ? 'unmanaged' : profile.network.kind;
}

function protectedMetadataNames(profile: PermissionProfile): readonly string[] {
  if (profile.type !== 'managed') return [];
  return [...(profile.fileSystem.protectedMetadata?.names ?? [])];
}

function cloneCapability(capability: SandboxDiagnosticCapability): SandboxDiagnosticCapability {
  return {
    ...capability,
    ...(capability.failure ? { failure: { ...capability.failure } } : {}),
  };
}

async function safelyCheckExecutable(
  path: string,
  isExecutable: (path: string) => Promise<boolean>,
): Promise<boolean> {
  try {
    return await isExecutable(path);
  } catch {
    return false;
  }
}

async function defaultIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function canonicalPath(path: string): Promise<string> {
  return await realpath(path).catch(() => resolve(path));
}
