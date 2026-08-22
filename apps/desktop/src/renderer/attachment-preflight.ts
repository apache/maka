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
import { type UiLocale } from '@maka/core/ui-locale';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

type PreflightItem = {
  size: number;
  source: { type: 'approval'; approvalId: string } | { type: 'file'; file: { size: number } };
};

/**
 * Reject count/size/duplicate-token violations before a new-chat session is
 * created, so an encode/resolve-time failure does not leave an empty session
 * behind. This is a renderer-side UX guard mirroring main-side
 * resolveIngestItems pre-validation; main remains the authoritative cap.
 *
 * File blobs are sized by the browser File object; approval-token attachments
 * are sized by the pending size stamped at pick time (main re-stats).
 */
export function preflightAttachmentItems(items: readonly PreflightItem[], locale: UiLocale = 'zh'): void {
  const copy = getDesktopConversationCopy(locale).attachments;
  if (items.length > MAX_ATTACHMENT_COUNT) throw new Error(copy.tooMany);
  const seen = new Set<string>();
  for (const item of items) {
    const bytes = item.source.type === 'file' ? item.source.file.size : item.size;
    if (bytes > MAX_ATTACHMENT_BYTES) throw new Error(copy.tooLarge);
    if (item.source.type === 'approval') {
      if (seen.has(item.source.approvalId)) throw new Error(copy.duplicate);
      seen.add(item.source.approvalId);
    }
  }
}
