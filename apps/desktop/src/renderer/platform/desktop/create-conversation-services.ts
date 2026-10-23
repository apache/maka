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
import type { ConversationCheckinPort, ConversationServices } from '../../features/conversation/index.js';
import { sessionSnapshotToQuote } from '@maka/core/session-reference';


import { createDesktopConversationObservationServices } from './create-conversation-observation-services.js';

const PROMPT_SUGGESTIONS_KEY = 'maka.promptSuggestions.enabled';
const CHECKIN_ENABLED_KEY = 'maka.checkin.enabled';
const CHECKIN_MEMORY_KEY = 'maka.checkin.memory';

export function createDesktopConversationServices(
  bridge: Pick<
    MakaBridge,
    'shellRuns' | 'transcripts' | 'sessionLocal' | 'sessions' | 'runtimeHostProfiles' | 'skills' | 'workspace' | 'newTasks' | 'mcp'
  > = window.maka,
): ConversationServices {
  return {
    ...bridge.sessionLocal,
    observation: createDesktopConversationObservationServices(bridge),
    promptSuggestions: {
      generate: async (sessionId) => {
        const result = await bridge.sessions.generatePromptSuggestion(sessionId);
        return result.kind === 'generated' ? result.text : undefined;
      },
      // Browser storage belongs to this adapter; legacy renderer helpers cannot
      // be imported across the platform boundary.
      readEnabled: () => {
        try { return localStorage.getItem(PROMPT_SUGGESTIONS_KEY) === 'true'; }
        catch { return false; }
      },
      writeEnabled: (enabled) => {
        try { localStorage.setItem(PROMPT_SUGGESTIONS_KEY, String(enabled)); }
        catch { /* Storage can be unavailable in restricted renderers. */ }
      },
      subscribeEnabled: (handler) => {
        const onStorage = (event: StorageEvent) => {
          if (event.key === null || event.key === PROMPT_SUGGESTIONS_KEY) handler();
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
      },
    },
    checkin: createDesktopCheckinPort(bridge),
    sessions: {
      ...bridge.sessions,
      updateQueueEntry: (sessionId: string, entryId: string, expectedQueueRevision: number, text: string) =>
        bridge.sessions.updateQueueEntry(sessionId, entryId, expectedQueueRevision, text),
      reorderQueueEntries: (sessionId: string, entryIds: readonly string[], expectedQueueRevision: number) =>
        bridge.sessions.reorderQueueEntries(sessionId, entryIds, expectedQueueRevision),
    },
    runtimeHosts: {
      subscribeChanges: (handler) => bridge.runtimeHostProfiles.subscribeChanges(handler),
    },
    resume: {
      queryPlan: (sessionId) => bridge.sessions.queryResumeLatest(sessionId),
      start: (sessionId) => bridge.sessions.resumeLatest(sessionId),
      subscribeChanges: (handler) => bridge.sessions.subscribeChanges(handler),
    },
    skills: bridge.skills,
    workspace: bridge.workspace,
    newTasks: bridge.newTasks,
    mcp: {
      subscribeChanges: (handler) => bridge.mcp.subscribeChanges(handler),
    },
  };
}

function createDesktopCheckinPort(bridge: Pick<MakaBridge, 'sessions'>): ConversationCheckinPort {
  return {
    generate: (input) => bridge.sessions.generateCheckin({ effectId: input.effectId, since: input.since }),
    readEnabled: () => {
      try { return localStorage.getItem(CHECKIN_ENABLED_KEY) === 'true'; }
      catch { return false; }
    },
    writeEnabled: (enabled) => {
      try { localStorage.setItem(CHECKIN_ENABLED_KEY, String(enabled)); }
      catch { /* Storage can be unavailable in restricted renderers. */ }
    },
    readMemory: () => {
      try { return JSON.parse(localStorage.getItem(CHECKIN_MEMORY_KEY) ?? 'null'); }
      catch { return null; }
    },
    writeMemory: (memory) => {
      try { localStorage.setItem(CHECKIN_MEMORY_KEY, JSON.stringify(memory)); }
      catch { /* Storage can be unavailable in restricted renderers. */ }
    },
    readRevision: async (sessionId) => (await bridge.sessions.get(sessionId))?.revision,
    resume: async (sessionId) => (await bridge.sessions.resumeLatest(sessionId)).disposition === 'started',
    send: async (sessionId, text) =>
      (await bridge.sessions.send(sessionId, { type: 'send', turnId: crypto.randomUUID(), text })).ok,
    startSession: async (sourceSessionId, text) => {
      const source = await bridge.sessions.get(sourceSessionId);
      if (!source) return undefined;
      const created = await bridge.sessions.create({
        ...(source.cwd ? { cwd: source.cwd } : {}),
        ...(source.projectId !== undefined ? { projectId: source.projectId } : {}),
        ...(source.llmConnectionId ? { llmConnectionId: source.llmConnectionId } : {}),
        llmConnectionSlug: source.llmConnectionSlug,
        model: source.model,
      });
      const snapshot = await bridge.sessions.readSnapshot(sourceSessionId).catch(() => undefined);
      const sent = await bridge.sessions.send(created.id, {
        type: 'send',
        turnId: crypto.randomUUID(),
        text,
        ...(snapshot ? { quotes: [sessionSnapshotToQuote(snapshot)] } : {}),
      });
      return sent.ok ? created.id : undefined;
    },
  };
}
