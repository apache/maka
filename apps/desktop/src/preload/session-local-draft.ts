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

import type { DesktopLocalMessageDraft } from '../shared/session-local-contract.js';

/** Defense in depth at the preload boundary: never forward a byte-bearing recovery draft. */
export function projectLocalMessageDraft(draft: DesktopLocalMessageDraft): DesktopLocalMessageDraft {
  const stagedAttachments = draft.stagedAttachments.map((item) => {
    if (!item || Object.keys(item).some((key) => !['approvalId', 'name', 'mimeType', 'size'].includes(key)) ||
        typeof item.approvalId !== 'string' || !item.approvalId.startsWith('local-recovery:') ||
        typeof item.name !== 'string' ||
        (item.mimeType !== undefined && typeof item.mimeType !== 'string') ||
        !Number.isSafeInteger(item.size) || item.size < 0) {
      throw new Error('Invalid local attachment recovery approval');
    }
    return { approvalId: item.approvalId, name: item.name, size: item.size,
      ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}) };
  });
  return {
    messageId: draft.messageId, text: draft.text, attachments: draft.attachments,
    stagedAttachments, directoryReferences: draft.directoryReferences,
    quotes: draft.quotes, inlineReferences: draft.inlineReferences,
  };
}
