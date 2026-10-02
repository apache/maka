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

import { useLayoutEffect, useRef, useState } from 'react';
import { useToast, useUiLocale, dequeueInteractionByRequestId } from '@maka/ui';
import { useSessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { recordSessionEventStreamChange } from '../../../application/contracts/session-catalog/session-event-health.js';
import { createTranscriptCommands } from '../model/transcript-commands.js';
import { createContextCompactionCommands } from '../model/context-compaction.js';
import { createConversationWorkspace } from '../model/conversation-workspace.js';
import { useConversationServices } from '../services.js';

/** Constructed only by ConversationProvider; mutable publication never leaves it. */
export function useConversationController() {
  const catalog = useSessionCatalogController();
  const services = useConversationServices();
  const locale = useUiLocale();
  const toast = useToast();
  const feedback = useRef({ locale, toast });
  useLayoutEffect(() => { feedback.current = { locale, toast }; }, [locale, toast]);
  const [workspace] = useState(() => createConversationWorkspace(catalog, services.observation));
  const interactionHydration = useRef<{ sessionId: string } | null>(null);
  const events = useRef<import('../model/session-events.js').AppShellSessionEventHandlers>(null);
  const readingCommands = useRef<import('./transcript-reading-position-controller.js').TranscriptReadingPositionCommands>(null);
  const [commands] = useState(() => {
    return {
      ...workspace.commands,
      clearMessageLoadError: workspace.ui.clearMessageLoadError,
      markInteractionChanged(sessionId: string) {
        if (interactionHydration.current?.sessionId === sessionId) interactionHydration.current = null;
      },
      settleInteraction(sessionId: string, requestId: string) {
        workspace.ui.setInteractionBySession((current) => dequeueInteractionByRequestId(current, sessionId, requestId));
      },
      recordSessionChange(sessionId: string, ts: number) {
        workspace.ui.setSessionEventHealthBySession((current) => {
          const previous = current[sessionId];
          return previous ? { ...current, [sessionId]: recordSessionEventStreamChange(previous, ts) } : current;
        });
      },
      ...createTranscriptCommands(workspace, feedback),
      ...createContextCompactionCommands({
        compact: (sessionId) => services.sessions.compact(sessionId),
        isCurrentSession: (sessionId) => workspace.activeIdRef.current === sessionId,
        feedback,
      }),
      clearOwnedSessionState(sessionId: string) {
        events.current?.discardDisplayEvents(sessionId);
        workspace.commands.clearOwnedSessionState(sessionId);
      },
      settleAssistantStreaming: async (sessionId: string, messageId?: string) => events.current?.settleAssistantStreaming(sessionId, messageId),
      prepareSend: (sessionId: string) => readingCommands.current?.prepareSend(sessionId) ?? true,
    };
  });
  return { workspace, commands, readingCommands, events, interactionHydration };
}
