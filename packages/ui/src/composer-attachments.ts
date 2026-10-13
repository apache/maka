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

import type { AttachmentRef } from '@maka/core/events';

export type PendingAttachment = {
  /** Unique per staged item; keys preview ownership and cleanup. */
  stagingKey: string;
  displayName: string;
  mimeType?: string;
  kind: AttachmentRef['kind'];
  size: number;
  /** Present only after the URL has decoded successfully. */
  previewUrl?: string;
  source:
    | { type: 'approval'; approvalId: string; name: string }
    | { type: 'file'; file: File }
    | { type: 'retained'; attachment: AttachmentRef };
};

export type ComposerIngestInput =
  | { approvalId: string; name: string; mimeType?: string }
  | { file: File };

/** Stable identity across preview-URL merges. */
export function pendingAttachmentSourceKey(
  attachment: PendingAttachment,
): unknown {
  if (attachment.source.type === 'approval') {
    return `approval:${attachment.source.approvalId}`;
  }
  if (attachment.source.type === 'file') return attachment.source.file;
  return `retained:${JSON.stringify(attachment.source.attachment)}`;
}

export interface SubmittedAttachments {
  /** New files the Host still has to ingest. */
  attachmentItems?: ComposerIngestInput[];
  /** Host attachments a restored draft already owns. */
  retainedAttachments?: AttachmentRef[];
}

/**
 * Every staged attachment, split into the two fields a send command carries.
 * An empty field is omitted.
 */
export function toSubmittedAttachments(
  pending: readonly PendingAttachment[],
): SubmittedAttachments {
  const attachmentItems: ComposerIngestInput[] = [];
  const retainedAttachments: AttachmentRef[] = [];
  for (const { source, mimeType } of pending) {
    if (source.type === 'retained') {
      retainedAttachments.push(structuredClone(source.attachment));
    } else if (source.type === 'approval') {
      attachmentItems.push({
        approvalId: source.approvalId,
        name: source.name,
        ...(mimeType ? { mimeType } : {}),
      });
    } else {
      attachmentItems.push({ file: source.file });
    }
  }
  return {
    ...(attachmentItems.length > 0 ? { attachmentItems } : {}),
    ...(retainedAttachments.length > 0 ? { retainedAttachments } : {}),
  };
}
