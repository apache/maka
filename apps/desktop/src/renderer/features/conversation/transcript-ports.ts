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

import type { StoredMessage } from '@maka/core/session';
import type { SessionEvent, ActiveInteractionRequestEvent, ShellRunUpdate } from '@maka/core/events';
import type { AppShellSessionUiStateController } from './model/session-ui-state.js';
type SessionExecutionProjection = Parameters<AppShellSessionUiStateController['setExecution']>[1];

/** The visible range is distinct from the event subscription and its watermark. */
export interface ConversationTranscriptController {
  readonly store: {
    range(): { readonly sessionId: string; readonly hasOlder: boolean; readonly ready: boolean; readonly generation?: string };
    snapshot(): { readonly sessionId: string; readonly messages: readonly StoredMessage[]; readonly ready: boolean };
    subscribe(listener: () => void): () => void;
    hasDurableMessage(messageId: string): boolean;
  };
  ready(): Promise<void>;
  waitForDurableMessage(messageId: string, timeoutMs: number): Promise<boolean>;
  loadEarlier(throughSequence?: number): Promise<void>;
  reload(): Promise<void>;
  holdsCachedTranscript(): boolean;
  observationChanged(phase: 'pending' | 'ready'): void;
  close(): Promise<void>;
}

export interface ConversationObservationServices {
  openTranscript(sessionId: string, onError: (error: unknown) => void): ConversationTranscriptController;
  subscribeEvents(
    sessionId: string,
    onEvent: (event: SessionEvent) => void,
    onPhase: (phase: 'pending' | 'ready') => void,
    onFailure: () => void,
    onExecution: (projection: SessionExecutionProjection | undefined) => void,
  ): () => void;
  listActiveInteractions(sessionId: string): Promise<ActiveInteractionRequestEvent[]>;
  subscribeActiveInteractions(handler: (event: { sessionId: string; interactions: ActiveInteractionRequestEvent[] }) => void): () => void;
  readonly shellRuns: {
    list(sessionId: string): Promise<ShellRunUpdate[]>;
    subscribeUpdates(handler: (update: ShellRunUpdate) => void): () => void;
    subscribeResync(handler: (event: { sessionId: string }) => void): () => void;
  };
  subscribeVisible(handler: () => void): () => void;
  queryCancelledMessages(sessionId: string, messageIds: string[]): Promise<{ cancelledMessageIds: readonly string[] }>;
}
