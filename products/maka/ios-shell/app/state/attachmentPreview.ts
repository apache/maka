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

/// <reference lib="es2024.arraybuffer" />

import { cleanup, effect, signal, untracked, type Accessor } from 'nsh';
import type {
  AgentAttachmentImagePage,
  AgentAttachmentImageRead,
  AgentAttachmentImageSource,
} from '../../../../../packages/plugin-sdk/src/generated/runtime';
import { hostQuery } from '../bridge';
import { isPreviewableImage, type AttachmentInfo } from './attachments';
import { historyAddressKey } from './chat';

export type { AgentAttachmentImageSource } from '../../../../../packages/plugin-sdk/src/generated/runtime';

type ImageLocation =
  | { kind: 'local'; url: string }
  | { kind: 'remote'; source: AgentAttachmentImageSource };
type Preview = { info: AttachmentInfo; location: ImageLocation; draftKey?: number };
type PreviewState = { request: Preview } & (
  | { kind: 'loading' }
  | { kind: 'ready'; url: string }
  | { kind: 'failed' }
);

const maxImageBytes = 32 * 1024 * 1024;
const pageBytes = 32 * 1024;
const maxBase64Length = Math.ceil(pageBytes / 3) * 4;
const digestFormat = /^sha256:[a-f0-9]{64}$/;
const maxCacheBytes = 48 * 1024 * 1024;
const maxCacheEntries = 24;

function sourceKey(source: AgentAttachmentImageSource) {
  switch (source.kind) {
    case 'uploaded':
    case 'artifact':
      return [source.kind, source.id];
    case 'room':
      return [source.kind, source.messageId, source.attachmentIndex];
    case 'history':
      return [
        source.kind,
        source.through,
        historyAddressKey(source.position),
        source.attachmentIndex,
      ];
  }
}

type Download = {
  data?: {
    digest: string;
    mimeType: string;
    bytes: Uint8Array<ArrayBuffer>;
    hash: ReturnType<typeof crypto.createHash>;
  };
};

function releaseDownload(download: Download) {
  // A Host call may still be suspended. Detach its assembly buffer without
  // waiting for that call or for the collector.
  download.data?.bytes.buffer.transfer(0);
  download.data = undefined;
}

function acceptPage(
  download: Download,
  page: AgentAttachmentImagePage,
  source: string,
  offset: number,
) {
  if (
    page.kind !== 'ready' ||
    JSON.stringify(sourceKey(page.source)) !== source ||
    page.offset !== offset ||
    !Number.isSafeInteger(page.totalBytes) ||
    page.totalBytes <= 0 ||
    page.totalBytes > maxImageBytes ||
    !isPreviewableImage(page.mimeType) ||
    !digestFormat.test(page.digest) ||
    !page.data.length ||
    page.data.length > maxBase64Length
  ) {
    throw new Error('Invalid attachment image page');
  }
  const chunk = atob(page.data);
  if (!chunk.length || chunk.length > pageBytes || chunk.length > page.totalBytes - offset) {
    throw new Error('Invalid attachment image chunk length');
  }
  const data = (download.data ??= {
    digest: page.digest,
    mimeType: page.mimeType,
    bytes: new Uint8Array(page.totalBytes),
    hash: crypto.createHash('sha256'),
  });
  if (
    page.digest !== data.digest ||
    page.mimeType !== data.mimeType ||
    page.totalBytes !== data.bytes.length
  ) {
    throw new Error('Attachment image changed during download');
  }
  for (let i = 0; i < chunk.length; i++) data.bytes[offset + i] = chunk.charCodeAt(i);
  const end = offset + chunk.length;
  data.hash.update(data.bytes.subarray(offset, end));
  return end;
}

async function readImage(
  rootId: string,
  sessionId: string,
  source: AgentAttachmentImageSource,
  download: Download,
  current: () => boolean,
) {
  const expectedSource = JSON.stringify(sourceKey(source));
  let offset = 0;
  for (let pages = 1; current(); pages++) {
    const input = { sessionId, source, offset } satisfies AgentAttachmentImageRead;
    const page = await hostQuery<AgentAttachmentImagePage>(
      'agent',
      'attachmentImage',
      input,
      undefined,
      rootId,
    );
    if (!current()) return;

    offset = acceptPage(download, page, expectedSource, offset);
    const { bytes, digest, mimeType, hash } = download.data!;
    if (offset === bytes.length) {
      if ('sha256:' + hash.digest('hex') !== digest)
        throw new Error('Attachment image digest mismatch');
      return new Blob([bytes], { type: mimeType });
    }
    // The Host can shorten a page to fit its envelope, but an image should
    // not take arbitrarily many round trips just because each page advances.
    if (pages >= Math.ceil(bytes.length / pageBytes) + 64) {
      throw new Error('Attachment image exceeded its page budget');
    }
  }
}

export function createAttachmentPreview(
  rootId: string,
  sessionId: string,
  active: Accessor<boolean>,
  generation: Accessor<number | undefined>,
) {
  // Only the active chat keeps a cache. Draft URLs belong to the composer.
  const cache = new Map<string, { url: string; bytes: number }>();
  let cachedBytes = 0;
  const state = signal<PreviewState | null>(null);
  let downloading: Download | undefined;
  const cancelDownload = () => {
    if (downloading) releaseDownload(downloading);
    downloading = undefined;
  };
  const close = () => {
    cancelDownload();
    state.set(null);
  };
  const keyFor = (source: AgentAttachmentImageSource) =>
    JSON.stringify([rootId, sessionId, ...sourceKey(source)]);

  const evict = (key: string) => {
    const entry = cache.get(key)!;
    cache.delete(key);
    cachedBytes -= entry.bytes;
    URL.revokeObjectURL(entry.url);
  };
  const clearCache = () => {
    for (const key of cache.keys()) evict(key);
  };

  async function open(preview: Preview) {
    if (!active()) return;
    cancelDownload();
    const { location } = preview;
    if (location.kind === 'local') {
      state.set({ request: preview, kind: 'ready', url: location.url });
      return;
    }
    const epoch = generation();
    if (epoch === undefined) {
      state.set({ request: preview, kind: 'failed' });
      return;
    }
    const key = keyFor(location.source);
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      state.set({ request: preview, kind: 'ready', url: cached.url });
      return;
    }
    const download: Download = {};
    downloading = download;
    state.set({ request: preview, kind: 'loading' });
    // A Host query doesn't expose an abort handle. Stop at the in-flight
    // page and discard its reply (including when reopening the same image).
    const current = () => downloading === download && active() && generation() === epoch;
    try {
      const blob = await readImage(rootId, sessionId, location.source, download, current);
      if (!blob || !current()) return;
      const url = URL.createObjectURL(blob);
      cache.set(key, { url, bytes: blob.size });
      cachedBytes += blob.size;
      while (cache.size > maxCacheEntries || cachedBytes > maxCacheBytes) {
        evict(cache.keys().next().value!);
      }
      state.set({ request: preview, kind: 'ready', url });
    } catch (cause) {
      if (!current()) return;
      console.warn('Could not load attachment image', cause);
      state.set({ request: preview, kind: 'failed' });
    } finally {
      if (downloading === download) cancelDownload();
    }
  }

  effect(() => {
    const shown = active();
    generation();
    untracked(() => {
      if (!shown) close();
      else {
        cancelDownload();
        const preview = state();
        if (preview && preview.request.location.kind === 'remote' && preview.kind !== 'failed') {
          state.set({ request: preview.request, kind: 'failed' });
        }
      }
      clearCache();
    });
  });
  cleanup(() => {
    close();
    clearCache();
  });

  return {
    state,
    open,
    close,
    retry() {
      const preview = state();
      if (preview?.kind === 'failed') void open(preview.request);
    },
    imageFailed(url: string, message: string) {
      const preview = state();
      if (preview?.kind !== 'ready' || preview.url !== url) return;
      console.warn('Could not display attachment image', message);
      if (preview.request.location.kind === 'remote')
        evict(keyFor(preview.request.location.source));
      state.set({ request: preview.request, kind: 'failed' });
    },
  };
}

export type AttachmentPreview = ReturnType<typeof createAttachmentPreview>;
