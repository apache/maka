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

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ARTIFACT_IMAGE_PREVIEW_MAX_BYTES } from '@maka/core/artifacts';
import {
  checkedChatImage,
  ImageSourceError,
  localImagePath,
  type ChatImageBytes,
} from './chat-image-source.js';

/** Avatar capture is narrower than Read (even for a full-access Session).
 * The cwd is the invoking tool Session's persisted workspace, never the Host cwd
 * or the conversation owner's workspace. Keep the normal Session filesystem
 * authority as well: this containment check is not a replacement for it.
 */
export async function readAvatarImageSource(
  source: string,
  signal: AbortSignal,
  ports: {
    workspace(): Promise<string>;
    readLocal(path: string, signal: AbortSignal): Promise<ChatImageBytes>;
    download(source: string, signal: AbortSignal): Promise<ChatImageBytes>;
  },
): Promise<ChatImageBytes> {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  boundedSignal.throwIfAborted();
  const path = localImagePath(source);
  if (path === undefined) {
    // The Host downloader uses public-target DNS pinning, manual redirects
    // (each hop is checked), streamed byte limits and its outbound proxy policy.
    const image = await ports.download(source, boundedSignal);
    boundedSignal.throwIfAborted();
    return checkedChatImage(image.bytes, 'avatar');
  }
  const cwd = await ports.workspace();
  if (!isAbsolute(cwd)) throw new ImageSourceError('not_allowed');
  const root = await realpath(cwd);
  const target = await realpath(resolve(root, path));
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new ImageSourceError('not_allowed');
  const before = await stat(target);
  if (!before.isFile()) throw new ImageSourceError('not_allowed');
  if (before.size > ARTIFACT_IMAGE_PREVIEW_MAX_BYTES) throw new ImageSourceError('too_large');
  boundedSignal.throwIfAborted();
  const image = await ports.readLocal(target, boundedSignal);
  boundedSignal.throwIfAborted();
  // Reject observed replacements during capture. As with the existing Session
  // image reader, this is not an OS-level defense against concurrent hostile
  // filesystem mutation; that requires descriptor-relative runtime/worker reads.
  const after = await stat(target);
  if (
    (await realpath(resolve(root, path))) !== target ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  )
    throw new ImageSourceError('not_allowed');
  return checkedChatImage(image.bytes, 'avatar');
}
