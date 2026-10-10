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

import { fileURLToPath } from 'node:url';
import { ARTIFACT_IMAGE_PREVIEW_MAX_BYTES } from '@maka/core/artifacts';
import {
  ImageFileError,
  imageFileFailureReason,
  validateImageBytes,
} from '@maka/runtime/image-file';
import {
  isImageDeliverySource,
  isRemoteImageSource,
  type ImageDeliveryFailure,
} from '@maka/core/image-delivery';
import {
  createProxiedFetchTransport,
  PublicNetworkPolicyError,
  type ScopedFetch,
} from '@maka/runtime/network/scoped-fetch-transport';
export class ImageSourceError extends Error {
  constructor(readonly reason: ImageDeliveryFailure) {
    super(reason);
  }
}
export interface ChatImageBytes {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}
export function checkedChatImage(bytes: Uint8Array): ChatImageBytes {
  try {
    return validateImageBytes(bytes, 'chat');
  } catch (error) {
    if (!(error instanceof ImageFileError)) throw error;
    throw new ImageSourceError(imageFileFailureReason(error));
  }
}
export function localImagePath(source: string): string | undefined {
  if (isRemoteImageSource(source)) return undefined;
  if (source.startsWith('file:')) {
    try {
      return fileURLToPath(source);
    } catch {
      throw new ImageSourceError('not_allowed');
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source))
    throw new ImageSourceError('not_allowed');
  return source;
}

/** A missing literal path may be a URL-encoded Markdown destination. File URLs
 * already went through fileURLToPath; never decode them a second time. */
export function decodedLocalImagePath(source: string): string | undefined {
  if (source.startsWith('file:') || isRemoteImageSource(source)) return undefined;
  try {
    const decoded = decodeURIComponent(source);
    return decoded !== source && isImageDeliverySource(decoded) ? decoded : undefined;
  } catch {
    // A literal percent sign or incomplete escape is a valid filesystem name.
    return undefined;
  }
}
/** Network routing and public destination checks belong to the transport.
 * Only validated image bytes cross the archive boundary. */
export async function downloadChatImage(
  source: string,
  signal: AbortSignal,
  options: { readonly fetch?: ScopedFetch } = {},
): Promise<ChatImageBytes> {
  const owned = options.fetch ? undefined : createProxiedFetchTransport(null);
  const fetch = options.fetch ?? owned!.fetch;
  try {
    let url = new URL(source);
    for (let redirect = 0; redirect <= 3; redirect++) {
      signal.throwIfAborted();
      const response = await fetch(url, {
        targetPolicy: 'public',
        signal,
        headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' },
        redirect: 'manual',
        credentials: 'omit',
      });
      const location = response.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        await response.body?.cancel();
        const next = new URL(location, url);
        if (url.protocol === 'https:' && next.protocol !== 'https:')
          throw new ImageSourceError('not_allowed');
        url = next;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new ImageSourceError('download_failed');
      }
      if (Number(response.headers.get('content-length')) > ARTIFACT_IMAGE_PREVIEW_MAX_BYTES) {
        await response.body?.cancel();
        throw new ImageSourceError('too_large');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > ARTIFACT_IMAGE_PREVIEW_MAX_BYTES) throw new ImageSourceError('too_large');
            chunks.push(Buffer.from(chunk.value));
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      return checkedChatImage(Buffer.concat(chunks, size));
    }
    throw new ImageSourceError('download_failed');
  } catch (error) {
    if (error instanceof PublicNetworkPolicyError) throw new ImageSourceError('not_allowed');
    throw error;
  } finally {
    await owned?.close();
  }
}
