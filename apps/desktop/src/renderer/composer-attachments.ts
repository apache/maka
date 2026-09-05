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

export function toComposerIngestItems(
  pending: readonly PendingAttachment[],
): ComposerIngestInput[] {
  return pending.flatMap((item) => {
    if (item.source.type === 'retained') return [];
    return [
      item.source.type === 'approval'
        ? {
            approvalId: item.source.approvalId,
            name: item.source.name,
            ...(item.mimeType ? { mimeType: item.mimeType } : {}),
          }
        : { file: item.source.file },
    ];
  });
}

export function retainedAttachmentRefs(
  pending: readonly PendingAttachment[],
): AttachmentRef[] {
  return pending.flatMap((item) =>
    item.source.type === 'retained'
      ? [structuredClone(item.source.attachment)]
      : [],
  );
}
