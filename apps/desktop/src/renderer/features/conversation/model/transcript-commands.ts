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

import type { useToast } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ConversationWorkspace } from './conversation-workspace.js';
import { transcriptErrorMessage, transcriptRefreshTitle } from '../../../application/contracts/transcript-copy.js';
export function createTranscriptCommands(workspace: ConversationWorkspace, feedback: { current: { locale: UiLocale; toast: Pick<ReturnType<typeof useToast>, 'error'> } }) {
  const { ui, activeIdRef, transcriptRangeRef, observationRef } = workspace;
  const reportError = (sessionId: string, error: unknown) => {
    const { locale, toast } = feedback.current;
    const message = transcriptErrorMessage(error, locale, 'refresh');
    ui.setMessageLoadErrorBySession((current) => ({ ...current, [sessionId]: message }));
    toast.error(transcriptRefreshTitle(locale), message, undefined, { sessionId });
  };
  return {
    async refreshMessages(sessionId: string, options: { requiredAssistantMessageId?: string } = {}): Promise<boolean> {
      const controller = transcriptRangeRef.current;
      const isCurrent = () => activeIdRef.current === sessionId && transcriptRangeRef.current === controller;
      if (!controller || !isCurrent()) return false;
      try {
        await controller.ready();
        if (!isCurrent()) return false;
        const required = options.requiredAssistantMessageId;
        if (required !== undefined && !controller.store.hasDurableMessage(required)
          && !(await controller.waitForDurableMessage(required, 480))) return false;
        if (!isCurrent()) return false;
        const snapshot = controller.store.snapshot();
        if (snapshot.sessionId !== sessionId) return false;
        ui.clearMessageLoadError(sessionId);
        return required === undefined || snapshot.messages.some((message) => message.id === required && workspace.isMessagePublished(message));
      } catch (error) {
        if (isCurrent()) reportError(sessionId, error);
        return false;
      }
    },
    async retryMessages(sessionId: string) {
      const observation = observationRef.current;
      if (!observation || observation.sessionId !== sessionId || !workspace.commands.isSessionSelected(sessionId)
        || !ui.messageRetryPending.claim(sessionId)) return;
      // The controller reports a failed reload through the observation's onError, as for its own
      // reloads, except over the cached transcript, where only this Retry can answer the click.
      try { await observation.controller.reload(); }
      catch (error) {
        if (observation.controller.holdsCachedTranscript() && observationRef.current === observation
          && workspace.commands.isSessionSelected(sessionId)) reportError(sessionId, error);
      }
      finally { ui.messageRetryPending.release(sessionId); }
    },
  };
}
