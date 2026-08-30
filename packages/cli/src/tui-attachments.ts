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

import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { attachmentKindFromMimeType, guessMimeFromName } from '@maka/core/attachments';
import type { AttachmentRef } from '@maka/core/events';

/**
 * Draft-scoped staging for TUI image attachments (issue #4171).
 *
 * The Runtime Host artifact authority is the only durable store. A `/attach`
 * pick stages nothing but a client-local descriptor; the bytes are read and
 * ingested through `artifact.ingest` inside the message-submit boundary, and
 * the committed Message's AttachmentRef is the durable identity from then on.
 * A staged item can also be a retained ref (an already-committed artifact that
 * came back with a retracted queued message) — resubmitting reuses it instead
 * of re-ingesting. Nothing here is an authority over stored bytes; every entry
 * points at (or waits on) a Host-owned Artifact.
 */

/** A client-local image the user picked. `path` never serializes into content. */
export interface LocalImageDescriptor {
  readonly kind: 'local';
  readonly stagingKey: string;
  readonly name: string;
  readonly mimeType: string;
  readonly path: string;
  /** File size at stage time, for display only. */
  readonly bytes: number;
}

/** An already-committed Session Artifact carried back by a retracted message. */
export interface RetainedImageAttachment {
  readonly kind: 'retained';
  readonly stagingKey: string;
  readonly attachment: AttachmentRef;
}

export type StagedImage = LocalImageDescriptor | RetainedImageAttachment;

/**
 * One live draft's staged images, ordered. Submit consumes the list in order;
 * a descriptor that finished its ingest is replaced in place by its retained
 * ref so a failed dispatch (or a refusal) retries with the same Artifact
 * instead of orphaning a second copy of the bytes.
 */
export class TuiImageStaging {
  readonly #items: StagedImage[] = [];

  stageFile(descriptor: Omit<LocalImageDescriptor, 'kind' | 'stagingKey'>): LocalImageDescriptor {
    const item: LocalImageDescriptor = { kind: 'local', stagingKey: randomUUID(), ...descriptor };
    this.#items.push(item);
    return item;
  }

  stageRetained(attachment: AttachmentRef): RetainedImageAttachment {
    const item: RetainedImageAttachment = {
      kind: 'retained',
      stagingKey: randomUUID(),
      attachment,
    };
    this.#items.push(item);
    return item;
  }

  /** Swap a just-ingested descriptor for its committed ref, keeping its order. */
  replace(key: string, attachment: AttachmentRef): void {
    const index = this.#items.findIndex((item) => item.stagingKey === key);
    if (index < 0) return;
    this.#items[index] = {
      kind: 'retained',
      stagingKey: key,
      attachment,
    };
  }

  remove(key: string): StagedImage | undefined {
    const index = this.#items.findIndex((item) => item.stagingKey === key);
    return index < 0 ? undefined : this.#items.splice(index, 1)[0];
  }

  list(): readonly StagedImage[] {
    return [...this.#items];
  }

  get size(): number {
    return this.#items.length;
  }

  clear(): readonly StagedImage[] {
    return this.#items.splice(0, this.#items.length);
  }
}

/** The composer-strip label for one staged image: name and media type only — never a path. */
export function stagedImageLabel(item: StagedImage): string {
  const bytes = item.kind === 'local' ? item.bytes : item.attachment.bytes;
  const name = item.kind === 'local' ? item.name : item.attachment.name;
  const mimeType = item.kind === 'local' ? item.mimeType : item.attachment.mimeType;
  return `📎 ${name} · ${mimeType} · ${formatAttachmentBytes(bytes)}`;
}

export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// Client-side file helpers (bytes stay client-side until the submit boundary)
// ============================================================================

export interface LocalImageFile {
  readonly absolutePath: string;
  readonly name: string;
  readonly mimeType: string;
}

export function expandHomePath(rawPath: string): string {
  const trimmed = rawPath
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/^'(.*)'$/s, '$1');
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function resolveLocalImageFile(rawPath: string, cwd: string): LocalImageFile {
  const expanded = expandHomePath(rawPath);
  const absolutePath = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  const name = basename(absolutePath);
  const mimeType = guessMimeFromName(name);
  return { absolutePath, name, mimeType };
}

export function isImageMimeType(mimeType: string, fileName: string): boolean {
  return attachmentKindFromMimeType(mimeType, fileName) === 'image';
}

/**
 * Read at most `maxBytes` bytes, rejecting a larger file before it loads. Reads
 * one extra byte so a TOCTOU where the file grows between stat and read cannot
 * smuggle an oversized buffer into the ingest path.
 */
export async function readFileCapped(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = new Uint8Array(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) {
      throw new Error(
        `Image exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB attachment limit.`,
      );
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
