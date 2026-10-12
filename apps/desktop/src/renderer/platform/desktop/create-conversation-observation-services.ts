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

import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { ConversationObservationServices } from '../../features/conversation/index.js';
import { DesktopTranscriptRangeStore, createDesktopTranscriptRangeController, openDesktopTranscriptHistory } from './desktop-transcript-range-store.js';

export function createDesktopConversationObservationServices(
  bridge: Pick<MakaBridge, 'sessions' | 'transcripts' | 'shellRuns'> = window.maka,
): ConversationObservationServices {
  return {
    openTranscript(sessionId, onError) {
      const store = new DesktopTranscriptRangeStore(sessionId);
      return createDesktopTranscriptRangeController(store,
        openDesktopTranscriptHistory(bridge.transcripts.open, sessionId, (batch) => {
          try { store.accept(batch); } catch (error) { onError(error); }
        }), { onError });
    },
    subscribeEvents: (...args) => bridge.sessions.subscribeEvents(...args),
    listActiveInteractions: (sessionId) => bridge.sessions.listActiveInteractions(sessionId),
    subscribeActiveInteractions: (handler) => bridge.sessions.subscribeActiveInteractions(handler),
    shellRuns: {
      list: (sessionId) => bridge.shellRuns.list(sessionId),
      subscribeUpdates: (handler) => bridge.shellRuns.subscribeUpdates(handler),
      subscribeResync: (handler) => bridge.shellRuns.subscribeResync(handler),
    },
    subscribeVisible(handler) {
      const onVisible = () => { if (document.visibilityState === 'visible') handler(); };
      document.addEventListener('visibilitychange', onVisible);
      return () => document.removeEventListener('visibilitychange', onVisible);
    },
    queryCancelledMessages: (...args) => bridge.sessions.queryCancelledMessages(...args),
  };
}
