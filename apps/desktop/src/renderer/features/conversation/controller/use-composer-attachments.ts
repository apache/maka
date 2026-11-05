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

import { useDraftMutationGuard, useUiLocale, type RevisionStagedContext } from '@maka/ui';
import { useComposerAttachments as useSharedComposerAttachments } from '@maka/ui/use-composer-attachments';
import { getDesktopConversationCopy } from '../../../application/contracts/conversation-copy.js';
import { localizedShellErrorMessage } from '../../../locales/shell-copy.js';
import { useConversationServices } from '../services.js';
import { useComposerQuotes } from './use-composer-quotes.js';
import type { RestoredDraftContent } from '../../../application/contracts/transient-message-projection.js';

/** Desktop staging surface for everything the composer carries into a send:
 * attachments, directory picks, and staged transcript quotes. Called only by
 * ComposerStagingProvider; all three share the same draft key. */
export function useComposerAttachments(options: Omit<Parameters<typeof useSharedComposerAttachments>[0], 'copy' | 'formatError' | 'releaseRecoveryAttachments' | 'onDraftChange'>) {
  const locale = useUiLocale();
  const services = useConversationServices();
  const mutations = useDraftMutationGuard();
  const attachments = useSharedComposerAttachments({
    ...options,
    onDraftChange: (key) => key === undefined ? mutations.clear() : mutations.changed(key),
    releaseRecoveryAttachments: services.releaseRecoveryAttachments,
    copy: getDesktopConversationCopy(locale).actions,
    formatError: (error, fallback) => localizedShellErrorMessage(error, fallback, locale),
  });
  const quotes = useComposerQuotes({ draftKey: options.draftKey, onDraftChange: mutations.changed });
  const restoreQueuedDraftContext = (ownerKey: string, draft: Omit<RestoredDraftContent, 'text'>) => {
    attachments.restoreMessageContext(ownerKey, undefined, {
      attachments: draft.attachments ?? [], stagedAttachments: draft.stagedAttachments ?? [],
      directoryReferences: draft.directoryReferences ?? [],
    });
    if (draft.quotes?.length) quotes.restoreQuotes(ownerKey, draft.quotes);
  };
  // The revision lifecycle reads its staged plates through this getter (see
  // RevisionStagedContext). It is assembled here, beside the hooks that own
  // the buckets, so the frozen shell only forwards one member.
  const stagedContext = (): RevisionStagedContext => ({
    quotes: quotes.pendingQuotes,
    attachments: attachments.submittableAttachments ?? [],
    restoreQuotes: quotes.restoreQuotes,
    clearQuotes: quotes.clearQuotes,
    restoreAttachments: attachments.restorePendingAttachments,
    clearAttachments: attachments.clearAttachmentsAt,
  });
  return { ...attachments, ...quotes, restoreQueuedDraftContext, stagedContext,
    captureContext: mutations.capture, markDraftChanged: mutations.changed };
}
