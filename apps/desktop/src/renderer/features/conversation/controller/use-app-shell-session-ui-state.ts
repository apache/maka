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

import { useRef, useState } from 'react';
import type { StoredMessage } from '@maka/core/session';
import { valuesEqual, type TransientUserMessageProjection } from '@maka/ui';
import type { DesktopSessionSummary } from '../../../../shared/desktop-session-projection.js';
import { currentTranscriptRange } from './transcript-reading-position.js';
import { createAppShellSessionUiStateController, type AppShellSessionUiStateController } from '../model/session-ui-state.js';
import {
  selectSessionById,
  type SessionCatalogController,
} from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { useExternalStoreSelector } from '../../../application/contracts/session-catalog/use-external-store-selector.js';

/**
 * Catalog bookkeeping that republishes at event rate but renders only in the
 * rail — ordering, unread and flag markers, preview text, admission revision.
 * Nothing under the shell's whole-row read renders them, so a patch that moves
 * only these fields must not re-render the whole chat surface. Every other
 * field still compares, and a row field added later republishes until someone
 * proves it belongs here — the failure direction is a re-render, not a stale
 * value the UI swears is current.
 */
const NON_RENDERED_ROW_KEYS = {
  activityAt: true,
  hasUnread: true,
  isFlagged: true,
  lastMessagePreview: true,
  localCreatedAt: true,
  revision: true,
  statusUpdatedAt: true,
  subagentRuntime: true,
} satisfies Partial<Record<keyof DesktopSessionSummary, true>>;

export function shellSessionRowEqual(
  a: DesktopSessionSummary | undefined,
  b: DesktopSessionSummary | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const keys = new Set([
    ...(Object.keys(a) as (keyof DesktopSessionSummary)[]),
    ...(Object.keys(b) as (keyof DesktopSessionSummary)[]),
  ]);
  for (const key of keys) {
    if (key in NON_RENDERED_ROW_KEYS) continue;
    if (!valuesEqual(a[key], b[key])) return false;
  }
  return true;
}

interface TranscriptSource {
  range(): { readonly sessionId: string; readonly hasOlder: boolean };
  snapshot(): { readonly messages: readonly StoredMessage[]; readonly ready: boolean };
}

export type TranscriptPublisher<Controller> = (
  sessionId: string,
  controller: Controller,
  isCurrent: () => boolean,
  onReady: () => void,
) => void;

/** The rendered messages and the earlier-history flag are a single publication. */
export function useAppShellSessionUiState<
  Controller extends { readonly store: TranscriptSource },
>(
  catalog: SessionCatalogController,
  requestedSessionId: string | undefined,
  activeIdRef: { current: string | undefined },
  commitTranscript: (sessionId: string, messages: StoredMessage[], controller: Controller) => boolean,
) {
  // The observable controller retains its own identity and subscriptions;
  // publication is the React view of the active transcript, not a store copy.
  const controllerRef = useRef<AppShellSessionUiStateController | null>(null);
  controllerRef.current ??= createAppShellSessionUiStateController();
  const controller = controllerRef.current;
  const transcriptRangeRef = useRef<Controller | undefined>(undefined);
  const messagesRef = useRef<StoredMessage[]>([]);
  const transientMessagesBySessionRef = useRef(
    new Map<string, Map<string, TransientUserMessageProjection>>(),
  );
  const [transientMessages, setTransientMessagesState] = useState<TransientUserMessageProjection[]>([]);
  const [messageLoadPending, setMessageLoadPending] = useState(false);
  const [view, setView] = useState<{
    sessionId: string | undefined;
    messages: StoredMessage[];
    range: ReturnType<TranscriptSource['range']> | undefined;
  }>({ sessionId: undefined, messages: [], range: undefined });

  // These actions capture only lifetime-stable refs, setters and the workspace
  // callback that dispatches through its actions ref. Keep their identities as
  // stable as the other workspace actions consumers receive.
  const [actions] = useState(() => ({
    isMessagePublished: (message: StoredMessage) => messagesRef.current.includes(message),
    setMessagesState(messages: StoredMessage[]) {
      setView({
        sessionId: activeIdRef.current,
        messages,
        range: messages.length
          ? currentTranscriptRange(transcriptRangeRef.current, activeIdRef.current)
          : undefined,
      });
    },
    publishTranscript(
      sessionId: string,
      rangeController: Controller,
      isCurrent: () => boolean,
      onReady: () => void,
    ) {
      if (!isCurrent()) return;
      const snapshot = rangeController.store.snapshot();
      if (!snapshot.ready || !commitTranscript(sessionId, [...snapshot.messages], rangeController)) return;
      onReady();
    },
  }));

  const activeCatalogSession = useExternalStoreSelector(
    catalog,
    selectSessionById,
    view.sessionId,
    shellSessionRowEqual,
  );
  const requestedCatalogSession = useExternalStoreSelector(
    catalog,
    selectSessionById,
    requestedSessionId,
    shellSessionRowEqual,
  );
  // Locally staged tasks cannot admit Host reads until creation completes.
  const activeHostSession = activeCatalogSession?.localState !== 'pending' ? activeCatalogSession : undefined;
  const requestedHostSession = requestedCatalogSession?.localState !== 'pending' ? requestedCatalogSession : undefined;
  const sharedSessionActive = activeCatalogSession?.shared === true;

  return {
    controller,
    publication: {
      transcriptRangeRef,
      messagesRef,
      messages: view.messages,
      publishedTranscriptRange: view.range,
      ...actions,
    },
    display: {
      activeId: view.sessionId,
      transientMessages,
      transientMessagesBySessionRef,
      setTransientMessagesState,
      messageLoadPending,
      setMessageLoadPending,
      activeCatalogSession,
      activeHostSession,
      requestedCatalogSession,
      requestedHostSession,
      sharedSessionActive,
      ownerActiveId: sharedSessionActive ? undefined : activeHostSession?.id,
      switchingSession: view.sessionId !== requestedSessionId,
    },
  };
}
