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

// packages/runtime/src/filesystem-executor.ts
// The single authority for where the built-in file tools may reach.
//
// One decision — the active ExecutionBoundary — picks the backend and the path
// scope; the tools carry no policy branch and no executor carries a containment
// rule of its own. Before this seam existed each file tool repeated the same
// worker-versus-executor branch, and the fallback executor hard-coded a session-cwd
// containment that no permission profile actually declares. A bypass boundary
// skipped the worker, so that undeclared rule became the only arbiter and made
// "full access" stricter than ask mode, which grants :slash_tmp outright (#2083).

import { Buffer } from 'node:buffer';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { PermissionMode } from '@maka/core/permission';
import type { PermissionProfile } from '@maka/core/permission-profile';
import { ToolOutcomeUnknownError } from '@maka/core/events';
import { computeEditedSource } from './edit-replace.js';
import { createEditUnifiedDiff, createUnifiedDiff } from './unified-diff.js';
import {
  classifyFailedMutationOutcome,
  type FilesystemTargetIdentity,
} from './filesystem-authority.js';
import { StableWriteFailure } from './file-stable-write.js';
import { applyUpdateToContent } from './apply-patch-file.js';
import { executeApplyPatchOperations, type ApplyPatchBatchResult } from './apply-patch-batch.js';
import {
  normalizeFilesystemLeaseRequests,
  processFilesystemLeases,
  type FilesystemLeaseCoordinator,
  type FilesystemLeaseRequest,
} from './filesystem-lease-coordinator.js';
import { hostFilesystemLeaseKey } from './filesystem-lease-key.js';
import {
  identityChanged,
  type ResolvedTarget,
  type TargetIdentity,
} from './preparation/target-identity.js';
import type {
  AuthorityContext,
  KeyedResourceClaim,
  PreparedOperation,
  ResourceAuthority,
} from './preparation/types.js';
import { oneShotOperation } from './preparation/one-shot-operation.js';
import type {
  FilesystemWorkerClient,
  FilesystemWorkerClientOperation,
} from './filesystem-worker/client.js';
import { isSupportedImagePath, type ImageMimeType } from './image-file.js';
import type { FilesystemWorkerResult } from './filesystem-worker/protocol.js';
import { operationAccess } from './filesystem-worker/protocol.js';
import { resolveCanonicalDirectoryEntryTarget } from './path-containment.js';
import { normalizeSandboxBoundaryPath } from './sandbox-boundary-path.js';
import { SandboxCommandError } from './sandbox/errors.js';
import type {
  WorkspaceEditExecutor,
  WorkspaceApplyPatchExecutor,
  WorkspacePathScope,
  WorkspaceReadModifyWriteExecutor,
  WorkspaceSearchExecutor,
  WorkspaceWriteExecutor,
} from './workspace-executor.js';

/** A file operation, named the same way on every backend. `cwd` is supplied per call. */
type FilesystemBackendOperation = FilesystemWorkerClientOperation;
export type FilesystemOperation = Exclude<FilesystemBackendOperation, { kind: 'apply_patch' }>;

/**
 * The result shape every backend answers with.
 *
 * It is the worker protocol's union with one substitution: image bytes stay
 * bytes. Base64 is how the worker's JSON transport carries them, not part of
 * this contract, so the worker-backed backend decodes once at its own edge and
 * the host-local backend hands its buffer straight through.
 */
export type FilesystemResult =
  | Exclude<FilesystemWorkerResult, { kind: 'read_image' }>
  | { kind: 'read_image'; bytes: Uint8Array; mimeType: ImageMimeType };

export interface FilesystemExecuteInput {
  operation: FilesystemOperation;
  cwd: string;
  executionBoundary?: ExecutionBoundary;
  /** Only consulted when no boundary is present; the boundary always wins. */
  permissionMode?: PermissionMode;
  abortSignal?: AbortSignal;
}

type FilesystemBackendExecuteInput = Omit<FilesystemExecuteInput, 'operation'> & {
  operation: FilesystemBackendOperation;
};

export type ApplyPatchOperation =
  | { type: 'create_file'; path: string; diff: string }
  | { type: 'delete_file'; path: string }
  | { type: 'update_file'; path: string; diff: string };

export interface FilesystemApplyPatchInput extends Omit<FilesystemExecuteInput, 'operation'> {
  operation: ApplyPatchOperation;
}

export interface FilesystemApplyPatchBatchInput extends Omit<FilesystemExecuteInput, 'operation'> {
  operations: readonly ApplyPatchOperation[];
}

export interface ApplyPatchResult {
  status: 'completed';
}

export interface FilesystemExecutor {
  /**
   * Run one operation under the authority of the boundary it carries. A mutating
   * operation holds the target's write lock for its whole read-modify-write, so
   * no caller has to know that a lock exists or how its key is spelled.
   */
  execute(input: FilesystemExecuteInput): Promise<FilesystemResult>;
  applyPatch(input: FilesystemApplyPatchInput): Promise<ApplyPatchResult>;
  applyPatchBatch(input: FilesystemApplyPatchBatchInput): Promise<ApplyPatchBatchResult>;
}

/** The workspace primitives the host-local backend drives. */
export type FilesystemWorkspaceExecutor = WorkspaceWriteExecutor &
  WorkspaceEditExecutor &
  Partial<WorkspaceApplyPatchExecutor> &
  Partial<WorkspaceReadModifyWriteExecutor> &
  WorkspaceSearchExecutor;

export interface BoundaryFilesystemExecutorInput {
  workspace: FilesystemWorkspaceExecutor;
  worker?: Pick<FilesystemWorkerClient, 'execute'>;
  /** Explicit embedding policy handed to the worker instead of a mode default. */
  permissionProfile?: PermissionProfile;
  filesystemLeaseCoordinator?: FilesystemLeaseCoordinator;
}

/**
 * The path scope a boundary authorises.
 *
 * `bypass` is the user asking for no restrictions, and it already means exactly
 * that for Bash, which runs untransformed on the host under the same boundary.
 * Every other boundary — including a missing one, which is an embedder that
 * never opted in — stays workspace-scoped.
 */
function pathScopeForBoundary(boundary: ExecutionBoundary | undefined): WorkspacePathScope {
  return boundary?.kind === 'bypass' ? 'host' : 'workspace';
}

/**
 * Capture the target's stable identity at prepare/direct-call T0, before lease
 * admission. This is the inode the owner rechecks inside the lease and the
 * worker compare-and-swaps against. Returns undefined when the target does not
 * yet exist (a create), since there is no inode to pin.
 *
 * `follow` must match how the worker derives the targetType: content operations
 * follow the final symlink (stat), create/delete pin the directory entry (lstat)
 * so a swapped link is detected against the entry's own inode.
 */
async function captureFilesystemTargetIdentity(
  canonicalPath: string,
  follow: boolean,
): Promise<FilesystemTargetIdentity | undefined> {
  try {
    const metadata = follow
      ? await stat(canonicalPath, { bigint: true })
      : await lstat(canonicalPath, { bigint: true });
    return { dev: String(metadata.dev), ino: String(metadata.ino) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A missing target (create / new file) has no inode to pin.
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/**
 * Compose the backends behind one boundary-driven decision.
 *
 * - `managed` → the sandboxed worker, which enforces the boundary's profile.
 * - `bypass` → host-local execution with host path scope.
 * - `external` → the injected workspace executor, whose own workspace is the
 *   whole filesystem it can address; it never falls back to host access.
 * - absent → the worker when one is wired, otherwise workspace-scoped local
 *   execution. This is the embedding default and deliberately the narrow one.
 */
interface FilesystemBackend {
  run(
    call: FilesystemBackendExecuteInput,
    expectedIdentity?: FilesystemTargetIdentity,
  ): Promise<FilesystemResult>;
  resolveTarget(input: {
    cwd: string;
    path: string;
    semantics: 'target' | 'entry';
    executionBoundary?: ExecutionBoundary;
    permissionMode?: PermissionMode;
    abortSignal?: AbortSignal;
  }): Promise<ResolvedTarget>;
}

function buildFilesystemBackend(input: BoundaryFilesystemExecutorInput): FilesystemBackend {
  const local = createWorkspaceFilesystemExecutor(input.workspace);
  /** The worker that owns this boundary, or undefined when the workspace backend does. */
  const workerFor = (
    boundary: ExecutionBoundary | undefined,
  ): Pick<FilesystemWorkerClient, 'execute'> | undefined => {
    if (boundary?.kind === 'bypass' || boundary?.kind === 'external') return undefined;
    if (input.worker) return input.worker;
    if (boundary?.kind !== 'managed') return undefined;
    throw new SandboxCommandError({
      domain: 'filesystem',
      stage: 'capability',
      reason: 'requires_bypass',
      recoverable: false,
      profileName: boundary.profile.name ?? boundary.profile.type,
      message:
        'Managed filesystem execution is unavailable because the sandboxed worker cannot be enforced.',
    });
  };
  async function run(
    call: FilesystemBackendExecuteInput,
    expectedIdentity?: FilesystemTargetIdentity,
  ): Promise<FilesystemResult> {
    const worker = workerFor(call.executionBoundary);
    if (!worker) {
      // The local backend consumes the same identity authority as the worker
      // (#2600): the pinned read-modify-write validates the T0 identity on the
      // descriptor. Remote/isolated workspaces without readModifyWrite stay on
      // the path-based fallback, documented as unprotected by the authority.
      return await local.execute(
        call,
        pathScopeForBoundary(call.executionBoundary),
        expectedIdentity,
      );
    }
    const result = await worker.execute({
      operation: call.operation,
      // The worker is host-local by definition, so a session opened through a
      // symlinked cwd must reach it under the real path — otherwise the same
      // file arrives under two identities. The workspace backend is left the cwd
      // it was given: an isolated or remote workspace path is not the host's to
      // rewrite, and its own resolvers canonicalise what they need.
      cwd: await canonicalExistingPath(call.cwd),
      ...(call.executionBoundary ? { executionBoundary: call.executionBoundary } : {}),
      mode: call.permissionMode ?? 'ask',
      ...(input.permissionProfile ? { permissionProfile: input.permissionProfile } : {}),
      ...(call.abortSignal ? { abortSignal: call.abortSignal } : {}),
      // The worker client now requires an explicit T0 marker (#3484): a
      // mutation carries its captured identity, or 'missing' when T0 saw no
      // target; a read never participates in CAS and says so. `operationAccess`
      // is the single authority on which kinds are writes (write | apply_patch
      // | edit | format_json) — `mutates` is narrower and would silently drop
      // the apply_patch identity onto 'unchecked', disabling the queue-window
      // CAS on the main editing channel.
      expectedIdentity:
        operationAccess(call.operation.kind) === 'write'
          ? (expectedIdentity ?? 'missing')
          : 'unchecked',
    });
    if (result.kind === 'read_image') {
      return {
        kind: 'read_image',
        bytes: Buffer.from(result.base64, 'base64'),
        mimeType: result.mimeType,
      };
    }
    return result;
  }
  async function writeLockTarget(
    call: Omit<FilesystemExecuteInput, 'operation'>,
    path: string,
    semantics: 'target' | 'entry' = 'target',
  ): Promise<{ key: string; canonicalPath: string }> {
    const worker = workerFor(call.executionBoundary);
    if (!worker) {
      return await input.workspace.writeLockKey({
        cwd: call.cwd,
        path,
        semantics,
      });
    }
    if (semantics === 'entry') {
      const resolved = await resolveCanonicalDirectoryEntryTarget(call.cwd, path);
      return { key: resolved.path, canonicalPath: resolved.path };
    }
    const normalized = await normalizeSandboxBoundaryPath({
      path,
      access: 'write',
      scope: 'exact',
      cwd: await canonicalExistingPath(call.cwd),
    });
    return { key: normalized.enforcementPath, canonicalPath: normalized.enforcementPath };
  }
  async function resolveTarget(inputArg: {
    cwd: string;
    path: string;
    semantics: 'target' | 'entry';
    executionBoundary?: ExecutionBoundary;
    permissionMode?: PermissionMode;
    abortSignal?: AbortSignal;
  }): Promise<ResolvedTarget> {
    const { key, canonicalPath } = await writeLockTarget(
      {
        cwd: inputArg.cwd,
        ...(inputArg.executionBoundary ? { executionBoundary: inputArg.executionBoundary } : {}),
        ...(inputArg.permissionMode ? { permissionMode: inputArg.permissionMode } : {}),
        ...(inputArg.abortSignal ? { abortSignal: inputArg.abortSignal } : {}),
      },
      inputArg.path,
      inputArg.semantics,
    );
    // Capture the target's stable identity at T0, before entering the lease
    // queue. Execute re-resolves it only after admission on this prepared key.
    // Content operations follow the final symlink (stat); create/delete pin the
    // directory entry (lstat) so a swapped link is caught against the entry's
    // own inode. canonicalPath remains executable while leaseKey is used for
    // both the Scheduler claim and coordinator admission.
    const identity = await captureFilesystemTargetIdentity(
      canonicalPath,
      inputArg.semantics === 'target',
    );
    return {
      canonicalPath,
      leaseKey: hostFilesystemLeaseKey(key),
      identity: toTargetIdentity(identity, inputArg.semantics),
    };
  }
  return {
    resolveTarget,
    run,
  };
}

/**
 * The union of inputs the filesystem authority can prepare: an `execute`-style
 * operation (read/write/edit/format_json/glob/grep) or an `apply_patch` op.
 * The path is read from `operation.path` in both cases.
 */
export type FilesystemAuthorityInput = FilesystemExecuteInput | FilesystemApplyPatchInput;

/**
 * The process-visible identity captured at prepare-time (T0), expressed in the
 * authority's vocabulary. A create target with no on-disk inode is `missing`.
 */
function toTargetIdentity(
  identity: FilesystemTargetIdentity | undefined,
  semantics: 'target' | 'entry',
): TargetIdentity {
  if (!identity) return { kind: 'missing' };
  return semantics === 'target'
    ? { kind: 'file', dev: identity.dev, ino: identity.ino }
    : { kind: 'entry', dev: identity.dev, ino: identity.ino };
}

function toExpectedIdentity(identity: TargetIdentity): FilesystemTargetIdentity | undefined {
  if (identity.kind === 'missing') return undefined;
  return { dev: identity.dev, ino: identity.ino };
}

function filesystemSemantics(target: FilesystemAuthorityInput): 'target' | 'entry' {
  if (isApplyPatchInput(target)) {
    const operation = target.operation as ApplyPatchOperation;
    return operation.type === 'update_file' ? 'target' : 'entry';
  }
  return 'target';
}

function isApplyPatchInput(target: FilesystemAuthorityInput): boolean {
  const operation = (target as FilesystemApplyPatchInput).operation as unknown;
  return (
    typeof operation === 'object' &&
    operation !== null &&
    'type' in operation &&
    (operation as { type?: unknown }).type !== undefined
  );
}

function isWriteOperation(target: FilesystemAuthorityInput): boolean {
  if (isApplyPatchInput(target)) return true;
  return operationAccess((target as FilesystemExecuteInput).operation.kind) === 'write';
}

function isSearchOperation(target: FilesystemAuthorityInput): boolean {
  if (isApplyPatchInput(target)) return false;
  const kind = (target as FilesystemExecuteInput).operation.kind;
  return kind === 'glob' || kind === 'grep';
}

function toBackendOperation(target: FilesystemAuthorityInput): {
  path: string;
  operation: FilesystemWorkerClientOperation;
} {
  if (isApplyPatchInput(target)) {
    const operation = (target as FilesystemApplyPatchInput).operation as ApplyPatchOperation;
    const backend: FilesystemWorkerClientOperation =
      operation.type === 'delete_file'
        ? { kind: 'apply_patch', path: operation.path, action: 'delete' }
        : {
            kind: 'apply_patch',
            path: operation.path,
            action: operation.type === 'create_file' ? 'create' : 'update',
            diff: operation.diff,
          };
    return { path: operation.path, operation: backend };
  }
  const operation = (target as FilesystemExecuteInput).operation as FilesystemOperation;
  return { path: operation.path, operation };
}

export function claimFromFilesystemLease(request: FilesystemLeaseRequest): KeyedResourceClaim {
  return {
    kind: 'keyed',
    authority: 'filesystem:workspace',
    key: request.key,
    mode: request.mode,
    scope: request.scope,
  };
}

function filesystemLeaseFor(
  target: FilesystemAuthorityInput,
  leaseKey: string,
): FilesystemLeaseRequest {
  return {
    key: leaseKey,
    mode: isWriteOperation(target) ? 'write' : 'read',
    scope: isSearchOperation(target) ? 'tree' : 'exact',
  };
}

function toBackendCall(
  target: FilesystemAuthorityInput,
  context: Pick<AuthorityContext, 'cwd' | 'executionBoundary' | 'permissionMode' | 'abortSignal'>,
  signal?: AbortSignal,
): FilesystemBackendExecuteInput {
  const { operation } = toBackendOperation(target);
  return {
    operation,
    cwd: context.cwd,
    ...(context.executionBoundary ? { executionBoundary: context.executionBoundary } : {}),
    ...(context.permissionMode ? { permissionMode: context.permissionMode } : {}),
    ...((signal ?? context.abortSignal) ? { abortSignal: signal ?? context.abortSignal } : {}),
  };
}

function replaceOperationPath(
  call: FilesystemBackendExecuteInput,
  canonicalPath: string,
): FilesystemBackendExecuteInput {
  return { ...call, operation: { ...call.operation, path: canonicalPath } };
}

interface PreparedFilesystemAccess {
  readonly target: FilesystemAuthorityInput;
  readonly semantics: 'target' | 'entry';
  readonly resolved: ResolvedTarget;
  readonly lease: FilesystemLeaseRequest;
}

export class FilesystemPreparedTargetChangedError extends Error {
  override readonly name = 'FilesystemPreparedTargetChangedError';
  readonly code = 'filesystem_prepared_target_changed';

  constructor() {
    super('The approved filesystem target changed before execution.');
  }
}

function assertSamePreparedTarget(prepared: ResolvedTarget, now: ResolvedTarget): void {
  if (
    prepared.canonicalPath !== now.canonicalPath ||
    prepared.leaseKey !== now.leaseKey ||
    identityChanged(prepared.identity, now.identity)
  ) {
    throw new FilesystemPreparedTargetChangedError();
  }
}

function resourceArgsFor(
  target: FilesystemAuthorityInput,
  context: Pick<AuthorityContext, 'cwd' | 'executionBoundary' | 'permissionMode' | 'abortSignal'>,
  signal?: AbortSignal,
): Parameters<FilesystemBackend['resolveTarget']>[0] {
  const { path } = toBackendOperation(target);
  return {
    cwd: context.cwd,
    path,
    semantics: filesystemSemantics(target),
    ...(context.executionBoundary ? { executionBoundary: context.executionBoundary } : {}),
    ...(context.permissionMode ? { permissionMode: context.permissionMode } : {}),
    ...((signal ?? context.abortSignal) ? { abortSignal: signal ?? context.abortSignal } : {}),
  };
}

async function prepareFilesystemAccess(
  backend: FilesystemBackend,
  target: FilesystemAuthorityInput,
  context: Pick<AuthorityContext, 'cwd' | 'executionBoundary' | 'permissionMode' | 'abortSignal'>,
): Promise<PreparedFilesystemAccess> {
  const semantics = filesystemSemantics(target);
  const resolved = await backend.resolveTarget(resourceArgsFor(target, context));
  return {
    target,
    semantics,
    resolved,
    lease: filesystemLeaseFor(target, resolved.leaseKey),
  };
}

function directContext(
  input: Pick<
    FilesystemExecuteInput,
    'cwd' | 'executionBoundary' | 'permissionMode' | 'abortSignal'
  >,
): Pick<AuthorityContext, 'cwd' | 'executionBoundary' | 'permissionMode' | 'abortSignal'> {
  return input;
}

export interface FilesystemResourceAuthority
  extends ResourceAuthority<FilesystemAuthorityInput, unknown> {
  preparePatchBatch(
    operations: readonly ApplyPatchOperation[],
    context: AuthorityContext,
  ): Promise<PreparedOperation<ApplyPatchBatchResult>>;
}

export interface FilesystemResourceOwner {
  readonly executor: FilesystemExecutor;
  readonly authority: FilesystemResourceAuthority;
}

export function createFilesystemResourceOwner(
  input: BoundaryFilesystemExecutorInput,
): FilesystemResourceOwner {
  const backend = buildFilesystemBackend(input);
  const coordinator = input.filesystemLeaseCoordinator ?? processFilesystemLeases;

  const executeAccess = async (
    access: PreparedFilesystemAccess,
    context: Pick<AuthorityContext, 'cwd' | 'executionBoundary' | 'permissionMode' | 'abortSignal'>,
    signal?: AbortSignal,
  ): Promise<FilesystemResult> => {
    const abortSignal = signal ?? context.abortSignal;
    return await coordinator.withLease(access.lease, abortSignal, async () => {
      const now = await backend.resolveTarget(resourceArgsFor(access.target, context, signal));
      assertSamePreparedTarget(access.resolved, now);
      const call = replaceOperationPath(
        toBackendCall(access.target, context, signal),
        now.canonicalPath,
      );
      try {
        return await backend.run(
          call,
          access.lease.mode === 'write' ? toExpectedIdentity(now.identity) : undefined,
        );
      } catch (error) {
        throw access.lease.mode === 'write' ? settleMutationFailure(error) : error;
      }
    });
  };

  const preparePatchAccesses = async (
    operations: readonly ApplyPatchOperation[],
    context: Pick<AuthorityContext, 'cwd' | 'executionBoundary' | 'permissionMode' | 'abortSignal'>,
  ): Promise<readonly PreparedFilesystemAccess[]> =>
    await Promise.all(
      operations.map((operation) =>
        prepareFilesystemAccess(backend, { operation, ...context }, context),
      ),
    );

  const executePatchBatch = async (
    accesses: readonly PreparedFilesystemAccess[],
    context: Pick<AuthorityContext, 'cwd' | 'executionBoundary' | 'permissionMode' | 'abortSignal'>,
    signal?: AbortSignal,
  ): Promise<ApplyPatchBatchResult> => {
    const requests = normalizeFilesystemLeaseRequests(accesses.map((access) => access.lease));
    const abortSignal = signal ?? context.abortSignal;
    return await coordinator.withLeases(requests, abortSignal, async () => {
      const preflight: ResolvedTarget[] = [];
      for (let index = 0; index < accesses.length; index += 1) {
        const access = accesses[index]!;
        try {
          const now = await backend.resolveTarget(resourceArgsFor(access.target, context, signal));
          assertSamePreparedTarget(access.resolved, now);
          preflight.push(now);
        } catch (error) {
          const operation = (access.target as FilesystemApplyPatchInput).operation;
          return {
            status: 'failed',
            applied: [],
            failed: { type: operation.type, path: operation.path },
            error: `ApplyPatch preflight failed for ${operation.type} ${operation.path}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      let operationIndex = 0;
      const seenLeaseKeys = new Set<string>();
      const operations = accesses.map(
        (access) => (access.target as FilesystemApplyPatchInput).operation,
      );
      return await executeApplyPatchOperations(
        operations,
        async (operation) => {
          const index = operationIndex++;
          const access = accesses[index]!;
          let now = preflight[index]!;
          if (seenLeaseKeys.has(access.lease.key)) {
            now = await backend.resolveTarget(resourceArgsFor(access.target, context, signal));
          }
          seenLeaseKeys.add(access.lease.key);
          const call = replaceOperationPath(
            toBackendCall({ operation, ...context }, context, signal),
            now.canonicalPath,
          );
          try {
            const result = await backend.run(call, toExpectedIdentity(now.identity));
            if (result.kind !== 'apply_patch') {
              throw new Error(`ApplyPatch backend returned ${JSON.stringify(result.kind)}.`);
            }
          } catch (error) {
            throw settleMutationFailure(error);
          }
        },
        abortSignal,
      );
    });
  };

  const authority: FilesystemResourceAuthority = {
    async prepare(target, context): Promise<PreparedOperation<unknown>> {
      const access = await prepareFilesystemAccess(backend, target, context);
      return oneShotOperation({
        claims: [claimFromFilesystemLease(access.lease)],
        execute: async (signal) => await executeAccess(access, context, signal),
      });
    },
    async preparePatchBatch(operations, context) {
      const accesses = await preparePatchAccesses(operations, context);
      const requests = normalizeFilesystemLeaseRequests(accesses.map((access) => access.lease));
      return oneShotOperation({
        claims: requests.map(claimFromFilesystemLease),
        execute: async (signal) => await executePatchBatch(accesses, context, signal),
      });
    },
  };

  const executor: FilesystemExecutor = {
    async execute(call) {
      const context = directContext(call);
      const access = await prepareFilesystemAccess(backend, call, context);
      return await executeAccess(access, context, call.abortSignal);
    },
    async applyPatch(call) {
      const context = directContext(call);
      const access = await prepareFilesystemAccess(backend, call, context);
      const result = await executeAccess(access, context, call.abortSignal);
      if (result.kind !== 'apply_patch') {
        throw new Error(`ApplyPatch backend returned ${JSON.stringify(result.kind)}.`);
      }
      return { status: 'completed' };
    },
    async applyPatchBatch(call) {
      const context = directContext(call);
      const accesses = await preparePatchAccesses(call.operations, context);
      return await executePatchBatch(accesses, context, call.abortSignal);
    },
  };

  return { executor, authority };
}

export function createBoundaryFilesystemExecutor(
  input: BoundaryFilesystemExecutorInput,
): FilesystemExecutor {
  return createFilesystemResourceOwner(input).executor;
}

export function createFilesystemResourceAuthority(
  input: BoundaryFilesystemExecutorInput,
): FilesystemResourceAuthority {
  return createFilesystemResourceOwner(input).authority;
}

/**
 * Settle a failed mutation into its caller-facing error. A pinned-primitive
 * failure maps by code: `outcome_unknown` (the write may have partially
 * applied) becomes ToolOutcomeUnknownError, `path_changed` becomes a plain
 * error with the primitive's actionable message. Worker failures keep the
 * post-dispatch classification from the authority contract.
 */
function settleMutationFailure(error: unknown): unknown {
  if (error instanceof StableWriteFailure) {
    if (error.code === 'outcome_unknown') {
      return new ToolOutcomeUnknownError(error.message, { cause: error });
    }
    return new Error(error.message, { cause: error });
  }
  if (classifyFailedMutationOutcome(error) === 'unknown') {
    return new ToolOutcomeUnknownError(
      'Filesystem mutation may have been applied before the worker failed.',
      { cause: error },
    );
  }
  return error;
}

interface WorkspaceFilesystemBackend {
  execute(
    input: FilesystemBackendExecuteInput,
    scope: WorkspacePathScope,
    expectedIdentity?: FilesystemTargetIdentity,
  ): Promise<FilesystemResult>;
}

/**
 * Run an operation directly against the host (or an isolated workspace), with the
 * path scope the caller derived from the boundary. This backend enforces the
 * scope it is given and decides nothing else.
 */
function createWorkspaceFilesystemExecutor(
  workspace: FilesystemWorkspaceExecutor,
): WorkspaceFilesystemBackend {
  return {
    async execute({ operation, cwd, abortSignal }, scope, expectedIdentity) {
      switch (operation.kind) {
        case 'read': {
          const { path } = await workspace.resolveExistingPath({
            cwd,
            path: operation.path,
            label: 'Read',
            scope,
          });
          const result = await workspace.readFile({
            cwd,
            path,
            ...(operation.offset !== undefined ? { offset: operation.offset } : {}),
            ...(operation.limit !== undefined ? { limit: operation.limit } : {}),
          });
          if ('bytes' in result) {
            return { kind: 'read_image', bytes: result.bytes, mimeType: result.mimeType };
          }
          return { kind: 'read', content: result.content };
        }
        case 'write': {
          const { path } = await workspace.resolveWritablePath({
            cwd,
            path: operation.path,
            label: 'Write',
            scope,
          });
          if (workspace.readModifyWrite) {
            // Pinned RMW (#2600): open once, validate the T0 identity on the
            // descriptor, write through it. previous feeds the diff below.
            const result = await workspace.readModifyWrite({
              cwd,
              path,
              label: 'Write',
              scope,
              approvedIdentity: expectedIdentity,
              transform: () => operation.content,
            });
            const diff =
              result.previous === 'unknown'
                ? undefined
                : createUnifiedDiff(
                    path,
                    result.previous === 'new' ? undefined : result.previous,
                    operation.content,
                  );
            return {
              kind: 'write',
              ok: true,
              path,
              bytes: Buffer.byteLength(operation.content, 'utf8'),
              ...(diff !== undefined ? { diff } : {}),
            };
          }
          // Fallback (remote/isolated workspace): path-based, unprotected by
          // the identity authority.
          let previous: 'new' | 'unknown' | string;
          try {
            const read = await workspace.readFile({ cwd, path });
            previous = 'bytes' in read ? 'unknown' : read.content;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            previous = code === 'ENOENT' || code === 'ENOTDIR' ? 'new' : 'unknown';
          }
          const written = await workspace.writeFile({ cwd, path, content: operation.content });
          const diff =
            previous === 'unknown'
              ? undefined
              : createUnifiedDiff(
                  written.path,
                  previous === 'new' ? undefined : previous,
                  operation.content,
                );
          return {
            kind: 'write',
            ok: true,
            path: written.path,
            bytes: written.bytes,
            ...(diff !== undefined ? { diff } : {}),
          };
        }
        case 'apply_patch': {
          if (!workspace.applyPatch) throw new Error('Workspace does not support ApplyPatch');
          const common = { cwd, path: operation.path, label: 'ApplyPatch', scope };
          if (operation.action === 'update' && workspace.readModifyWrite) {
            // update requires an existing target: resolve first (ENOENT guard,
            // matching the worker's resolveExistingAllowed) so a missing target
            // is rejected without the exclusive create ever running.
            const { path } = await workspace.resolveExistingPath({
              cwd,
              path: operation.path,
              label: 'ApplyPatch',
              scope,
            });
            await workspace.readModifyWrite({
              ...common,
              path,
              approvedIdentity: expectedIdentity,
              transform: (ctx) => applyUpdateToContent(ctx.content ?? '', operation.diff),
            });
            return { kind: 'apply_patch', ok: true, path };
          }
          const patched = await workspace.applyPatch(
            operation.action === 'delete'
              ? {
                  ...common,
                  action: 'delete' as const,
                  ...(expectedIdentity ? { approvedIdentity: expectedIdentity } : {}),
                }
              : { ...common, action: operation.action, diff: operation.diff },
          );
          return { kind: 'apply_patch', ok: true, path: patched.path };
        }
        case 'edit': {
          const { path } = await workspace.resolveExistingPath({
            cwd,
            path: operation.path,
            label: 'Edit',
            scope,
          });
          if (isSupportedImagePath(path)) throw new Error('Edit does not support image files.');
          if (workspace.readModifyWrite) {
            let edited!: ReturnType<typeof computeEditedSource>;
            let originalContent = '';
            await workspace.readModifyWrite({
              cwd,
              path,
              label: 'Edit',
              scope,
              approvedIdentity: expectedIdentity,
              transform: (ctx) => {
                originalContent = ctx.content ?? '';
                edited = computeEditedSource(
                  originalContent,
                  operation.oldString,
                  operation.newString,
                  operation.path,
                );
                return edited.content;
              },
            });
            const diff = createEditUnifiedDiff(path, originalContent, edited.content, edited);
            return {
              kind: 'edit',
              ok: true,
              path,
              replacements: 1,
              matchedVia: edited.matchedVia,
              startLine: edited.startLine,
              endLine: edited.endLine,
              ...(diff !== undefined ? { diff } : {}),
            };
          }
          const read = await workspace.readFile({ cwd, path });
          if ('bytes' in read) throw new Error('Edit does not support image files.');
          const edited = computeEditedSource(
            read.content,
            operation.oldString,
            operation.newString,
            operation.path,
          );
          await workspace.writeFile({ cwd, path, content: edited.content });
          const diff = createEditUnifiedDiff(path, read.content, edited.content, edited);
          return {
            kind: 'edit',
            ok: true,
            path,
            replacements: 1,
            matchedVia: edited.matchedVia,
            startLine: edited.startLine,
            endLine: edited.endLine,
            ...(diff !== undefined ? { diff } : {}),
          };
        }
        case 'format_json': {
          const { path } = await workspace.resolveExistingPath({
            cwd,
            path: operation.path,
            label: 'FormatJson',
            scope,
          });
          if (isSupportedImagePath(path)) {
            throw new Error('FormatJson does not support image files.');
          }
          if (workspace.readModifyWrite) {
            let parseError: string | undefined;
            let original = '';
            const result = await workspace.readModifyWrite({
              cwd,
              path,
              label: 'FormatJson',
              scope,
              approvedIdentity: expectedIdentity,
              transform: (ctx) => {
                original = ctx.content ?? '';
                try {
                  const value = operation.sortKeys
                    ? sortKeysDeep(JSON.parse(original))
                    : JSON.parse(original);
                  return JSON.stringify(value, null, 2);
                } catch (error) {
                  parseError = error instanceof Error ? error.message : 'parse failed';
                  return null;
                }
              },
            });
            const bytesBefore = Buffer.byteLength(original, 'utf8');
            if (parseError !== undefined || result.finalContent === null) {
              return {
                kind: 'format_json',
                ok: false,
                valid: false,
                error: `FormatJson: invalid JSON: ${parseError ?? 'parse failed'}`,
                path,
                bytesBefore,
                byteDelta: 0,
                changed: false,
              };
            }
            const formatted = result.finalContent;
            const bytesAfter = Buffer.byteLength(formatted, 'utf8');
            const diff =
              formatted === original ? undefined : createUnifiedDiff(path, original, formatted);
            return {
              kind: 'format_json',
              ok: true,
              valid: true,
              path,
              bytesBefore,
              bytesAfter,
              byteDelta: bytesAfter - bytesBefore,
              changed: formatted !== original,
              ...(diff !== undefined ? { diff } : {}),
            };
          }
          const read = await workspace.readFile({ cwd, path });
          if ('bytes' in read) throw new Error('FormatJson does not support image files.');
          const original = read.content;
          const bytesBefore = Buffer.byteLength(original, 'utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(original);
          } catch (error) {
            return {
              kind: 'format_json',
              ok: false,
              valid: false,
              error: `FormatJson: invalid JSON: ${(error as Error).message}`,
              path,
              bytesBefore,
              byteDelta: 0,
              changed: false,
            };
          }
          const value = operation.sortKeys ? sortKeysDeep(parsed) : parsed;
          const formatted = JSON.stringify(value, null, 2);
          const { bytes: bytesAfter } = await workspace.writeFile({
            cwd,
            path,
            content: formatted,
          });
          const diff =
            formatted === original ? undefined : createUnifiedDiff(path, original, formatted);
          return {
            kind: 'format_json',
            ok: true,
            valid: true,
            path,
            bytesBefore,
            bytesAfter,
            byteDelta: bytesAfter - bytesBefore,
            changed: formatted !== original,
            ...(diff !== undefined ? { diff } : {}),
          };
        }
        case 'glob': {
          assertGlobPatternInScope(operation.pattern, scope);
          const { path: base } = await workspace.resolveExistingPath({
            cwd,
            path: operation.path,
            label: 'Glob cwd',
            scope,
          });
          const { files } = await workspace.globFiles({
            cwd: base,
            pattern: operation.pattern,
            ...(operation.limit !== undefined ? { limit: operation.limit } : {}),
          });
          return { kind: 'glob', files };
        }
        case 'grep': {
          const { path } = await workspace.resolveExistingPath({
            cwd,
            path: operation.path,
            label: 'Grep',
            scope,
          });
          const { matches } = await workspace.grepFiles({
            cwd,
            pattern: operation.pattern,
            path,
            ...(operation.glob ? { glob: operation.glob } : {}),
            maxCountPerFile: operation.maxCountPerFile,
            limit: operation.limit,
            timeoutMs: operation.timeoutMs,
            ...(abortSignal ? { abortSignal } : {}),
          });
          return { kind: 'grep', matches };
        }
      }
    },
  };
}

/**
 * A glob pattern is expanded by the walker rather than resolved as a path, so
 * its escapes have to be caught lexically. Under host scope there is nothing to
 * escape from and the pattern is left alone.
 */
function assertGlobPatternInScope(pattern: string, scope: WorkspacePathScope): void {
  if (scope === 'host') return;
  if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) {
    throw new Error('Glob pattern must stay inside session cwd');
  }
}

/** The canonical spelling of an existing directory, or the input when it is not resolvable here. */
async function canonicalExistingPath(path: string): Promise<string> {
  return await realpath(path).catch(() => path);
}

// Object.fromEntries creates own data properties, so special keys like
// "__proto__" are preserved instead of triggering the inherited setter.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
