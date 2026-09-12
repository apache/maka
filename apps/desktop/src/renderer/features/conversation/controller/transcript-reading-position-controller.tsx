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
  newestDurablePromptSequence,
  prepareTranscriptForSend,
  refreshTranscriptTurnLandmarks,
  restoreSessionTranscriptRange,
  TranscriptReadSupersededError,
} from './transcript-reading-position.js';

type RangeController = NonNullable<Parameters<typeof restoreSessionTranscriptRange<StoredMessage>>[0]['controller']> & {
  readonly store: {
    retain(oldestSequence: number | null, newestSequence: number | null): boolean;
    snapshot(): object;
  };
  loadBefore(maxBytes?: number): Promise<boolean>;
  loadAfter(maxBytes?: number): Promise<boolean>;
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
  returnToLatest(): Promise<void>;
  prefetchHistory(edge: 'older' | 'newer'): Promise<boolean>;
  retainWindow(window: { firstTurnId: string; lastTurnId: string }): void;
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
  onRestoreError(error: unknown, sessionId: string): void;
  onNavigationError(error: unknown, sessionId: string): void;
}) {
  const [lifecycle] = useState(createTranscriptRestoreLifecycle);
  const lastLiveGeneration = useRef<
    { sessionId: string; generation: string; hostEpoch: string } | undefined
  >(undefined);
  const isCurrent = (sessionId: string, controller: object) =>
    props.currentSessionId.current === sessionId && props.rangeController.current === controller;
  const reportNavigationError = (error: unknown, sessionId: string, controller: object) => {
    if (error instanceof TranscriptReadSupersededError) return;
    if (isCurrent(sessionId, controller)) props.onNavigationError(error, sessionId);
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
      return prepareTranscriptForSend({
        sessionId, currentSessionId: props.currentSessionId,
        controller: props.rangeController, cancel,
        followLatest: props.sessionUi.transcriptViewportNavigation.followLatest,
      });
    },
    captureAnchor(turnId) {
      const { sessionId } = props;
      if (!sessionId || props.currentSessionId.current !== sessionId) return;
      props.sessionUi.setTranscriptRestoreUnavailable(sessionId, undefined);
      captureTranscriptReadingAnchor({
        sessionId, currentSessionId: props.currentSessionId.current, turnId,
        controller: props.rangeController.current,
        setAnchor: props.sessionUi.setTranscriptReadingAnchor,
      });
    },
    retainWindow(window) {
      const controller = props.rangeController.current;
      const { sessionId } = props;
      if (!controller || !sessionId || !isCurrent(sessionId, controller)) return;
      if (currentTranscriptRange(controller, sessionId) === undefined) return;
      try {
        controller.store.retain(
          controller.store.sequenceForTurn(window.firstTurnId, 'first'),
          controller.store.sequenceForTurn(window.lastTurnId, 'last'),
        );
      } catch {
        // A stale range has no window to trim.
      }
    },
    /**
     * Deliberately not `returnToLatest`: that one cancels restoration and
     * clears the search target, because a reader who asks to go somewhere has
     * decided where to be. Filling decides nothing, so it must leave an
     * outstanding jump alone — the page it is waiting for can still be in
     * flight.
     *
     * Safe to ask on every frame the geometry wants it: the range controller
     * refuses a read against a window it has already read, and answers whether
     * it issued one.
     */
    async prefetchHistory(edge) {
      const controller = props.rangeController.current;
      const { sessionId } = props;
      if (!controller || !sessionId || !isCurrent(sessionId, controller)) return false;
      return edge === 'older' ? controller.loadBefore() : controller.loadAfter();
    },
    async returnToLatest() {
      const controller = props.rangeController.current;
      const { sessionId } = props;
      if (!controller || !sessionId || !isCurrent(sessionId, controller)) return;
      cancel(sessionId, true);
      try {
        await controller.loadLatest();
      } catch (error) {
        reportNavigationError(error, sessionId, controller);
      }
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
    setReadingAnchor: props.sessionUi.setTranscriptReadingAnchor,
    onRestoreUnavailable: props.sessionUi.setTranscriptRestoreUnavailable,
    onError: props.onRestoreError,
  }), [props.sessionId, props.profileId, props.messages, props.searchTarget?.nonce]);
  useEffect(() => {
    const controller = props.rangeController.current;
    const { sessionId } = props;
    const range = currentTranscriptRange(controller, sessionId);
    if (!controller || !sessionId || !range?.generation || !range.hostEpoch) return;
    if (range.generation.startsWith('cached:')) return;
    const previous = lastLiveGeneration.current;
    lastLiveGeneration.current = { sessionId, generation: range.generation, hostEpoch: range.hostEpoch };
    if (!previous || previous.sessionId !== sessionId || previous.generation === range.generation) return;
    const anchor = props.sessionUi.transcriptReadingAnchorBySessionRef.current[sessionId];
    if (!anchor || controller.store.sequenceForTurn(anchor.turnId) !== null) return;
    const navigate = (sequence: number) => {
      void controller.loadAround(sequence).catch((error) => {
        reportNavigationError(error, sessionId, controller);
      });
    };
    if (previous.hostEpoch === range.hostEpoch) {
      if (anchor.sequence !== undefined) navigate(anchor.sequence);
      return;
    }
    // Sequences only name the same rows within one Host epoch, so a bookmark
    // carried across one has to be found again by Turn. The landmark index in
    // hand still names the epoch that is gone, hence the refresh first.
    if (landmarkSessionId !== sessionId) return;
    const { turnId } = anchor;
    let disposed = false;
    void props.listTurnLandmarks(sessionId).then((snapshot) => {
      if (disposed || !isCurrent(sessionId, controller)) return;
      props.setTurnIndex({ sessionId, throughSequence: snapshot.throughSequence, turns: snapshot.landmarks });
      // A reader who has gone somewhere else since owns the position now.
      if (props.sessionUi.transcriptReadingAnchorBySessionRef.current[sessionId]?.turnId !== turnId) return;
      const landmark = snapshot.landmarks.find((turn) => turn.turnId === turnId);
      // A Turn the new epoch does not name leaves the reader where the reset put them.
      if (!landmark) return;
      props.sessionUi.setTranscriptReadingAnchor(sessionId, { turnId, sequence: landmark.sequence });
      navigate(landmark.sequence);
    }, () => undefined);
    return () => { disposed = true; };
  }, [props.sessionId, props.messages]);
  return null;
}
