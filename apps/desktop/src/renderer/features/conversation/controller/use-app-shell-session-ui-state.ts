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
import { currentTranscriptRange } from './transcript-reading-position.js';
import { createAppShellSessionUiStateController, type AppShellSessionUiStateController } from '../model/session-ui-state.js';

interface TranscriptSource {
  range(): { readonly sessionId: string; readonly hasOlder: boolean; readonly hasNewer: boolean };
  snapshot(): { readonly messages: readonly StoredMessage[]; readonly ready: boolean };
}

/** The rendered messages and gap flags are a single publication. The source
 * may advance during reader input, but only the scroll authority admits it. */
export function useAppShellSessionUiState<Controller extends { readonly store: TranscriptSource }>(
  activeIdRef: { current: string | undefined },
  publishMessages: (messages: StoredMessage[]) => void,
) {
  // The observable controller retains its own identity and subscriptions;
  // publication is the React view of the active transcript, not a store copy.
  const controllerRef = useRef<AppShellSessionUiStateController | null>(null);
  controllerRef.current ??= createAppShellSessionUiStateController();
  const controller = controllerRef.current;
  const transcriptRangeRef = useRef<Controller | undefined>(undefined);
  const messagesRef = useRef<StoredMessage[]>([]);
  const [view, setView] = useState<{
    messages: StoredMessage[];
    range: ReturnType<TranscriptSource['range']> | undefined;
  }>({ messages: [], range: undefined });

  // These actions capture only lifetime-stable refs, setters and the workspace
  // callback that dispatches through its actions ref. Keep their identities as
  // stable as the other workspace actions consumers receive.
  const [actions] = useState(() => ({
    isMessagePublished: (message: StoredMessage) => messagesRef.current.includes(message),
    setMessagesState(messages: StoredMessage[]) {
      setView({
        messages,
        range: messages.length
          ? currentTranscriptRange(transcriptRangeRef.current, activeIdRef.current)
          : undefined,
      });
    },
    publishTranscript(sessionId: string, store: TranscriptSource, onReady: () => void) {
      controller.transcriptViewportNavigation.commitRange(sessionId, () => {
        if (transcriptRangeRef.current?.store !== store || activeIdRef.current !== sessionId) return;
        const snapshot = store.snapshot();
        publishMessages([...snapshot.messages]);
        if (snapshot.ready) onReady();
      });
    },
  }));

  return {
    controller,
    publication: {
      transcriptRangeRef,
      messagesRef,
      messages: view.messages,
      publishedTranscriptRange: view.range,
      ...actions,
    },
  };
}
