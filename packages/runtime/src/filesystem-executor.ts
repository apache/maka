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
import { createUnifiedDiff } from './unified-diff.js';
import {
  classifyFailedMutationOutcome,
  type FilesystemTargetIdentity,
} from './filesystem-authority.js';
import { StableWriteFailure } from './file-stable-write.js';
import { applyUpdateToContent } from './apply-patch-file.js';
import { withFileWriteLock } from './file-write-lock.js';
import type {
  FilesystemWorkerClient,
  FilesystemWorkerClientOperation,
} from './filesystem-worker/client.js';
import { isSupportedImagePath, type ImageMimeType } from './image-file.js';
import type { FilesystemWorkerResult } from './filesystem-worker/protocol.js';
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

/** Operations that read, modify and write back, and so must hold the target's lock. */
function mutates(operation: FilesystemOperation): boolean {
  return (
    operation.kind === 'write' || operation.kind === 'edit' || operation.kind === 'format_json'
  );
}

/**
 * Capture the target's stable identity at lock acquisition (T0) — *before*
 * waiting for the write lock. This is the inode the worker compare-and-swaps
 * against, so a path replaced while the call is queued for the lock is detected
 * rather than silently written. Returns undefined when the target does not yet
 * exist (a create), since there is no inode to pin.
 *
 * `follow` must match how the worker derives the targetType: content operations
 * follow the final symlink (stat), create/delete pin the directory entry (lstat)
 * so a swapped link is detected against the entry's own inode.
 */
async function captureIdentityAtLockAcquisition(
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
export function createBoundaryFilesystemExecutor(
  input: BoundaryFilesystemExecutorInput,
): FilesystemExecutor {
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
      ...(expectedIdentity ? { expectedIdentity } : {}),
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
      const key = (
        await input.workspace.writeLockKey({
          cwd: call.cwd,
          path,
          semantics,
        })
      ).key;
      return { key, canonicalPath: key };
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
  return {
    async execute(call) {
      if (!mutates(call.operation)) return await run(call);
      // Canonicalisation without any containment check, so a target the policy
      // goes on to reject still takes the same lock as its other spellings. The
      // key is derived from the same canonicalisation the backend will resolve
      // with, or the lock-key space and the resolved-path space drift apart.
      const { key, canonicalPath } = await writeLockTarget(call, call.operation.path);
      // Capture the target identity at lock acquisition (T0), BEFORE waiting
      // for the lock, for BOTH backends — the worker CAS and the local pinned
      // read-modify-write compare against this inode. Content operations follow
      // the final symlink (stat); apply_patch create/delete use 'entry'
      // semantics but execute() only handles write/edit/format_json here.
      const expectedIdentity = await captureIdentityAtLockAcquisition(canonicalPath, true);
      try {
        return await withFileWriteLock(key, () => run(call, expectedIdentity));
      } catch (error) {
        throw settleMutationFailure(error);
      }
    },
    async applyPatch(call) {
      const { operation, ...common } = call;
      const semantics = operation.type === 'update_file' ? 'target' : 'entry';
      const { key, canonicalPath } = await writeLockTarget(common, operation.path, semantics);
      // Capture identity at T0 (before the lock wait), for both backends.
      // update_file follows the target (stat); create/delete pin the directory
      // entry (lstat).
      const expectedIdentity = await captureIdentityAtLockAcquisition(
        canonicalPath,
        semantics === 'target',
      );
      try {
        return await withFileWriteLock(key, async () => {
          const backendOperation: FilesystemWorkerClientOperation =
            operation.type === 'delete_file'
              ? { kind: 'apply_patch', path: operation.path, action: 'delete' }
              : {
                  kind: 'apply_patch',
                  path: operation.path,
                  action: operation.type === 'create_file' ? 'create' : 'update',
                  diff: operation.diff,
                };
          const result = await run({ ...common, operation: backendOperation }, expectedIdentity);
          if (result.kind !== 'apply_patch') {
            throw new Error(`ApplyPatch backend returned ${JSON.stringify(result.kind)}.`);
          }
          return { status: 'completed' };
        });
      } catch (error) {
        throw settleMutationFailure(error);
      }
    },
  };
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
            const result = await workspace.readModifyWrite({
              cwd,
              path,
              label: 'Edit',
              scope,
              approvedIdentity: expectedIdentity,
              transform: (ctx) => {
                edited = computeEditedSource(
                  ctx.content ?? '',
                  operation.oldString,
                  operation.newString,
                  operation.path,
                );
                return edited.content;
              },
            });
            const diff = createUnifiedDiff(
              path,
              result.previous === 'unknown' || result.previous === 'new' ? '' : result.previous,
              result.finalContent ?? '',
            );
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
          const diff = createUnifiedDiff(path, read.content, edited.content);
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
