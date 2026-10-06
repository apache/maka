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

import { useEffectEvent, useLayoutEffect } from 'react';
import type { UiLocale } from '@maka/core/ui-locale';
import type { SessionEvent } from '@maka/core/events';
import type { SessionEventStreamSnapshot } from '@maka/core/session-event-health';
import { getDesktopConversationCopy } from '../../../application/contracts/conversation-copy.js';
import { transcriptErrorMessage } from '../../../application/contracts/transcript-copy.js';
import { createSessionEventStreamSubscription, recordSessionEventStreamEvent } from '../../../application/contracts/session-catalog/session-event-health.js';
import type { ConversationTranscriptController, ConversationObservationServices } from '../transcript-ports.js';
type RefBox<T> = { current: T };
type SessionEventHealthUpdater = (updater: (current: Record<string, SessionEventStreamSnapshot>) => Record<string, SessionEventStreamSnapshot>) => void;
type TranscriptPublisher<Controller> = (sessionId: string, controller: Controller, isCurrent: () => boolean, onReady: () => void) => void;
type ToastApi = { error(title: string, description?: string, diagnosticDetails?: string, target?: { sessionId: string }): void };

export function useConversationObservation(options: {
  services: ConversationObservationServices;
  uiLocale: UiLocale;
  activeId: string | undefined;
  observationAuthorityRevision: number;
  activeIdRef: Readonly<RefBox<string | undefined>>;
  handleEvent: (sessionId: string, event: SessionEvent) => void;
  setExecution: import('../model/session-ui-state.js').AppShellSessionUiStateController['setExecution'];
  endObservation(sessionId: string): void;
  beginObservationSeed: (sessionId: string) => () => void;
  setMessageLoadErrorBySession: (updater: (current: Record<string, string>) => Record<string, string>) => void;
  clearMessageLoadError(sessionId: string): void;
  setMessageLoadPending: (pending: boolean) => void;
  commitTranscript: import('../model/session-workspace-actions.js').SessionWorkspaceActions['commitTranscript'];
  publishTranscript: TranscriptPublisher<
    ConversationTranscriptController
  >;
  transcriptRangeRef: RefBox<ConversationTranscriptController | undefined>;
  observationRef: import('../model/conversation-workspace.js').ConversationWorkspace['observationRef'];
  setSessionEventHealthBySession: SessionEventHealthUpdater;
  toastApi: Pick<ToastApi, 'error'>;
}) {
  const activeId = options.activeId;
  const clearMessageLoadError = useEffectEvent(options.clearMessageLoadError);
  // Publication rechecks both the requested Session and the effect instance
  // after any reader input wait before handing over the displayed transcript.
  const applyTranscript = useEffectEvent((
    sessionId: string,
    controller: ConversationTranscriptController,
    effectIsCurrent: () => boolean,
  ) => {
    options.publishTranscript(sessionId, controller, effectIsCurrent, () => {
      clearMessageLoadError(sessionId);
      options.setMessageLoadPending(false);
    });
  });
  const applyReadError = useEffectEvent((sessionId: string, error: unknown) => {
    if (options.activeId === sessionId) {
      if (options.activeIdRef.current !== sessionId) options.commitTranscript(sessionId, []);
      const message = transcriptErrorMessage(error, options.uiLocale, 'read');
      options.setMessageLoadErrorBySession((current) => ({
        ...current,
        [sessionId]: message,
      }));
      options.setMessageLoadPending(false);
      options.toastApi.error(
        getDesktopConversationCopy(options.uiLocale).actions.messageReadFailedTitle,
        message,
        undefined,
        { sessionId },
      );
    }
  });
  const handleSessionEvent = useEffectEvent((sessionId: string, event: SessionEvent) => {
    options.setSessionEventHealthBySession((current) => {
      const previous = current[sessionId];
      if (!previous) return current;
      return {
        ...current,
        [sessionId]: recordSessionEventStreamEvent(previous, Date.now()),
      };
    });
    options.handleEvent(sessionId, event);
  });
  const beginObservationSeed = useEffectEvent(options.beginObservationSeed);
  const markSessionEventStreamClosed = useEffectEvent((sessionId: string) => {
    options.setSessionEventHealthBySession((current) => {
      const previous = current[sessionId];
      if (!previous) return current;
      return {
        ...current,
        [sessionId]: {
          ...previous,
          status: 'closed',
          checkedAt: Date.now(),
          staleSince: undefined,
        },
      };
    });
  });

  useLayoutEffect(() => {
    if (!activeId) return;
    let disposed = false;
    let observationAttempt = 0;
    let observationFailures = 0;
    let observationRetryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let unsubscribeSessionEvents = () => {};
    clearMessageLoadError(activeId);
    options.setSessionEventHealthBySession((current) => ({
      ...current,
      [activeId]: createSessionEventStreamSubscription({ sessionId: activeId, now: Date.now() }),
    }));
    const controller = options.services.openTranscript(activeId, (error) => {
      if (!disposed) applyReadError(activeId, error);
    });
    const observation = { sessionId: activeId, controller };
    options.observationRef.current = observation;
    const transcript = controller.store;
    const unsubscribeTranscript = transcript.subscribe(() =>
      applyTranscript(activeId, controller, () => !disposed));
    // The range becomes readable only after its first accepted batch.
    // Opening a controller is not a publication/readiness signal.
    const subscribeSessionEvents = () => {
      const attempt = ++observationAttempt;
      let completeObservationSeed = beginObservationSeed(activeId);
      let unsubscribeRequested = false;
      let unsubscribeCurrent = () => {
        unsubscribeRequested = true;
      };
      const unsubscribe = options.services.subscribeEvents(
        activeId,
        (event) => {
          if (attempt !== observationAttempt) return;
          handleSessionEvent(activeId, event);
        },
        (phase) => {
          if (attempt !== observationAttempt) return;
          controller.observationChanged(phase);
          if (phase === 'pending') completeObservationSeed = beginObservationSeed(activeId);
          else {
            observationFailures = 0;
            completeObservationSeed();
          }
        },
        () => {
          if (attempt !== observationAttempt) return;
          controller.observationChanged('pending');
          options.setExecution(activeId, undefined);
          unsubscribeCurrent();
          observationFailures += 1;
          const retryDelayMs = Math.min(100 * (2 ** (observationFailures - 1)), 2_000);
          observationRetryTimer = globalThis.setTimeout(() => {
            observationRetryTimer = undefined;
            if (!disposed && attempt === observationAttempt) subscribeSessionEvents();
          }, retryDelayMs);
        },
        (projection) => {
          if (attempt === observationAttempt) options.setExecution(activeId, projection);
        },
      );
      unsubscribeCurrent = unsubscribe;
      unsubscribeSessionEvents = unsubscribe;
      if (unsubscribeRequested) unsubscribe();
    };
    subscribeSessionEvents();
    return () => {
      disposed = true;
      if (options.observationRef.current === observation) options.observationRef.current = undefined;
      options.endObservation(activeId);
      observationAttempt += 1;
      if (observationRetryTimer !== undefined) {
        globalThis.clearTimeout(observationRetryTimer);
      }
      if (options.transcriptRangeRef.current?.store === transcript) {
        options.transcriptRangeRef.current = undefined;
      }
      void controller.close();
      unsubscribeTranscript();
      unsubscribeSessionEvents();
      options.setExecution(activeId, undefined);
      markSessionEventStreamClosed(activeId);
    };
  }, [activeId, options.observationAuthorityRevision]);
}
