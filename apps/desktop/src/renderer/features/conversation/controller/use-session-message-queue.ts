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

import { useCallback, useMemo, useRef, type RefObject } from 'react';
import {
  useToast,
  useUiLocale,
  type ComposerHandle,
  type TransientUserMessageProjection,
} from '@maka/ui';
import { withQueuedSteeringTransients } from '../../../application/contracts/transient-message-projection.js';
import { getDesktopConversationCopy } from '../../../locales/conversation-copy.js';
import { localizedShellErrorMessage } from '../../../locales/shell-copy.js';
import { useConversationServices } from '../services.js';
import type { MessageQueueUiState } from '../model/session-ui-state.js';

/**
 * The active Session's message-queue surface: the plate's entry actions, the
 * transcript's transient layer (locally-sent messages plus one bubble per
 * queued steering entry derived from the Host queue snapshot), and the "hand
 * the text back to the composer" gesture both share. `sessionId` is the
 * Session whose queue is on screen; plate actions instead resolve the Session
 * at call time so a click always targets the queue the user is looking at.
 */
export function useSessionMessageQueue(options: {
  sessionId: string | undefined;
  queue: MessageQueueUiState | undefined;
  transientMessages: readonly TransientUserMessageProjection[];
  activeSessionId: RefObject<string | undefined>;
}): {
  composer: RefObject<ComposerHandle | null>;
  transientMessages: TransientUserMessageProjection[];
  restoreDraft: (sessionId: string, text: string) => void;
  promoteQueuedEntry: (entryId: string) => Promise<void>;
  updateQueuedEntry: (entryId: string, expectedQueueRevision: number, text: string) => Promise<void>;
  deleteQueuedEntry: (entryId: string) => Promise<void>;
  reorderQueuedEntries: (entryIds: readonly string[]) => Promise<void>;
} {
  const { sessionId, queue, transientMessages, activeSessionId } = options;
  const services = useConversationServices();
  const composer = useRef<ComposerHandle>(null);
  const locale = useUiLocale();
  const toast = useToast();
  const reportError = useCallback(
    (targetSessionId: string, error: unknown) => {
      const copy = getDesktopConversationCopy(locale).actions;
      toast.error(
        copy.operationFailedTitle,
        localizedShellErrorMessage(error, copy.operationFailedFallback, locale),
        undefined,
        { sessionId: targetSessionId },
      );
    },
    [locale, toast],
  );
  const restoreDraft = useCallback(
    (targetSessionId: string, text: string) => {
      const handle = composer.current;
      if (!handle || activeSessionId.current !== targetSessionId) return;
      if (handle.getText().trim()) handle.appendText(text);
      else handle.setText(text);
      handle.focus();
    },
    [activeSessionId],
  );
  // Surfaces the failure, then rethrows so the pending plate can settle its
  // in-flight action state without guessing with a timer.
  const runAction = useCallback(
    async (action: (targetSessionId: string) => Promise<void>) => {
      const targetSessionId = activeSessionId.current;
      if (!targetSessionId) return;
      try {
        await action(targetSessionId);
      } catch (error) {
        if (activeSessionId.current === targetSessionId) reportError(targetSessionId, error);
        throw error;
      }
    },
    [activeSessionId, reportError],
  );
  const merged = useMemo(
    () => withQueuedSteeringTransients(transientMessages, queue, {
      locale,
      retract: async (entry, draftText) => {
        if (!sessionId) return false;
        try {
          await services.sessions.retractQueueEntry(sessionId, entry.entryId);
        } catch (error) {
          if (activeSessionId.current === sessionId) reportError(sessionId, error);
          return false;
        }
        if (draftText !== undefined) restoreDraft(sessionId, draftText);
        return true;
      },
    }),
    [sessionId, transientMessages, queue, locale, activeSessionId, services, reportError, restoreDraft],
  );
  return {
    composer,
    transientMessages: merged,
    restoreDraft,
    promoteQueuedEntry: (entryId) => runAction((targetSessionId) => services.sessions.promoteQueueEntry(targetSessionId, entryId)),
    updateQueuedEntry: (entryId, expectedQueueRevision, text) =>
      runAction((targetSessionId) => services.sessions.updateQueueEntry(targetSessionId, entryId, expectedQueueRevision, text)),
    deleteQueuedEntry: (entryId) => runAction((targetSessionId) => services.sessions.retractQueueEntry(targetSessionId, entryId)),
    reorderQueuedEntries: (entryIds) => runAction((targetSessionId) => services.sessions.reorderQueueEntries(targetSessionId, entryIds)),
  };
}
