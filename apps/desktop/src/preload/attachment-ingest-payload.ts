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

import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';

export type IngestInput =
  | { approvalId: string; name: string; mimeType?: string }
  | { file: File };

export type IngestPayload =
  | { approvalId: string; name: string; mimeType?: string }
  | { name: string; mimeType?: string; base64: string };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function encodeIngestItems(items: IngestInput[]): Promise<IngestPayload[]> {
  if (items.length > MAX_ATTACHMENT_COUNT) throw new Error('附件数量超过 8 个');
  const out: IngestPayload[] = [];
  for (const item of items) {
    if ('file' in item) {
      // Reject oversized blobs before arrayBuffer() so the renderer never
      // loads the bytes into memory. Main-side resolveIngestItems is the
      // authoritative backstop; this guard exists only to avoid renderer OOM.
      if (item.file.size > MAX_ATTACHMENT_BYTES) throw new Error('附件大小超过 50MB');
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      const mimeType = item.file.type || undefined;
      out.push({
        name: item.file.name || 'clipboard-image.png',
        ...(mimeType ? { mimeType } : {}),
        base64: bytesToBase64(bytes),
      });
    } else if (typeof item.approvalId === 'string') {
      out.push(item);
    } else {
      throw new Error('附件信息无效。');
    }
  }
  return out;
}