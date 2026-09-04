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
import { open, type FileHandle } from 'node:fs/promises';
import { isSupportedImagePath, validateImageBytes, type ImageMimeType } from './image-file.js';
import { StableWriteFailure } from './file-stable-write.js';

export type StableReadExpectedIdentity = { readonly dev: string; readonly ino: string } | 'missing';

/**
 * Open and pin the object observed at filesystem admission. The descriptor
 * validation is the load-bearing check: pathname replacement between resolve
 * and open cannot redirect the subsequent read to another inode.
 */
export async function openStableReadTarget(input: {
  path: string;
  expectedIdentity: StableReadExpectedIdentity;
}): Promise<FileHandle> {
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  // When admission also saw missing, an unchanged path naturally preserves the
  // ordinary ENOENT result from open().
  const handle: FileHandle = await open(input.path, constants.O_RDONLY | noFollow);

  if (input.expectedIdentity === 'missing') {
    await handle.close();
    throw new StableWriteFailure(
      'path_changed',
      'The target appeared after filesystem admission; the replacement was not read.',
    );
  }

  try {
    const metadata = await handle.stat({ bigint: true });
    if (
      String(metadata.dev) !== input.expectedIdentity.dev ||
      String(metadata.ino) !== input.expectedIdentity.ino
    ) {
      throw new StableWriteFailure(
        'path_changed',
        'The approved filesystem target changed before it could be read.',
      );
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readStableTarget(input: {
  path: string;
  expectedIdentity: StableReadExpectedIdentity;
  offset?: number;
  limit?: number;
}): Promise<
  { readonly content: string } | { readonly bytes: Uint8Array; readonly mimeType: ImageMimeType }
> {
  const handle = await openStableReadTarget(input);
  try {
    if (isSupportedImagePath(input.path)) {
      return validateImageBytes(await handle.readFile());
    }
    const content = await handle.readFile('utf8');
    if (input.offset === undefined && input.limit === undefined) return { content };
    const lines = content.split('\n');
    const start = input.offset ?? 0;
    const end = input.limit ? start + input.limit : lines.length;
    return { content: lines.slice(start, end).join('\n') };
  } finally {
    await handle.close();
  }
}
