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

import { useEffect, useImperativeHandle, useState, type Ref } from 'react';
import type { StoredMessage } from '@maka/core/session';
import type { AppShellSessionUiStateController } from '../model/session-ui-state.js';
import {
  createTranscriptRestoreLifecycle,
  prepareTranscriptForSend,
  restoreSessionTranscriptRange,
} from './transcript-reading-position.js';

type RangeController = NonNullable<Parameters<typeof restoreSessionTranscriptRange<StoredMessage>>[0]['controller']>;

export interface TranscriptReadingPositionCommands {
  prepareSend(sessionId: string): boolean;
  captureAnchor(turnId?: string): void;
  loadEarlier(): Promise<void>;
}

/** The conversation owns restoration lifetime; the shell supplies explicit ports. */
export function TranscriptReadingPositionController(props: {
  commands: Ref<TranscriptReadingPositionCommands>;
  sessionId?: string;
  profileId?: string;
  currentSessionId: { current: string | undefined };
  rangeController: { current: RangeController | undefined };
  messages: readonly StoredMessage[];
  searchTarget: Parameters<typeof restoreSessionTranscriptRange>[0]['searchTarget'];
  clearSearchTarget(): void;
  sessionUi: AppShellSessionUiStateController;
  onRestoreError(error: unknown, sessionId: string): void;
}) {
  const [lifecycle] = useState(createTranscriptRestoreLifecycle);
  const isCurrent = (sessionId: string, controller: object) =>
    props.currentSessionId.current === sessionId && props.rangeController.current === controller;
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
        sessionId, currentSessionId: props.currentSessionId, cancel,
        followLatest: props.sessionUi.transcriptViewportNavigation.followLatest,
      });
    },
    captureAnchor(turnId) {
      const { sessionId } = props;
      if (!sessionId || props.currentSessionId.current !== sessionId) return;
      props.sessionUi.setTranscriptRestoreUnavailable(sessionId, undefined);
      props.sessionUi.setTranscriptReadingAnchor(sessionId, turnId ? { turnId } : undefined);
    },
    async loadEarlier() {
      const controller = props.rangeController.current;
      const { sessionId } = props;
      if (!controller || !sessionId || !isCurrent(sessionId, controller)) return;
      await controller.loadEarlier();
    },
  }));

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
  return null;
}
