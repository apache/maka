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

import {
  attachmentIngestBlocked,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
} from '@maka/core/attachments';

type PreflightItem = {
  size: number;
  source:
    | { type: 'approval'; approvalId: string }
    | { type: 'file'; file: { size: number } }
    | { type: 'retained' };
};

/**
 * Reject count/size/duplicate-source violations before a new-chat session is
 * created, so an encode/resolve-time failure does not leave an empty session
 * behind. Rejects with the same stable `attachment_ingest:<code>` tokens the
 * main-side resolveIngestItems pre-validation rejects with, so the shell
 * presenter maps the reason through the locale catalogs instead of the
 * generic send fallback; main remains the authoritative cap.
 *
 * File blobs are sized by the browser File object; approval-token attachments
 * are sized by the pending size stamped at pick time (main re-stats).
 */
export function preflightAttachmentItems(items: readonly PreflightItem[]): void {
  if (items.length > MAX_ATTACHMENT_COUNT) throw attachmentIngestBlocked('count_limit');
  const seen = new Set<string>();
  for (const item of items) {
    const bytes = item.source.type === 'file' ? item.source.file.size : item.size;
    if (bytes > MAX_ATTACHMENT_BYTES) throw attachmentIngestBlocked('item_too_large');
    if (item.source.type === 'approval') {
      if (seen.has(item.source.approvalId)) throw attachmentIngestBlocked('duplicate_source');
      seen.add(item.source.approvalId);
    }
  }
}
