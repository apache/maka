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

// Host filesystem operations with serialized, identity-checked writes.

import { Buffer } from 'node:buffer';
import { readPage } from './read-page.js';
import { lstat, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ToolOutcomeUnknownError } from '@maka/core/events';
import { computeEditedSource } from './edit-replace.js';
import { createEditUnifiedDiff, createUnifiedDiff } from './unified-diff.js';
import { type FilesystemTargetIdentity } from './filesystem-authority.js';
import { StableWriteFailure } from './file-stable-write.js';
import { applyUpdateToContent } from './apply-patch-file.js';
import { withFileWriteLock } from './file-write-lock.js';
import { isSupportedImagePath } from './image-file.js';
import {
  FilesystemOperationSchema,
  operationAccess,
  type FilesystemBackendOperation,
  type FilesystemResult,
} from './filesystem-contract.js';
export type { FilesystemResult } from './filesystem-contract.js';
import type {
  WorkspaceEditExecutor,
  WorkspaceApplyPatchExecutor,
  WorkspacePathScope,
  WorkspaceReadModifyWriteExecutor,
  WorkspaceSearchExecutor,
  WorkspaceWriteExecutor,
} from './workspace-executor.js';

export type FilesystemOperation = Exclude<FilesystemBackendOperation, { kind: 'apply_patch' }>;

export interface FilesystemExecuteInput {
  operation: FilesystemOperation;
  cwd: string;
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

export interface FilesystemExecutorInput {
  workspace: FilesystemWorkspaceExecutor;
}

/**
 * Capture the target's stable identity at lock acquisition (T0) — *before*
 * waiting for the write lock. This is the inode the executor compare-and-swaps
 * against, so a path replaced while the call is queued for the lock is detected
 * rather than silently written. Returns undefined when the target does not yet
 * exist (a create), since there is no inode to pin.
 *
 * `follow` must match the operation’s target type: content operations
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

export function createFilesystemExecutor(input: FilesystemExecutorInput): FilesystemExecutor {
  const local = createWorkspaceFilesystemExecutor(input.workspace);
  async function run(
    call: FilesystemBackendExecuteInput,
    expectedIdentity?: FilesystemTargetIdentity,
  ): Promise<FilesystemResult> {
    if (call.operation.kind === 'read')
      FilesystemOperationSchema.parse({ ...call.operation, cwd: call.cwd });
    return await local.execute(call, 'host', expectedIdentity);
  }
  async function writeLockTarget(
    call: Omit<FilesystemExecuteInput, 'operation'>,
    path: string,
    semantics: 'target' | 'entry' = 'target',
  ): Promise<{ key: string; canonicalPath: string }> {
    const { key } = await input.workspace.writeLockKey({ cwd: call.cwd, path, semantics });
    return { key, canonicalPath: key };
  }
  return {
    async execute(call) {
      if (operationAccess(call.operation.kind) !== 'write') return await run(call);
      // Aliases share the same canonical write lock.
      const { key, canonicalPath } = await writeLockTarget(call, call.operation.path);
      // Capture the target identity at lock acquisition (T0), BEFORE waiting
      // for the lock; pinned read-modify-write compares against this inode. Content operations follow
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
      // Capture identity at T0 (before the lock wait), before mutating the file.
      // update_file follows the target (stat); create/delete pin the directory
      // entry (lstat).
      const expectedIdentity = await captureIdentityAtLockAcquisition(
        canonicalPath,
        semantics === 'target',
      );
      try {
        return await withFileWriteLock(key, async () => {
          const backendOperation: FilesystemBackendOperation =
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
            abortSignal,
          });
          if ('bytes' in result) {
            return { kind: 'read_image', bytes: result.bytes, mimeType: result.mimeType };
          }
          return {
            kind: 'read',
            ...readPage(result.content, operation, undefined, operation.continuation),
          };
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
            // Updating requires an existing target; reject a missing file before creation.
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
            abortSignal,
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
          const result = await workspace.grepFiles({
            cwd,
            pattern: operation.pattern,
            path,
            ...(operation.glob ? { glob: operation.glob } : {}),
            maxCountPerFile: operation.maxCountPerFile,
            limit: operation.limit,
            timeoutMs: operation.timeoutMs,
            ...(abortSignal ? { abortSignal } : {}),
          });
          return { kind: 'grep', ...result };
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
