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

import type {
  AttachmentRef,
  InlineReference,
  MessageContent,
  MessageQueueEntryProjection,
  QuoteRef,
} from '@maka/core/events';

type RefBox<T> = { current: T };

type ComposerDraftPort = {
  appendDraft?(draftKey: string, text: string): void;
  getDraft(draftKey: string): string;
  focus(): void;
};

export async function retractQueueEntryToDraft(deps: {
  activeIdRef: RefBox<string | undefined>;
  composerRef: RefBox<ComposerDraftPort | null>;
  restoreAttachments(draftKey: string, attachments: readonly AttachmentRef[]): void;
  restoreQuotes(draftKey: string, quotes: readonly QuoteRef[]): void;
  setRestoredWorkspaceReferences(draftKey: string, references: readonly InlineReference[]): void;
  requestFocus(callback: () => void): void;
}, sessionId: string, entry: MessageQueueEntryProjection): Promise<void> {
  // Queue content has one wire path: the Host-authored projection captured at
  // click time. The mutation only confirms removal; its response does not send
  // the same content again or make restoration depend on the active surface.
  await window.maka.sessions.retractQueueEntry(sessionId, entry.entryId);
  restoreContent(sessionId, entry.content);
  deps.requestFocus(() => {
    if (deps.activeIdRef.current === sessionId) deps.composerRef.current?.focus();
  });

  function restoreContent(draftKey: string, content: MessageContent): void {
    const displayText = content.displayText ?? content.text;
    const before = deps.composerRef.current?.getDraft(draftKey) ?? '';
    deps.composerRef.current?.appendDraft?.(draftKey, displayText);
    const after = deps.composerRef.current?.getDraft(draftKey) ?? displayText;
    const insertionStart = Math.max(0, after.lastIndexOf(displayText, before.length + 2));
    deps.setRestoredWorkspaceReferences(
      draftKey,
      (content.inlineReferences ?? []).flatMap((reference) =>
        reference.kind === 'workspace_file'
          ? [{ ...reference, start: insertionStart + reference.start }]
          : [],
      ),
    );
    deps.restoreAttachments(draftKey, content.attachments ?? []);
    deps.restoreQuotes(draftKey, content.quotes ?? []);
  }
}
