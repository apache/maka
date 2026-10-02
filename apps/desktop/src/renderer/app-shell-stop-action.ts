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
import {
  localizedShellErrorMessage,
  type ShellErrorToastApi,
} from './locales/shell-copy.js';
import { getDesktopConversationCopy } from './application/contracts/conversation-copy.js';
import type { SessionPendingClaim } from './features/conversation/index.js';

export function createAppShellStopAction(deps: {
  uiLocale: UiLocale;
  activeIdRef: { readonly current: string | undefined };
  stopPending: SessionPendingClaim;
  removeTransientMessage: (sessionId: string, messageId: string) => void;
  toastApi: ShellErrorToastApi;
}): (sessionId?: string, expectedTurnId?: string) => Promise<boolean | undefined> {
  const { uiLocale, activeIdRef, stopPending, removeTransientMessage, toastApi } = deps;
  return async (override?: string, expectedTurnId?: string) => {
    const sessionId = override ?? activeIdRef.current;
    if (!sessionId || !stopPending.claim(sessionId)) return;
    try {
      const result = await window.maka.sessions.stop(sessionId, {
        source: 'stop_button',
        ...(expectedTurnId ? { expectedTurnId } : {}),
      });
      if (result?.kind === 'interrupted') {
        for (const id of result.retractedMessageIds) removeTransientMessage(sessionId, id);
        return true;
      }
      // Enter pins expectedTurnId. Host returns undefined when that turn has
      // already settled or been replaced — treat it as a failed interrupt so
      // interruptBeforeRootSend does not admit a root send over a newer live
      // turn (#4083 review).
      if (expectedTurnId) return false;
      return true;
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
    } finally {
      stopPending.release(sessionId);
    }
  };
}
