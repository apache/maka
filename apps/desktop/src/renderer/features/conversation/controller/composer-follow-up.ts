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

import type { DirectoryReference, QuoteRef, FollowUpMode } from '@maka/core/events';
import type { ComposerSendMetadata } from '@maka/ui';
import type { PendingAttachment } from '@maka/ui/composer-attachments';

/** A refusal leaves the complete draft in place; an admitted message consumes it once. */
export function composerFollowUp(deps: {
  pending: readonly PendingAttachment[] | undefined;
  quotes: readonly QuoteRef[];
  directoryOptions: { directoryReferences?: readonly DirectoryReference[] };
  enqueueMessage(sessionId: string, text: string, placement: 'current_turn' | 'next_turn',
    pending: readonly PendingAttachment[] | undefined, options: {
      directoryReferences?: readonly DirectoryReference[];
      quotes?: readonly QuoteRef[];
      workspaceFileReferences?: ComposerSendMetadata['workspaceFileReferences'];
    }): Promise<boolean>;
  clearSubmittedContext(pending: readonly PendingAttachment[] | undefined): void;
  clearQuotes(): void;
  onError(sessionId: string, error: unknown): void;
}) {
  return async (sessionId: string, text: string, mode: FollowUpMode, metadata?: ComposerSendMetadata): Promise<boolean> => {
    const { pending } = deps;
    const quotes = deps.quotes.length ? deps.quotes : undefined;
    try {
      const sent = await deps.enqueueMessage(sessionId, text,
        mode === 'steer' ? 'current_turn' : 'next_turn', pending, {
          ...deps.directoryOptions,
          ...(quotes ? { quotes: [...quotes] } : {}),
          ...(metadata?.workspaceFileReferences?.length
            ? { workspaceFileReferences: [...metadata.workspaceFileReferences] } : {}),
        });
      if (!sent) return false;
      deps.clearSubmittedContext(pending);
      if (quotes) deps.clearQuotes();
      return true;
    } catch (error) {
      deps.onError(sessionId, error);
      return false;
    }
  };
}
