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

import { useEffect, useImperativeHandle, useRef, useState, type Dispatch, type Ref, type SetStateAction } from 'react';
import type { StoredMessage } from '@maka/core/session';
import type { AppShellSessionUiStateController } from '../model/session-ui-state.js';
import {
  captureTranscriptReadingAnchor,
  createTranscriptRestoreLifecycle,
  currentTranscriptRange,
  loadTranscriptHistory,
  newestDurablePromptSequence,
  prepareTranscriptForSend,
  refreshTranscriptTurnLandmarks,
  restoreSessionTranscriptRange,
  type TranscriptHistoryGate,
  type TranscriptHistoryGates,
  type TranscriptHistoryPending,
  type TranscriptHistoryRequest,
} from './transcript-reading-position.js';

type RangeController = NonNullable<Parameters<typeof restoreSessionTranscriptRange<StoredMessage>>[0]['controller']> & {
  loadBefore(maxBytes?: number, anchorTurnId?: string): Promise<void>;
  loadAfter(maxBytes?: number, anchorTurnId?: string): Promise<void>;
  loadLatest(): Promise<void>;
};

interface TurnIndex {
  sessionId: string;
  throughSequence: number | null;
  turns: readonly { turnId: string; sequence: number; label: string }[];
}

export interface TranscriptReadingPositionCommands {
  prepareSend(sessionId: string): Promise<boolean>;
  captureAnchor(turnId?: string): void;
  loadHistory(target: TranscriptHistoryRequest['target'], anchorTurnId?: string): Promise<void>;
}

/** The conversation owns restoration lifetime; the shell supplies explicit ports. */
export function TranscriptReadingPositionController(props: {
  commands: Ref<TranscriptReadingPositionCommands>;
  sessionId?: string;
  profileId?: string;
  landmarkSessionId?: string | null;
  currentSessionId: { current: string | undefined };
  rangeController: { current: RangeController | undefined };
  messages: readonly StoredMessage[];
  searchTarget: Parameters<typeof restoreSessionTranscriptRange>[0]['searchTarget'];
  clearSearchTarget(): void;
  sessionUi: AppShellSessionUiStateController;
  turnIndex: TurnIndex | undefined;
  setTurnIndex: Dispatch<SetStateAction<TurnIndex | undefined>>;
  listTurnLandmarks: Parameters<typeof refreshTranscriptTurnLandmarks<TurnIndex['turns'][number]>>[0]['list'];
  setHistoryPending: Dispatch<SetStateAction<TranscriptHistoryPending | undefined>>;
  historyPageBytes: number;
  onRestoreError(error: unknown, sessionId: string): void;
  onNavigationError(error: unknown, sessionId: string): void;
}) {
  const [lifecycle] = useState(createTranscriptRestoreLifecycle);
  const historyGates = useRef<TranscriptHistoryGates>(new WeakMap());
  const isCurrent = (sessionId: string, controller: object) =>
    props.currentSessionId.current === sessionId && props.rangeController.current === controller;
  const cancelHistory = (sessionId: string) => {
    const controller = props.rangeController.current;
    if (currentTranscriptRange(controller, sessionId) === undefined) return;
    if (controller) historyGates.current.delete(controller);
    props.setHistoryPending((current) => current?.sessionId === sessionId ? undefined : current);
  };
  const cancel = (sessionId: string, clearAnchor = false) => {
    lifecycle.cancel(sessionId);
    if (props.searchTarget?.sessionId === sessionId) props.clearSearchTarget();
    if (clearAnchor) {
      props.sessionUi.setTranscriptReadingAnchor(sessionId, undefined);
      props.sessionUi.setTranscriptRestoreUnavailable(sessionId, undefined);
    }
  };
  useImperativeHandle(props.commands, () => ({
    prepareSend(sessionId) {
      cancelHistory(sessionId);
      return prepareTranscriptForSend({
        sessionId, currentSessionId: props.currentSessionId,
        controller: props.rangeController, cancel,
        followLatest: props.sessionUi.transcriptViewportNavigation.followLatest,
      });
    },
    captureAnchor(turnId) {
      const { sessionId } = props;
      const controller = props.rangeController.current;
      if (!sessionId || props.currentSessionId.current !== sessionId) return;
      const previous = props.sessionUi.transcriptReadingAnchorBySessionRef.current[sessionId];
      props.sessionUi.setTranscriptRestoreUnavailable(sessionId, undefined);
      captureTranscriptReadingAnchor({
        sessionId, currentSessionId: props.currentSessionId.current, turnId, controller,
        setAnchor: props.sessionUi.setTranscriptReadingAnchor,
      });
      const range = currentTranscriptRange(controller, sessionId);
      if (range === undefined) return;
      const sequence = turnId ? controller?.store.sequenceForTurn(turnId) : undefined;
      // The send command already cleared its bookmark before publishing the
      // pin. Its empty-anchor acknowledgement is not another reader intent.
      if (previous?.turnId === turnId && previous?.sequence === (sequence ?? undefined)) return;
      let navigation: Promise<void> | undefined;
      cancelHistory(sessionId);
      if (turnId) navigation = controller?.setReadingAnchor(sequence ?? null, turnId);
      else if (!turnId && previous && !range.hasNewer) {
        cancel(sessionId, true);
        navigation = controller?.loadLatest();
      }
      void navigation?.catch((error) => {
        if (controller && isCurrent(sessionId, controller)) props.onNavigationError(error, sessionId);
      });
    },
    async loadHistory(target, anchorTurnId) {
      const controller = props.rangeController.current;
      const { sessionId } = props;
      if (!controller || !sessionId || !isCurrent(sessionId, controller)) return;
      cancel(sessionId, target === 'latest');
      // A direct latest command must enter the range controller now, so it
      // invalidates older pages rather than waiting behind a paging gate.
      if (target === 'latest' || historyGates.current.get(controller)?.active?.target === 'latest') {
        cancelHistory(sessionId);
      }
      const gates = historyGates.current;
      const gate: TranscriptHistoryGate = gates.get(controller) ?? { pending: false };
      gates.set(controller, gate);
      await loadTranscriptHistory({
        gates, sessionId, request: { target, anchorTurnId }, controller,
        maxBytes: props.historyPageBytes,
        isCurrent: () => isCurrent(sessionId, controller) && gates.get(controller) === gate,
        setPending: props.setHistoryPending,
        onError: (error) => props.onNavigationError(error, sessionId),
      });
    },
  }));

  const newestPrompt = newestDurablePromptSequence(props.rangeController.current, props.sessionId);
  const landmarkSessionId = props.landmarkSessionId === null
    ? undefined
    : props.landmarkSessionId ?? props.sessionId;
  useEffect(() => refreshTranscriptTurnLandmarks({
    sessionId: landmarkSessionId,
    newestDurablePromptSequence: newestPrompt,
    current: props.turnIndex,
    list: props.listTurnLandmarks,
    isCurrent: (sessionId) => props.currentSessionId.current === sessionId,
    setIndex: props.setTurnIndex,
  }), [props.sessionId, landmarkSessionId, newestPrompt, props.turnIndex]);
  useEffect(() => () => {
    lifecycle.deactivate();
  }, [props.sessionId, props.profileId, lifecycle]);
  useEffect(() => {
    if (props.searchTarget) {
      cancelHistory(props.searchTarget.sessionId);
    }
  }, [props.searchTarget?.nonce]);
  useEffect(() => restoreSessionTranscriptRange({
    lifecycle,
    sessionId: props.sessionId,
    profileId: props.profileId,
    searchTarget: props.searchTarget,
    readingAnchor: props.sessionId
      ? props.sessionUi.transcriptReadingAnchorBySessionRef.current[props.sessionId]
      : undefined,
    controller: props.rangeController.current,
    isCurrent,
    isLiveTurn: (sessionId, turnId) => props.sessionUi.liveTurnBySessionRef.current[sessionId]?.turnId === turnId,
    setReadingAnchor: props.sessionUi.setTranscriptReadingAnchor,
    onRestoreUnavailable: props.sessionUi.setTranscriptRestoreUnavailable,
    onError: props.onRestoreError,
  }), [props.sessionId, props.profileId, props.messages, props.searchTarget?.nonce]);
  return null;
}
