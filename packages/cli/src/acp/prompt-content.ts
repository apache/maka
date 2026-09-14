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

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestError, type ContentBlock } from '@agentclientprotocol/sdk';
import {
  attachmentKindFromMimeType,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  PDF_HEADER_SCAN_BYTES,
  resolveAttachmentMimeType,
} from '@maka/core/attachments';
import type { AttachmentRef, MessageContent } from '@maka/core/events';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import { ARTIFACT_INGEST_CHUNK_MAX_BYTES } from '@maka/runtime-host/protocol';

interface OpenedPromptFile {
  readonly size: number;
  readonly isFile: boolean;
  readonly prefix: Uint8Array;
  readonly canonicalPath: string;
}

export interface AcpPromptContentDependencies {
  readonly openFile?: (path: string) => Promise<OpenedPromptFile>;
}

export async function mapAcpPromptContent(
  prompt: readonly ContentBlock[],
  dependencies: AcpPromptContentDependencies = {},
): Promise<MessageContent> {
  const resources = prompt.filter(
    (block): block is Extract<ContentBlock, { type: 'resource_link' }> =>
      block.type === 'resource_link',
  );
  if (resources.length > MAX_ATTACHMENT_COUNT) {
    throw invalidPrompt('prompt', 'too_many_attachments');
  }
  for (const block of prompt) {
    if (block.type !== 'text' && block.type !== 'resource_link') {
      throw invalidPrompt('prompt', 'unsupported_content_type');
    }
  }

  const modelParts: string[] = [];
  const displayParts: string[] = [];
  const attachments: AttachmentRef[] = [];
  for (const block of prompt) {
    if (block.type === 'text') {
      modelParts.push(block.text);
      displayParts.push(block.text);
      continue;
    }
    if (block.type !== 'resource_link') {
      throw invalidPrompt('prompt', 'unsupported_content_type');
    }
    const path = localFilePath(block.uri);
    const file = await (dependencies.openFile ?? readPromptFile)(path).catch((error: unknown) => {
      if (error instanceof RequestError) throw error;
      throw invalidPrompt('prompt', 'resource_unreadable');
    });
    if (!file.isFile) throw invalidPrompt('prompt', 'resource_not_file');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_ATTACHMENT_BYTES) {
      throw invalidPrompt('prompt', 'resource_too_large');
    }
    const name = block.name || basename(file.canonicalPath);
    const mimeType = resolveAttachmentMimeType(file.prefix, block.mimeType ?? undefined, name);
    modelParts.push(block.uri);
    attachments.push({
      kind: attachmentKindFromMimeType(mimeType, name),
      name,
      mimeType,
      bytes: file.size,
      ref: { kind: 'external_file', absolutePath: file.canonicalPath },
    });
  }
  const text = modelParts.join('\n\n');
  const displayText = displayParts.join('\n\n');
  return {
    text,
    ...(displayText !== text ? { displayText } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/** Publish only after live attachment succeeds, before admitting the prompt's Turn. */
export async function publishAcpPromptAttachments(
  content: MessageContent,
  options: {
    readonly sessionId: string;
    readonly connection: Pick<RuntimeHostConnection, 'request'>;
    readonly assertActive: () => void;
  },
): Promise<MessageContent> {
  const attachments: AttachmentRef[] = [];
  for (const attachment of content.attachments ?? []) {
    options.assertActive();
    if (attachment.ref.kind !== 'external_file') {
      attachments.push(attachment);
      continue;
    }
    const bytes = await readPromptAttachment(attachment.ref.absolutePath, options.assertActive);
    options.assertActive();
    const uploadId = randomUUID();
    const identity = { sessionId: options.sessionId, uploadId };
    let opened = false;
    try {
      const begin = await options.connection.request('artifact.ingest', {
        kind: 'begin',
        ...identity,
        name: attachment.name,
        mimeType: resolveAttachmentMimeType(bytes, attachment.mimeType, attachment.name),
        totalBytes: bytes.length,
        contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      });
      if (begin.kind === 'committed') {
        options.assertActive();
        attachments.push(begin.attachment);
        continue;
      }
      if (begin.kind !== 'upload_opened') {
        throw new Error('Runtime Host did not open the Attachment upload');
      }
      opened = true;
      let offset = begin.nextOffset;
      while (offset < bytes.length) {
        options.assertActive();
        const chunk = bytes.subarray(offset, offset + ARTIFACT_INGEST_CHUNK_MAX_BYTES);
        const accepted = await options.connection.request('artifact.ingest', {
          kind: 'chunk',
          ...identity,
          offset,
          chunkBase64: chunk.toString('base64'),
        });
        if (accepted.kind !== 'chunk_accepted' || accepted.nextOffset !== offset + chunk.length) {
          throw new Error('Runtime Host did not advance the Attachment upload');
        }
        offset = accepted.nextOffset;
      }
      options.assertActive();
      const committed = await options.connection.request('artifact.ingest', {
        kind: 'commit',
        ...identity,
      });
      if (committed.kind !== 'committed') {
        throw new Error('Runtime Host did not commit the Attachment upload');
      }
      opened = false;
      options.assertActive();
      attachments.push(committed.attachment);
    } catch (error) {
      if (opened) {
        await options.connection
          .request('artifact.ingest', { kind: 'abort', ...identity })
          .catch(() => undefined);
      }
      throw error;
    }
  }
  options.assertActive();
  return content.attachments ? { ...content, attachments } : content;
}

async function readPromptAttachment(path: string, assertActive: () => void): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw invalidPrompt('prompt', 'resource_unreadable');
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw invalidPrompt('prompt', 'resource_not_file');
    if (!Number.isSafeInteger(stats.size) || stats.size < 0 || stats.size > MAX_ATTACHMENT_BYTES) {
      throw invalidPrompt('prompt', 'resource_too_large');
    }
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      assertActive();
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(ARTIFACT_INGEST_CHUNK_MAX_BYTES, bytes.length - offset),
        offset,
      );
      if (bytesRead === 0) throw invalidPrompt('prompt', 'resource_changed');
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== bytes.length) {
      throw invalidPrompt('prompt', 'resource_changed');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readPromptFile(path: string): Promise<OpenedPromptFile> {
  // A FIFO must not wait for a writer before we can reject it.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw invalidPrompt('prompt', 'resource_not_file');
    const prefix = Buffer.alloc(Math.min(PDF_HEADER_SCAN_BYTES, stats.size));
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    return {
      size: stats.size,
      isFile: stats.isFile(),
      prefix: prefix.subarray(0, bytesRead),
      canonicalPath: await realpath(path),
    };
  } finally {
    await handle.close();
  }
}

function localFilePath(uri: string): string {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw invalidPrompt('prompt', 'invalid_resource_uri');
  }
  if (
    url.protocol !== 'file:' ||
    url.hostname !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw invalidPrompt('prompt', 'unsupported_resource_uri');
  }
  try {
    return fileURLToPath(url);
  } catch {
    throw invalidPrompt('prompt', 'invalid_resource_uri');
  }
}

function invalidPrompt(field: string, reason: string): RequestError {
  return RequestError.invalidParams({ field, reason }, 'Invalid ACP prompt content');
}
