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

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  FILE_MUTATION_MAX_BYTES,
  FileMutationGuardSchema,
  type FileMutation,
  type FileMutationPreparation,
  type FileWriteResult,
  type FileEditResult,
  type FileIdentity,
  type FileMutationDirectories,
  type FileMutationGuard,
} from './file-mutation-guard-contract.js';
import { createUnifiedDiff, createEditUnifiedDiff } from './unified-diff.js';
import { computeEditedSource, type EditMatch } from './edit-replace.js';
import {
  hostVisibilityAfterWrite,
  openStableTarget,
  StableWriteFailure,
  writeThroughHandle,
} from './file-stable-write.js';

function identity(metadata: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: String(metadata.dev), ino: String(metadata.ino) };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function contentDigest(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Shared production Write result, including the existing prior-content convention. */
export function buildFileWriteResult(
  path: string,
  content: string,
  previous: string,
): FileWriteResult {
  const diff =
    previous === 'unknown'
      ? undefined
      : createUnifiedDiff(path, previous === 'new' ? undefined : previous, content);
  return {
    kind: 'write',
    ok: true,
    path,
    bytes: Buffer.byteLength(content, 'utf8'),
    ...(diff === undefined ? {} : { diff }),
  };
}

async function directoryIdentity(path: string): Promise<FileIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('Not a stable directory');
  return identity(metadata);
}

/** Bounded even if a concurrent writer grows the file after fstat. */
async function readBounded(handle: FileHandle): Promise<Buffer | undefined> {
  const limit = FILE_MUTATION_MAX_BYTES;
  const buffer = Buffer.alloc(limit + 1);
  let size = 0;
  while (size < buffer.length) {
    const read = await handle.read(buffer, size, buffer.length - size, size);
    if (read.bytesRead === 0) break;
    size += read.bytesRead;
  }
  return size > limit ? undefined : buffer.subarray(0, size);
}

export function buildFileEditResult(
  path: string,
  previous: string,
  edited: EditMatch,
): FileEditResult {
  const diff = createEditUnifiedDiff(path, previous, edited.content, edited);
  return {
    kind: 'edit',
    ok: true,
    path,
    replacements: 1,
    matchedVia: edited.matchedVia,
    startLine: edited.startLine,
    endLine: edited.endLine,
    ...(diff === undefined ? {} : { diff }),
  };
}

/** Keep Edit matching failures actionable across the worker boundary. */
export class FileMutationEditConflict extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : 'Edit could not be applied.');
    this.name = 'FileMutationEditConflict';
  }
}

function transform(path: string, mutation: FileMutation, previous: string | undefined) {
  if (mutation.kind === 'write')
    return {
      content: mutation.content,
      result: buildFileWriteResult(path, mutation.content, previous ?? 'new'),
    };
  if (previous === undefined) throw new Error('Edit requires an existing file');
  let edited: EditMatch;
  try {
    edited = computeEditedSource(previous, mutation.oldString, mutation.newString, path);
  } catch (error) {
    throw new FileMutationEditConflict(error);
  }
  return { content: edited.content, result: buildFileEditResult(path, previous, edited) };
}

/** Pure input eligibility check, before any file observation or content transport. */
export function fileMutationInputEligible(mutation: FileMutation): boolean {
  const inputs =
    mutation.kind === 'write' ? [mutation.content] : [mutation.oldString, mutation.newString];
  return inputs.every(
    (input) =>
      Buffer.byteLength(input, 'utf8') <= FILE_MUTATION_MAX_BYTES &&
      Buffer.from(input, 'utf8').toString('utf8') === input,
  );
}

/** Called only after the owning executor has authorized and canonicalized both paths. */
export async function prepareFileMutation(
  cwd: string,
  path: string,
  preparation: FileMutationPreparation,
  hostDirectories?: FileMutationDirectories,
): Promise<FileMutationGuard | undefined> {
  // Authorization still runs before this helper, including for ineligible inputs.
  if (!preparation.eligible) return;
  // Unsupported targets retain ordinary execution, without a content guard.
  try {
    const workspace = {
      path: cwd,
      identity: hostDirectories?.workspace ?? (await directoryIdentity(cwd)),
    };
    const target = {
      path,
      parentIdentity: hostDirectories?.parent ?? (await directoryIdentity(dirname(path))),
    };
    const metadata = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    let before: FileMutationGuard['before'] = { kind: 'missing' };
    if (metadata) {
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > BigInt(FILE_MUTATION_MAX_BYTES)
      )
        return;
      const handle = await open(
        path,
        constants.O_RDONLY |
          (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
      );
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || !sameIdentity(identity(metadata), identity(opened))) return;
        const bytes = await readBounded(handle);
        if (!bytes || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) return;
        if (await hostVisibilityAfterWrite(path, handle)) return;
        before = {
          kind: 'file',
          identity: identity(opened),
          bytes: bytes.length,
          digest: contentDigest(bytes),
        };
      } finally {
        await handle.close();
      }
    }
    if (preparation.kind === 'edit' && before.kind === 'missing') return;
    const guard: FileMutationGuard = { kind: preparation.kind, workspace, target, before };
    return FileMutationGuardSchema.safeParse(guard).success ? guard : undefined;
  } catch {
    return undefined;
  }
}

/** Validate through the descriptor that will be mutated, before any truncate. */
export async function executePreparedFileMutation(
  cwd: string,
  path: string,
  mutation: FileMutation,
  guard: FileMutationGuard,
  hostDirectories?: FileMutationDirectories,
): Promise<FileWriteResult | FileEditResult> {
  const changed = () =>
    new StableWriteFailure(
      'path_changed',
      'The prepared file mutation target changed; re-read before writing.',
    );
  if (
    !FileMutationGuardSchema.safeParse(guard).success ||
    cwd !== guard.workspace.path ||
    path !== guard.target.path ||
    mutation.kind !== guard.kind
  )
    throw changed();
  if (
    !sameIdentity(
      hostDirectories?.workspace ?? (await directoryIdentity(cwd)),
      guard.workspace.identity,
    ) ||
    !sameIdentity(
      hostDirectories?.parent ?? (await directoryIdentity(dirname(path))),
      guard.target.parentIdentity,
    )
  )
    throw changed();
  const prior = guard.before;
  // A missing Write target is created only here, after T1, using exclusive creation.
  const handle = await openStableTarget({
    path,
    approvedIdentity: prior.kind === 'file' ? prior.identity : undefined,
    targetType: prior.kind === 'file' ? 'file' : 'missing',
  });
  try {
    // Only Linux mount namespaces receive hostDirectories; their launcher validates
    // pinned mount sources and host visibility before dispatch and after completion.
    const sameDirectories =
      hostDirectories !== undefined ||
      (await Promise.all([directoryIdentity(cwd), directoryIdentity(dirname(path))])
        .then(
          ([workspace, parent]) =>
            sameIdentity(workspace, guard.workspace.identity) &&
            sameIdentity(parent, guard.target.parentIdentity),
        )
        .catch(() => false));
    if (!sameDirectories) {
      if (prior.kind === 'missing')
        throw new StableWriteFailure(
          'outcome_unknown',
          'The prepared directory changed after exclusive creation.',
        );
      throw changed();
    }
    let previous: string | undefined;
    if (prior.kind === 'file') {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile()) throw changed();
      const bytes = await readBounded(handle);
      if (!bytes || bytes.length !== prior.bytes || contentDigest(bytes) !== prior.digest)
        throw changed();
      if (await hostVisibilityAfterWrite(path, handle)) throw changed();
      previous = bytes.toString('utf8');
    }
    const next = transform(path, mutation, previous);
    await writeThroughHandle(handle, next.content);
    const visibility = await hostVisibilityAfterWrite(path, handle);
    if (visibility) throw visibility;
    return next.result;
  } finally {
    await handle.close();
  }
}
