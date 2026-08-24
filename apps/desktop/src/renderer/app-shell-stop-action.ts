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
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

type RefBox<T> = { current: T };
type BooleanRecordUpdater = (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void;

type ToastApi = {
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string },
  ): void;
};

export function createAppShellStopAction(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  addPendingSessionAction: (
    sessionId: string,
    pendingRef: RefBox<Set<string>>,
    setPendingBySession: BooleanRecordUpdater,
  ) => boolean;
  clearPendingSessionAction: (
    sessionId: string,
    pendingRef: RefBox<Set<string>>,
    setPendingBySession: BooleanRecordUpdater,
  ) => void;
  setStopPendingBySession: BooleanRecordUpdater;
  stopPendingRef: RefBox<Set<string>>;
  toastApi: ToastApi;
}): () => Promise<void> {
  const {
    uiLocale,
    activeIdRef,
    addPendingSessionAction,
    clearPendingSessionAction,
    setStopPendingBySession,
    stopPendingRef,
    toastApi,
  } = deps;

  async function stop() {
    const sessionId = activeIdRef.current;
    if (!sessionId || !addPendingSessionAction(sessionId, stopPendingRef, setStopPendingBySession)) return;
    try {
      await window.maka.sessions.stop(sessionId, { source: 'stop_button' });
    } catch (error) {
      // The Composer wires this through both the Stop button onClick
      // and the Escape key. Both invoke `onStop` without awaiting, so
      // a rejected IPC would otherwise surface as an
      // UnhandledPromiseRejection and the user would see nothing.
      // Surface it as a toast so the user knows the model wasn't
      // actually interrupted and can retry.
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
      clearPendingSessionAction(sessionId, stopPendingRef, setStopPendingBySession);
    }
  }

  return stop;
}
