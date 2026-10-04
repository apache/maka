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

import type { UiLocale } from '@maka/core/ui-locale';
import { localizedShellErrorMessage } from '../../../locales/shell-copy.js';
import { getDesktopConversationCopy } from '../../../application/contracts/conversation-copy.js';
import type { SessionPendingClaim } from '../model/session-ui-state.js';
import type { ComposerSubmissionServices } from '../submission-services.js';

type ToastApi = {
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string },
  ): void;
};

/**
 * What one stop request did. `failed` has already been toasted; `busy` means a
 * stop for the Session is in flight that this action cannot await.
 */
export type StopOutcome = 'interrupted' | 'not_running' | 'failed' | 'busy';

export function createStopAction(deps: {
  services: Pick<ComposerSubmissionServices, 'stop'>;
  uiLocale: UiLocale;
  activeIdRef: { readonly current: string | undefined };
  stopPending: SessionPendingClaim;
  removeTransientMessage: (sessionId: string, messageId: string) => void;
  toastApi: ToastApi;
  /** Stops in flight by Session. Must outlive one render so a second caller can await the first. */
  inFlight?: Map<string, Promise<StopOutcome>>;
}): (sessionId?: string, expectedTurnId?: string) => Promise<StopOutcome> {
  const {
    services,
    uiLocale,
    activeIdRef,
    stopPending,
    removeTransientMessage,
    toastApi,
    inFlight = new Map<string, Promise<StopOutcome>>(),
  } = deps;

  async function stopSession(sessionId: string, expectedTurnId: string | undefined): Promise<StopOutcome> {
    try {
      const result = await services.stop(sessionId, {
        source: 'stop_button',
        ...(expectedTurnId ? { expectedTurnId } : {}),
      });
      if (result?.kind !== 'interrupted') return 'not_running';
      for (const id of result.retractedMessageIds) removeTransientMessage(sessionId, id);
      return 'interrupted';
    } catch (error) {
      // Composer Stop / Escape call onStop without awaiting; toast so a failed
      // interrupt is visible instead of an UnhandledPromiseRejection.
      if (activeIdRef.current === sessionId) {
        const copy = getDesktopConversationCopy(uiLocale).actions;
        toastApi.error(
          copy.stopFailedTitle,
          localizedShellErrorMessage(error, copy.stopFailedFallback, uiLocale),
          undefined,
          { sessionId },
        );
      }
      return 'failed';
    } finally {
      stopPending.release(sessionId);
    }
  }

  return async (sessionId = activeIdRef.current, expectedTurnId?: string) => {
    if (!sessionId) return 'not_running';
    const pending = inFlight.get(sessionId);
    if (pending) return pending;
    if (!stopPending.claim(sessionId)) return 'busy';
    const stopping = stopSession(sessionId, expectedTurnId);
    inFlight.set(sessionId, stopping);
    void stopping.finally(() => {
      if (inFlight.get(sessionId) === stopping) inFlight.delete(sessionId);
    });
    return stopping;
  };
}
