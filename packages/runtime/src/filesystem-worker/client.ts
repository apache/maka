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
import { classifyWindowsBrokerFailure } from '../sandbox/windows-broker-errors.js';
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
  /**
   * The target identity captured at lock acquisition (T0), passed in by the
   * caller so the client does not re-derive it after acquiring the lock (T1).
   * The worker compare-and-swaps this against the on-disk inode. Undefined for
   * a missing target (create) or when the host-local backend is in use.
   */
  expectedIdentity?: { dev: string; ino: string };
}

export type FilesystemWorkerClientErrorReason =
  | 'invalid_operation'
  | 'invalid_request'
  | 'request_overflow'
  | 'worker_bundle_unavailable'
  | 'runtime_executable_unavailable'
  | 'spawn_failed'
  | 'worker_io_incomplete'
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
  readonly backend?: 'none' | 'macos-seatbelt' | 'linux' | 'windows';
  readonly profileName?: string;
  readonly requiredExpansion?: SandboxBoundaryExpansion;
  /**
   * Whether the request had been dispatched to the worker before this failure.
   * Only meaningful for `'launch'`/`'protocol'` failures: `undefined` means
   * "the question does not apply" (pre-flight validation). When `false` the
   * child never ran, so nothing on disk could have changed; when `true` the
   * child ran and the outcome on disk is genuinely unknown.
   */
  readonly dispatched?: boolean;

  constructor(input: {
    reason: FilesystemWorkerClientErrorReason;
    stage: FilesystemWorkerClientError['stage'];
    message?: string;
    recoverable?: boolean;
    requestId?: string;
    backend?: 'none' | 'macos-seatbelt' | 'linux' | 'windows';
    profileName?: string;
    requiredExpansion?: SandboxBoundaryExpansion;
    dispatched?: boolean;
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
    this.dispatched = input.dispatched;
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
    if (input.abortSignal?.aborted) {
      // Pre-flight cancel: nothing has been dispatched, so this is a clean
      // cancellation, not an unknown outcome. Carrying dispatched:false lets
      // the host tell the two apart instead of blaming every queued tool.
      throw clientError('aborted', 'launch', requestId, undefined, false, {}, false);
    }
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
    // The identity was captured by the caller at lock acquisition (T0) and
    // passed in as expectedIdentity. Do NOT re-derive it here: re-deriving at
    // this point (after the lock is held) would sample the post-queue inode,
    // making the CAS self-fulfilling and re-opening the queue window.
    //
    // Missing↔existing transitions while queued are reconciled here, against
    // the T1 reality the target normaliser just derived:
    // - T0 existing (identity present) but T1 missing: the target was removed
    //   while this call waited — typically a cooperative Maka delete that ran
    //   first under the same write lock. Drop the stale identity and let the
    //   mutation proceed as a fresh exclusive create ("delete then rewrite"
    //   stays a clean apply; a rename-swap is NOT this case — it leaves an
    //   existing inode and is caught by the identity comparison instead).
    // - T0 missing (no identity) but T1 existing: the target was created while
    //   this call waited. Writing would clobber content this call never saw,
    //   so fail with a meaningful path_changed (never invalid_request).
    const identity =
      input.expectedIdentity && target.targetType !== 'missing'
        ? input.expectedIdentity
        : undefined;
    if (!identity && target.targetType !== 'missing' && access === 'write') {
      throw clientError(
        'path_changed',
        'validation',
        requestId,
        'The target was created while this call waited for the lock; re-read before writing.',
      );
    }
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
      ...(platform === 'win32' ? {} : { slashTmp: await canonicalPath('/tmp') }),
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
        ...(identity ? { identity } : {}),
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
    } catch (error) {
      // The process-runner attaches a `dispatched` flag to the rejection so we
      // can tell "the child never started" (spawn_failed — clean) from "the
      // child ran but its result was lost" (worker_io_incomplete — the outcome
      // on disk is unknown). A thrown error without the flag (e.g. spawn()
      // itself raising before any 'spawn' event could fire) is treated as
      // never-dispatched.
      const dispatched = (error as { dispatched?: boolean } | null)?.dispatched === true;
      throw clientError(
        dispatched ? 'worker_io_incomplete' : 'spawn_failed',
        'launch',
        requestId,
        undefined,
        false,
        {},
        dispatched,
      );
    } finally {
      pinnedTarget?.releaseSource();
      pinnedRuntimeWritableRoot?.releaseSource();
    }
    if (processResult.timedOut) {
      throw clientError(
        'timeout',
        'launch',
        requestId,
        undefined,
        false,
        {},
        processResult.dispatched,
      );
    }
    if (processResult.aborted) {
      // A post-dispatch abort means the child had the request and may have
      // acted on it before being killed; carry dispatched so the host can
      // classify it as an unknown outcome rather than a clean cancel.
      throw clientError(
        'aborted',
        'launch',
        requestId,
        undefined,
        false,
        {},
        processResult.dispatched,
      );
    }
    if (processResult.responseOverflow) {
      throw clientError(
        'response_overflow',
        'launch',
        requestId,
        undefined,
        false,
        {},
        processResult.dispatched,
      );
    }
    if (processResult.exitCode !== 0) {
      const brokerFailure =
        transformed.sandboxType === 'windows'
          ? classifyWindowsBrokerFailure(processResult.stderrTail)
          : undefined;
      if (brokerFailure) {
        throw clientError(
          brokerFailure.reason,
          'launch',
          requestId,
          processResult.stderrTail || undefined,
          brokerFailure.recoverable,
          { backend: 'windows' },
        );
      }
      throw clientError(
        'worker_crashed',
        'launch',
        requestId,
        processResult.stderrTail || undefined,
        false,
        {},
        processResult.dispatched,
      );
    }

    let response: ReturnType<typeof parseFilesystemWorkerResponse>;
    try {
      response = parseFilesystemWorkerResponse(JSON.parse(processResult.stdout));
    } catch {
      // The child produced output we could not parse, but it ran and emitted
      // something, so the request was dispatched (the on-disk outcome is
      // unknown for a mutation).
      throw clientError('invalid_response', 'protocol', requestId, undefined, false, {}, true);
    }
    if (response.requestId !== requestId)
      throw clientError('response_id_mismatch', 'protocol', requestId, undefined, false, {}, true);
    if (!response.ok) {
      // A well-formed worker error means the child ran and answered: dispatch
      // had happened. Carry dispatched:true so a mutating op that fails here
      // (e.g. the worker reports `outcome_unknown` after a partial write) is
      // classified as an unknown outcome rather than slipping through.
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
        true,
      );
    }
    if (
      response.result.kind !== operation.kind &&
      !(operation.kind === 'read' && response.result.kind === 'read_image')
    ) {
      throw clientError(
        'response_kind_mismatch',
        'protocol',
        requestId,
        undefined,
        false,
        {},
        true,
      );
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
  // Linux mounts and Windows ACL grants can only target existing paths, so a
  // write whose target does not exist yet is enforced through its existing
  // writable ancestor. macOS seatbelt policies may reference missing paths
  // directly and need no ancestor root.
  if ((input.platform !== 'linux' && input.platform !== 'win32') || input.access !== 'write') {
    return undefined;
  }
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
    backend?: 'none' | 'macos-seatbelt' | 'linux' | 'windows';
    profileName?: string;
    requiredExpansion?: SandboxBoundaryExpansion;
  } = {},
  dispatched?: boolean,
): FilesystemWorkerClientError {
  return new FilesystemWorkerClientError({
    reason,
    stage,
    requestId,
    message,
    recoverable,
    ...metadata,
    ...(dispatched !== undefined ? { dispatched } : {}),
  });
}
