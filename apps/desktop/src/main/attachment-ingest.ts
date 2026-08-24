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

import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  attachmentKindFromMimeType,
  guessMimeFromName,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
} from '@maka/core/attachments';
import type { ArtifactKind } from '@maka/core/artifacts';
import type { AttachmentRef } from '@maka/core/events';
import type { AttachmentApprovalRegistry } from './attachment-approval.js';

export type AttachmentIngestFile =
  | { path: string; mimeType?: string; size: number }
  | { name: string; mimeType?: string; size: number; content: Uint8Array };

export interface AttachmentSnapshotInput {
  name: string;
  mimeType: string;
  artifactKind: ArtifactKind;
  attachmentKind: AttachmentRef['kind'];
  content: Uint8Array;
}

/**
 * Snapshot selected files through Runtime Host. Hosted Turn attachments accept
 * only canonical Session Artifacts, so every path is read once under the byte
 * cap and handed to the Host-owned ingest boundary.
 */
export async function resolveAttachmentRefs(input: {
  files: AttachmentIngestFile[];
  snapshot: (input: AttachmentSnapshotInput) => Promise<AttachmentRef>;
  resizeImage?: (bytes: Uint8Array) => Promise<Uint8Array>;
  maxBytes?: number;
}): Promise<AttachmentRef[]> {
  const maxBytes = input.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const refs: AttachmentRef[] = [];
  for (const file of input.files) {
    const name = attachmentFileName(file);
    const mimeType = file.mimeType && file.mimeType.length > 0 ? file.mimeType : guessMimeFromName(name);
    const kind = attachmentKindFromMimeType(mimeType, name);

    let bytes: Uint8Array = isPathAttachment(file) ? await readFileCapped(file.path, maxBytes) : file.content;
    if (kind === 'image' && input.resizeImage) {
      bytes = await input.resizeImage(bytes);
    }
    const artifactKind: ArtifactKind =
      kind === 'image' ? 'image' : kind === 'pdf' ? 'pdf' : 'file';
    refs.push(
      await input.snapshot({
        name,
        mimeType,
        artifactKind,
        attachmentKind: kind,
        content: bytes,
      }),
    );
  }
  return refs;
}

function isPathAttachment(file: AttachmentIngestFile): file is Extract<AttachmentIngestFile, { path: string }> {
  return 'path' in file;
}

/** Read at most maxBytes+1 bytes; reject if the file is larger. Guards against a
 * TOCTOU where the file grows between stat (size pre-check) and read, so main
 * never loads an oversized file into memory. */
export async function readFileCapped(path: string, maxBytes: number): Promise<Uint8Array> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await fh.read(buf, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new Error('单个附件超出大小限制。');
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function attachmentFileName(file: AttachmentIngestFile): string {
  if (isPathAttachment(file)) return basename(file.path);
  const normalized = file.name.replace(/\\/g, '/');
  const name = basename(normalized).trim();
  return name || 'attachment';
}

/** A renderer-supplied ingest item: either a main-issued approval token (for
 * user-picked files, whose path never leaves main) or inline base64 bytes (for
 * dragged/pasted blobs, which have no trustworthy path). */
/**
 * Validate + resolve renderer ingest items into {@link AttachmentIngestFile}s
 * BEFORE any file is read or artifact created. Count, per-file byte cap, and
 * approval-token checks all run here so a too-large / unapproved / forged
 * request is rejected with zero I/O. Path sizes come from main-side `stat`,
 * never from the renderer. Each approval token is consumed exactly once.
 */
export async function resolveIngestItems(input: {
  senderId: number;
  items: unknown;
  approvals: AttachmentApprovalRegistry;
  stat: (path: string) => Promise<{ size: number }>;
  maxAttachments?: number;
  maxBytes?: number;
}): Promise<AttachmentIngestFile[]> {
  const maxAttachments = input.maxAttachments ?? MAX_ATTACHMENT_COUNT;
  const maxBytes = input.maxBytes ?? MAX_ATTACHMENT_BYTES;
  if (!Array.isArray(input.items)) throw new Error('附件信息无效，请重新选择文件后再发送。');
  if (input.items.length > maxAttachments) throw new Error('一次最多添加 8 个附件。');
  // Phase 1: validate every item with no side effects. Approval tokens are
  // peeked (not consumed) so a later invalid item does not burn earlier ones.
  const planned: AttachmentIngestFile[] = [];
  const approvalIds: string[] = [];
  const seenApprovalIds = new Set<string>();
  for (const item of input.items) {
    if (!item || typeof item !== 'object') throw new Error('附件信息无效，请重新选择文件后再发送。');
    const record = item as Record<string, unknown>;
    if (typeof record.approvalId === 'string' && typeof record.name === 'string') {
      if (seenApprovalIds.has(record.approvalId)) throw new Error('附件来源重复，请勿重复添加同一文件。');
      seenApprovalIds.add(record.approvalId);
      const approved = input.approvals.peekApproval(input.senderId, record.approvalId);
      if (!approved) throw new Error('附件来源已过期或无效，请重新选择文件后再发送。');
      const statResult = await input.stat(approved.path);
      if (statResult.size > maxBytes) throw new Error('单个附件超出大小限制。');
      const mimeType = pickMimeType(record.mimeType, approved.mimeType);
      planned.push({ path: approved.path, ...(mimeType ? { mimeType } : {}), size: statResult.size });
      approvalIds.push(record.approvalId);
      continue;
    }
    if (typeof record.name === 'string' && typeof record.base64 === 'string') {
      // Reject by base64 string length BEFORE Buffer.from: a forged huge
      // string must not be decoded into main memory. base64 encodes 3 bytes
      // per 4 chars, so ceil(maxBytes*4/3)+padding is a safe upper bound.
      const maxBase64Len = Math.ceil((maxBytes * 4) / 3) + 4;
      if (record.base64.length > maxBase64Len) throw new Error('单个附件超出大小限制。');
      const content = Buffer.from(record.base64, 'base64');
      if (content.byteLength > maxBytes) throw new Error('单个附件超出大小限制。');
      const mimeType = typeof record.mimeType === 'string' && record.mimeType.length > 0 ? record.mimeType : undefined;
      planned.push({ name: record.name, ...(mimeType ? { mimeType } : {}), size: content.byteLength, content });
      continue;
    }
    throw new Error('附件信息无效，请重新选择文件后再发送。');
  }
  // Phase 2: consume all approval tokens now that every item validated. Peek
  // passed, so each consume succeeds unless a concurrent request raced on the
  // same token; in that rare case we surface it as an expired-token error.
  for (const id of approvalIds) {
    if (!input.approvals.consumeApproval(input.senderId, id)) {
      throw new Error('附件来源已过期或无效，请重新选择文件后再发送。');
    }
  }
  return planned;
}

function pickMimeType(renderer: unknown, approved: string | undefined): string | undefined {
  if (typeof renderer === 'string' && renderer.length > 0) return renderer;
  return approved;
}
