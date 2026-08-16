import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { canReadPath, canWritePath, type PermissionProfile } from '@maka/core/permission-profile';

import { compilePermissionProfile } from '@maka/core/permission-profile-compiler';

import { type ExecutionBoundary, type SandboxBoundaryExpansion } from '@maka/core/sandbox-boundary';

import { type PermissionMode } from '@maka/core/permission';

import { normalizeSandboxBoundaryPath } from '../sandbox-boundary-path.js';
import { resolveCanonicalDirectoryEntryTarget } from '../path-containment.js';
import { pinExistingLinuxProfilePath } from '../sandbox/linux-profile-path.js';
import type { SandboxManager } from '../sandbox/sandbox-manager.js';
import type { SandboxPlatform } from '../sandbox/types.js';
import type { FilesystemWorkerLaunchSpecProvider } from './launch-spec.js';
import {
  FILESYSTEM_WORKER_DEFAULT_TIMEOUT_MS,
  runFilesystemWorkerProcess,
  type FilesystemWorkerProcessRunner,
} from './process-runner.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  FilesystemWorkerOperationSchema,
  operationUsesDirectoryEntry,
  parseFilesystemWorkerResponse,
  type FilesystemWorkerErrorCode,
  type FilesystemWorkerOperation,
  type FilesystemWorkerResult,
  type FilesystemWorkerTarget,
} from './protocol.js';

export const FILESYSTEM_WORKER_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export type FilesystemWorkerClientOperation = FilesystemWorkerOperation extends infer Operation
  ? Operation extends { cwd: string }
    ? Omit<Operation, 'cwd'>
    : never
  : never;

export interface FilesystemWorkerClientInput {
  getLaunchSpec: FilesystemWorkerLaunchSpecProvider;
  sandboxManager: SandboxManager;
  runProcess?: FilesystemWorkerProcessRunner;
  newId?: () => string;
  timeoutMs?: number;
  platform?: SandboxPlatform;
}

export interface FilesystemWorkerExecuteInput {
  operation: FilesystemWorkerClientOperation;
  cwd: string;
  executionBoundary?: ExecutionBoundary;
  mode?: PermissionMode;
  /** Explicit embedding policy. Mode-based defaults are compiled only when omitted. */
  permissionProfile?: PermissionProfile;
  abortSignal?: AbortSignal;
}

export type FilesystemWorkerClientErrorReason =
  | 'invalid_operation'
  | 'invalid_request'
  | 'request_overflow'
  | 'worker_bundle_unavailable'
  | 'runtime_executable_unavailable'
  | 'spawn_failed'
  | 'timeout'
  | 'aborted'
  | 'response_overflow'
  | 'worker_crashed'
  | 'invalid_response'
  | 'response_id_mismatch'
  | 'response_kind_mismatch'
  | FilesystemWorkerErrorCode
  | 'unsupported_platform'
  | 'backend_not_available'
  | 'backend_not_implemented'
  | 'sandbox_required'
  | 'sandbox_boundary_required';

export class FilesystemWorkerClientError extends Error {
  readonly code = 'SANDBOX_FILESYSTEM_OPERATION_FAILED';
  readonly domain = 'filesystem' as const;
  readonly reason: FilesystemWorkerClientErrorReason;
  readonly stage: 'validation' | 'transform' | 'launch' | 'protocol' | 'operation';
  readonly recoverable: boolean;
  readonly requestId?: string;
  readonly backend?: 'none' | 'macos-seatbelt' | 'linux';
  readonly profileName?: string;
  readonly requiredExpansion?: SandboxBoundaryExpansion;

  constructor(input: {
    reason: FilesystemWorkerClientErrorReason;
    stage: FilesystemWorkerClientError['stage'];
    message?: string;
    recoverable?: boolean;
    requestId?: string;
    backend?: 'none' | 'macos-seatbelt' | 'linux';
    profileName?: string;
    requiredExpansion?: SandboxBoundaryExpansion;
  }) {
    super(input.message ?? `Filesystem worker failed: ${input.reason}.`);
    this.name = 'FilesystemWorkerClientError';
    this.reason = input.reason;
    this.stage = input.stage;
    this.recoverable = input.recoverable ?? false;
    this.requestId = input.requestId;
    this.backend = input.backend;
    this.profileName = input.profileName;
    this.requiredExpansion = input.requiredExpansion;
  }
}

export class FilesystemWorkerClient {
  private readonly runProcess: FilesystemWorkerProcessRunner;
  private readonly newId: () => string;
  private readonly timeoutMs: number;

  constructor(private readonly input: FilesystemWorkerClientInput) {
    this.runProcess = input.runProcess ?? runFilesystemWorkerProcess;
    this.newId = input.newId ?? randomUUID;
    this.timeoutMs = input.timeoutMs ?? FILESYSTEM_WORKER_DEFAULT_TIMEOUT_MS;
  }

  async execute(input: FilesystemWorkerExecuteInput): Promise<FilesystemWorkerResult> {
    const requestId = this.newId();
    if (input.abortSignal?.aborted) throw clientError('aborted', 'launch', requestId);
    if (input.executionBoundary && input.executionBoundary.kind !== 'managed') {
      throw clientError(
        'invalid_request',
        'validation',
        requestId,
        'Filesystem worker execution requires a managed boundary.',
      );
    }
    const canonicalCwd = await realpath(input.cwd).catch(() => {
      throw clientError(
        'invalid_operation',
        'validation',
        requestId,
        'Session cwd is unavailable.',
      );
    });
    const parsedOperation = FilesystemWorkerOperationSchema.safeParse({
      ...input.operation,
      cwd: canonicalCwd,
    });
    if (!parsedOperation.success) throw clientError('invalid_operation', 'validation', requestId);

    const access = operationAccess(parsedOperation.data.kind);
    const entryMode = operationUsesDirectoryEntry(parsedOperation.data);
    const target: FilesystemWorkerTarget & { writableAncestor?: string } = await (entryMode
      ? normalizeDirectoryEntryTarget({
          path: parsedOperation.data.path,
          access,
          cwd: canonicalCwd,
        })
      : normalizeSandboxBoundaryPath({
          path: parsedOperation.data.path,
          access,
          scope: operationScope(parsedOperation.data.kind),
          cwd: canonicalCwd,
        })
    ).catch(() => {
      throw clientError('invalid_operation', 'validation', requestId);
    });
    const compiled =
      input.executionBoundary?.kind === 'managed'
        ? {
            profile: input.executionBoundary.profile,
            workspaceRoots: [canonicalCwd],
          }
        : input.permissionProfile
          ? {
              profile: input.permissionProfile,
              workspaceRoots: [canonicalCwd],
            }
          : compilePermissionProfile({ mode: input.mode ?? 'ask', cwd: canonicalCwd });
    const effectiveProfile = compiled.profile;
    const platform = this.input.platform ?? process.platform;
    const runtimeWritableRoots = filesystemWorkerRuntimeWritableRoots({
      platform,
      access,
      enforcementPath: target.enforcementPath,
      targetType: target.targetType,
      entryMode,
      writableAncestor: target.writableAncestor,
    });
    const pathContext = {
      workspaceRoots: compiled.workspaceRoots,
      tmpdir: await canonicalPath(tmpdir()),
      slashTmp: await canonicalPath('/tmp'),
      ...(runtimeWritableRoots ? { runtimeWritableRoots } : {}),
    };
    const allowed =
      access === 'write'
        ? canWritePath(effectiveProfile, target.enforcementPath, pathContext)
        : canReadPath(effectiveProfile, target.enforcementPath, pathContext);
    if (!allowed) {
      throw clientError(
        input.executionBoundary?.kind === 'managed' ? 'sandbox_boundary_required' : 'path_denied',
        'validation',
        requestId,
        undefined,
        true,
        input.executionBoundary?.kind === 'managed'
          ? {
              requiredExpansion: {
                filesystem: {
                  entries: [
                    {
                      path: target.enforcementPath,
                      access,
                      scope: target.scope,
                    },
                  ],
                },
              },
            }
          : {},
      );
    }

    const boundaryTarget = target.writableAncestor
      ? { path: target.writableAncestor, access: 'write' as const, scope: 'subtree' as const }
      : { path: target.enforcementPath, access, scope: target.scope };
    const operationBoundary = {
      filesystem: {
        entries: [boundaryTarget],
      },
    } as const;
    const operation = FilesystemWorkerOperationSchema.parse({
      ...parsedOperation.data,
      path: target.enforcementPath,
    });
    const request = {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId,
      operation,
      operationBoundary,
      expectedTarget: {
        enforcementPath: target.enforcementPath,
        access,
        scope: target.scope,
        targetType: target.targetType,
      },
    } as const;
    const requestJson = JSON.stringify(request);
    if (Buffer.byteLength(requestJson, 'utf8') > FILESYSTEM_WORKER_MAX_REQUEST_BYTES) {
      throw clientError('request_overflow', 'validation', requestId);
    }

    const launch = await this.input.getLaunchSpec();
    if (!launch.ok) throw clientError(launch.reason, 'launch', requestId, launch.message);
    const workerProfile = deriveWorkerProfile(effectiveProfile, operationBoundary);
    const pinnedTarget =
      platform === 'linux' && !entryMode && target.targetType !== 'missing'
        ? (() => {
            try {
              return pinExistingLinuxProfilePath({
                path: target.enforcementPath,
                access,
                targetType: target.targetType as 'file' | 'directory' | 'other',
                childFd: 4,
              });
            } catch {
              throw clientError(
                'path_changed',
                'validation',
                requestId,
                'The approved filesystem target changed before sandbox launch.',
              );
            }
          })()
        : undefined;
    if (platform === 'linux' && !entryMode && target.targetType !== 'missing' && !pinnedTarget) {
      throw clientError(
        'path_changed',
        'validation',
        requestId,
        'The approved filesystem target changed before sandbox launch.',
      );
    }
    const pinnedRuntimeWritableRoot =
      platform === 'linux' &&
      runtimeWritableRoots?.[0] &&
      (entryMode || target.targetType === 'missing')
        ? (() => {
            try {
              return pinExistingLinuxProfilePath({
                path: runtimeWritableRoots[0],
                access: 'write',
                targetType: 'directory',
                childFd: 4,
              });
            } catch {
              throw clientError(
                'path_changed',
                'validation',
                requestId,
                'The approved filesystem target parent changed before sandbox launch.',
              );
            }
          })()
        : undefined;
    if (
      platform === 'linux' &&
      runtimeWritableRoots &&
      (entryMode || target.targetType === 'missing') &&
      !pinnedRuntimeWritableRoot
    ) {
      throw clientError(
        'path_changed',
        'validation',
        requestId,
        'The approved filesystem target parent changed before sandbox launch.',
      );
    }
    let transformed: ReturnType<SandboxManager['transform']>;
    try {
      transformed = this.input.sandboxManager.transform({
        platform,
        command: {
          program: launch.spec.program,
          args: launch.spec.args,
          cwd: canonicalCwd,
          env: launch.spec.env,
          profile: workerProfile,
          pathContext: {
            ...pathContext,
            runtimeReadableRoots: launch.spec.runtimeReadableRoots,
            executableRoots: launch.spec.executableRoots,
            ...(pinnedTarget
              ? {
                  pinnedProfilePaths: [
                    {
                      path: pinnedTarget.path,
                      access: pinnedTarget.access,
                      fd: pinnedTarget.childFd,
                      sourceFd: pinnedTarget.sourceFd,
                      releaseSource: pinnedTarget.releaseSource,
                    },
                  ],
                }
              : {}),
            ...(pinnedRuntimeWritableRoot
              ? {
                  pinnedRuntimeWritableRoots: [
                    {
                      path: pinnedRuntimeWritableRoot.path,
                      fd: pinnedRuntimeWritableRoot.childFd,
                      sourceFd: pinnedRuntimeWritableRoot.sourceFd,
                      releaseSource: pinnedRuntimeWritableRoot.releaseSource,
                    },
                  ],
                }
              : {}),
          },
        },
      });
    } catch (error) {
      pinnedTarget?.releaseSource();
      pinnedRuntimeWritableRoot?.releaseSource();
      throw error;
    }
    if (!transformed.ok) {
      pinnedTarget?.releaseSource();
      pinnedRuntimeWritableRoot?.releaseSource();
      throw clientError(transformed.reason, 'transform', requestId, transformed.message, false, {
        backend: transformed.sandboxType,
        profileName: effectiveProfile.name ?? effectiveProfile.type,
      });
    }

    let processResult: Awaited<ReturnType<FilesystemWorkerProcessRunner>>;
    try {
      processResult = await this.runProcess({
        argv: transformed.exec.argv,
        cwd: transformed.exec.cwd,
        env: transformed.exec.env ?? {},
        stdin: requestJson,
        ...(transformed.exec.fdInputs ? { fdInputs: transformed.exec.fdInputs } : {}),
        timeoutMs: this.timeoutMs,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
    } catch {
      throw clientError('spawn_failed', 'launch', requestId);
    } finally {
      pinnedTarget?.releaseSource();
      pinnedRuntimeWritableRoot?.releaseSource();
    }
    if (processResult.timedOut) throw clientError('timeout', 'launch', requestId);
    if (processResult.aborted) throw clientError('aborted', 'launch', requestId);
    if (processResult.responseOverflow) throw clientError('response_overflow', 'launch', requestId);
    if (processResult.exitCode !== 0) {
      throw clientError(
        'worker_crashed',
        'launch',
        requestId,
        processResult.stderrTail || undefined,
      );
    }

    let response: ReturnType<typeof parseFilesystemWorkerResponse>;
    try {
      response = parseFilesystemWorkerResponse(JSON.parse(processResult.stdout));
    } catch {
      throw clientError('invalid_response', 'protocol', requestId);
    }
    if (response.requestId !== requestId)
      throw clientError('response_id_mismatch', 'protocol', requestId);
    if (!response.ok) {
      throw clientError(
        response.error.code,
        'operation',
        requestId,
        response.error.message,
        response.error.code === 'not_found' || response.error.code === 'edit_conflict',
        {
          backend: transformed.exec.sandboxType,
          profileName: effectiveProfile.name ?? effectiveProfile.type,
        },
      );
    }
    if (
      response.result.kind !== operation.kind &&
      !(operation.kind === 'read' && response.result.kind === 'read_image')
    ) {
      throw clientError('response_kind_mismatch', 'protocol', requestId);
    }
    return response.result;
  }
}

/** @internal Runtime-only widening for a trusted, single-operation worker. */
export function filesystemWorkerRuntimeWritableRoots(input: {
  platform: SandboxPlatform;
  access: 'read' | 'write';
  enforcementPath: string;
  targetType: FilesystemWorkerTarget['targetType'];
  entryMode?: boolean;
  writableAncestor?: string;
}): readonly string[] | undefined {
  if (input.platform !== 'linux' || input.access !== 'write') return undefined;
  if (input.entryMode) return input.writableAncestor ? [input.writableAncestor] : undefined;
  return input.targetType === 'missing' ? [dirname(input.enforcementPath)] : undefined;
}

function deriveWorkerProfile(
  profile: PermissionProfile,
  operationBoundary: {
    readonly filesystem: {
      readonly entries: readonly [
        {
          readonly path: string;
          readonly access: 'read' | 'write';
          readonly scope: 'exact' | 'subtree';
        },
      ];
    };
  },
): PermissionProfile {
  if (profile.type !== 'managed' || profile.fileSystem.kind !== 'restricted') return profile;
  const target = operationBoundary.filesystem.entries[0];
  return {
    ...profile,
    fileSystem: {
      ...profile.fileSystem,
      entries: [
        ...profile.fileSystem.entries.filter((entry) => entry.access === 'deny'),
        {
          kind: 'path',
          path: target.path,
          access: target.access,
          match: target.scope,
        },
      ],
    },
    network: { kind: 'restricted' },
  };
}

function operationAccess(kind: FilesystemWorkerOperation['kind']): 'read' | 'write' {
  return kind === 'write' || kind === 'apply_patch' || kind === 'edit' || kind === 'format_json'
    ? 'write'
    : 'read';
}

function operationScope(kind: FilesystemWorkerOperation['kind']): 'exact' | 'subtree' | 'auto' {
  if (kind === 'glob') return 'subtree';
  return kind === 'grep' ? 'auto' : 'exact';
}

async function canonicalPath(path: string): Promise<string> {
  return await realpath(path).catch(() => path);
}

async function normalizeDirectoryEntryTarget(input: {
  path: string;
  cwd: string;
  access: 'read' | 'write';
}): Promise<FilesystemWorkerTarget & { writableAncestor?: string }> {
  const target = await resolveCanonicalDirectoryEntryTarget(input.cwd, input.path);
  let targetType: FilesystemWorkerTarget['targetType'];
  try {
    const metadata = await lstat(target.path);
    targetType = metadata.isSymbolicLink()
      ? 'symlink'
      : metadata.isFile()
        ? 'file'
        : metadata.isDirectory()
          ? 'directory'
          : 'other';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    targetType = 'missing';
  }
  return {
    enforcementPath: target.path,
    access: input.access,
    scope: 'exact',
    targetType,
    writableAncestor: target.existingAncestor,
  };
}

function clientError(
  reason: FilesystemWorkerClientErrorReason,
  stage: FilesystemWorkerClientError['stage'],
  requestId: string,
  message?: string,
  recoverable = false,
  metadata: {
    backend?: 'none' | 'macos-seatbelt' | 'linux';
    profileName?: string;
    requiredExpansion?: SandboxBoundaryExpansion;
  } = {},
): FilesystemWorkerClientError {
  return new FilesystemWorkerClientError({
    reason,
    stage,
    requestId,
    message,
    recoverable,
    ...metadata,
  });
}
