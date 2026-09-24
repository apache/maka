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

import { constants } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;

export async function readWorkspaceTextFile(
  cwd: string,
  path: string,
  line?: number | null,
  limit?: number | null,
): Promise<string> {
  if (line != null && (!Number.isSafeInteger(line) || line < 1))
    throw new Error('ACP file line must be a positive integer');
  if (limit != null && (!Number.isSafeInteger(limit) || limit < 0))
    throw new Error('ACP file limit must be a non-negative integer');
  const file = await openWorkspaceFile(cwd, path, false);
  try {
    const info = await file.stat();
    if (info.size > MAX_TEXT_FILE_BYTES) throw new Error('ACP text file is too large');
    const text = await file.readFile('utf8');
    const start = line == null ? 0 : line - 1;
    return line != null || limit != null
      ? text
          .split('\n')
          .slice(start, limit == null ? undefined : start + limit)
          .join('\n')
      : text;
  } finally {
    await file.close();
  }
}

export async function writeWorkspaceTextFile(
  cwd: string,
  path: string,
  content: string,
): Promise<void> {
  if (Buffer.byteLength(content) > MAX_TEXT_FILE_BYTES)
    throw new Error('ACP text file is too large');
  const file = await openWorkspaceFile(cwd, path, true);
  try {
    // Validation happens against this exact open file descriptor before any
    // existing content is truncated, so later path swaps cannot redirect data.
    await file.truncate(0);
    await file.writeFile(content, 'utf8');
  } finally {
    await file.close();
  }
}

async function openWorkspaceFile(
  cwd: string,
  path: string,
  forWrite: boolean,
): Promise<FileHandle> {
  if (!isAbsolute(path)) throw new Error('ACP file path must be absolute');
  const root = await realpath(cwd);
  const candidate = resolve(path);

  if (forWrite) {
    const parent = await realpath(dirname(candidate));
    assertContained(root, parent);
    const entry = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (entry?.isSymbolicLink()) throw new Error('ACP file path could not be resolved');
  }

  const flags = forWrite
    ? constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0)
    : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const file = await open(candidate, flags, 0o600);
  try {
    const opened = await file.stat();
    if (!opened.isFile()) throw new Error('ACP file path is not a regular file');

    // Resolve and compare after opening. If the path or an ancestor changed
    // between lookup and open, either containment or file identity no longer
    // matches. Operations after this point use only the verified descriptor.
    const canonical = await realpath(candidate);
    assertContained(root, canonical);
    const current = await stat(canonical);
    if (opened.dev !== current.dev || opened.ino !== current.ino)
      throw new Error('ACP file path changed during validation');
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

function assertContained(root: string, candidate: string): void {
  const relation = relative(root, candidate);
  if (relation === '..' || relation.startsWith('../') || isAbsolute(relation))
    throw new Error('ACP file path leaves the workspace');
}
