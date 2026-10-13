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
  FILE_WRITE_EVIDENCE_CONTRACT,
  isFileWriteObservation,
  type FileIdentity,
  type FileWriteDirectories,
  type FileWriteObservation,
} from '@maka/core/file-write-evidence';
import { createUnifiedDiff } from './unified-diff.js';
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
): FileWriteObservation['result'] {
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
  const limit = FILE_WRITE_EVIDENCE_CONTRACT.maxFileBytes;
  const buffer = Buffer.alloc(limit + 1);
  let size = 0;
  while (size < buffer.length) {
    const read = await handle.read(buffer, size, buffer.length - size, size);
    if (read.bytesRead === 0) break;
    size += read.bytesRead;
  }
  return size > limit ? undefined : buffer.subarray(0, size);
}

/** Called only after the owning executor has authorized and canonicalized both paths. */
export async function prepareFileWrite(
  cwd: string,
  path: string,
  content: string,
  hostDirectories?: FileWriteDirectories,
): Promise<FileWriteObservation | undefined> {
  const next = Buffer.from(content, 'utf8');
  if (next.length > FILE_WRITE_EVIDENCE_CONTRACT.maxFileBytes || next.toString('utf8') !== content)
    return;
  // Unsupported observations do not upgrade the existing conservative Write contract.
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
    let before: FileWriteObservation['before'] = { kind: 'missing' };
    let previous: string | undefined;
    if (metadata) {
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > BigInt(FILE_WRITE_EVIDENCE_CONTRACT.maxFileBytes)
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
        previous = bytes.toString('utf8');
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
    const observation: FileWriteObservation = {
      contract: FILE_WRITE_EVIDENCE_CONTRACT,
      workspace,
      target,
      before,
      after: { bytes: next.length, digest: contentDigest(next) },
      result: buildFileWriteResult(path, content, previous ?? 'new'),
    };
    return isFileWriteObservation(observation) ? observation : undefined;
  } catch {
    // Write-only grants, non-regular files and unavailable metadata remain legacy writes.
    return undefined;
  }
}

/** Validate through the descriptor that will be mutated, before any truncate. */
export async function executePreparedFileWrite(
  cwd: string,
  path: string,
  content: string,
  observation: FileWriteObservation,
  hostDirectories?: FileWriteDirectories,
): Promise<FileWriteObservation['result']> {
  const changed = () =>
    new StableWriteFailure(
      'path_changed',
      'The prepared Write target changed; re-read before writing.',
    );
  const next = Buffer.from(content, 'utf8');
  if (
    !isFileWriteObservation(observation) ||
    cwd !== observation.workspace.path ||
    path !== observation.target.path ||
    next.length !== observation.after.bytes ||
    contentDigest(next) !== observation.after.digest
  )
    throw changed();
  if (
    !sameIdentity(
      hostDirectories?.workspace ?? (await directoryIdentity(cwd)),
      observation.workspace.identity,
    ) ||
    !sameIdentity(
      hostDirectories?.parent ?? (await directoryIdentity(dirname(path))),
      observation.target.parentIdentity,
    )
  )
    throw changed();
  const prior = observation.before;
  // A missing target is created only here, after T1, using exclusive creation.
  const handle = await openStableTarget({
    path,
    approvedIdentity: prior.kind === 'file' ? prior.identity : undefined,
    targetType: prior.kind === 'file' ? 'file' : 'missing',
  });
  try {
    // The worker's synthetic parent directories are not host identities. Its
    // launcher already revalidated these and pins the approved mount sources.
    const sameDirectories =
      hostDirectories !== undefined ||
      (await Promise.all([directoryIdentity(cwd), directoryIdentity(dirname(path))])
        .then(
          ([workspace, parent]) =>
            sameIdentity(workspace, observation.workspace.identity) &&
            sameIdentity(parent, observation.target.parentIdentity),
        )
        .catch(() => false));
    if (!sameDirectories) {
      if (prior.kind === 'missing')
        throw new StableWriteFailure(
          'outcome_unknown',
          'The prepared Write directory changed after exclusive creation.',
        );
      throw changed();
    }
    if (prior.kind === 'file') {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile()) throw changed();
      const bytes = await readBounded(handle);
      if (!bytes || bytes.length !== prior.bytes || contentDigest(bytes) !== prior.digest)
        throw changed();
      const visibility = await hostVisibilityAfterWrite(path, handle);
      if (visibility) throw changed();
    }
    await writeThroughHandle(handle, content);
    const visibility = await hostVisibilityAfterWrite(path, handle);
    if (visibility) throw visibility;
    return structuredClone(observation.result);
  } finally {
    await handle.close();
  }
}
