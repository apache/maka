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

import { resolveSystemUiLocale, resolveUiLocale } from '@maka/core/ui-locale';
import { DEFAULT_UI_FONT_SIZE } from '@maka/core/settings';
import { applyDocumentThemeMode, applyDocumentThemePalette, applyDocumentUiFontSize } from './document-appearance.js';
import type { MakaBridge } from '../../../preload/bridge-contract.js';
import {
  projectWorkHubDelegationState,
  workHubTurnResultPreview,
  type WorkHubDelegationReference,
  type WorkHubServices,
} from '../../features/workhub/index.js';
import {
  DesktopTranscriptRangeStore,
  createDesktopTranscriptRangeController,
  createRecoveringDesktopTranscriptRangeController,
} from './desktop-transcript-range-store.js';
import type { TurnRecord } from '@maka/core/session';
import {
  MESSAGE_QUEUE_MAX_ENTRIES,
  type TurnMessageExecutionResolution,
} from '@maka/runtime-host/protocol';

const WORKHUB_RESULT_SCAN_MAX_PAGES = 16;

async function readDelegatedTurnResult(
  bridge: Pick<MakaBridge, 'transcripts'>,
  sessionId: string,
  turn: TurnRecord,
): Promise<string | undefined> {
  const store = new DesktopTranscriptRangeStore(sessionId);
  const controller = createDesktopTranscriptRangeController(store, (signal) =>
    bridge.transcripts.open(
      sessionId,
      (batch) => {
        if (signal.aborted) return;
        store.accept(batch);
      },
      (cancel) => {
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      },
    ),
  );
  try {
    await controller.ready();
    let preview: string | undefined;
    let lastTargetSequence: number | undefined;
    const boundaryEstablished = () => {
      const entries = store.durableEntries();
      const currentPreview = workHubTurnResultPreview(
        entries.map(({ message }) => message),
        turn.turnId,
      );
      if (currentPreview) preview = currentPreview;
      for (const entry of entries) {
        if (entry.message.turnId === turn.turnId) {
          lastTargetSequence = Math.max(lastTargetSequence ?? entry.sequence, entry.sequence);
        }
      }
      const crossedIntoLaterTurn = lastTargetSequence !== undefined && entries.some(
        (entry) => entry.sequence > lastTargetSequence! && entry.message.turnId !== turn.turnId,
      );
      return lastTargetSequence !== undefined && (
        crossedIntoLaterTurn || !store.range().hasNewer
      );
    };
    if (!boundaryEstablished() && lastTargetSequence === undefined && turn.firstSequence !== undefined) {
      await controller.loadAround(turn.firstSequence);
    }
    for (let page = 0; page <= WORKHUB_RESULT_SCAN_MAX_PAGES; page += 1) {
      if (boundaryEstablished()) return preview;
      if (!store.range().hasNewer || page === WORKHUB_RESULT_SCAN_MAX_PAGES) return undefined;
      await controller.loadAfter();
    }
    return undefined;
  } finally {
    await controller.close();
  }
}

export function createDesktopWorkHubServices(
  bridge: Pick<
    MakaBridge,
    | 'workHub'
    | 'workHubControl'
    | 'workHubPresentation'
    | 'sessions'
    | 'transcripts'
    | 'connections'
    | 'runtimeHostProfiles'
    | 'settings'
    | 'attachments'
  > = window.maka,
): WorkHubServices {
  const delegatedResultCache = new Map<string, string>();
  return {
    surface: new URLSearchParams(window.location.search).get('surface') === 'workhub' ? 'workhub' : 'main',
    initialLocale: resolveSystemUiLocale(navigator.languages),
    subscribeAppearance(handler) {
      let disposed = false;
      let revision = 0;
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const refresh = () => {
        const read = ++revision;
        void bridge.settings.getClient().then((settings) => {
          if (disposed || read !== revision) return;
          const dark = settings.appearance.theme === 'dark' || (settings.appearance.theme === 'auto' && media.matches);
          applyDocumentThemeMode(dark);
          applyDocumentThemePalette(settings.appearance.palette ?? 'default');
          applyDocumentUiFontSize(settings.appearance.uiFontSize ?? DEFAULT_UI_FONT_SIZE);
          handler(resolveUiLocale(settings.personalization.uiLocale ?? 'auto', resolveSystemUiLocale(navigator.languages)));
        }).catch(() => undefined);
      };
      const unsubscribe = bridge.settings.subscribeClientChanged(refresh);
      media.addEventListener('change', refresh);
      window.addEventListener('languagechange', refresh);
      refresh();
      return () => { disposed = true; unsubscribe(); media.removeEventListener('change', refresh); window.removeEventListener('languagechange', refresh); };
    },
    presentation: bridge.workHubPresentation,
    control: bridge.workHubControl,
    resolve: () => bridge.workHub.resolveCoordinationSession(),
    getSession: (sessionId) => bridge.workHub.getSession(sessionId),
    subscribeHosts: (handler) => bridge.runtimeHostProfiles.subscribeChanges(handler),
    subscribeAvailability: (handler) => bridge.connections.subscribeEvents(() => handler()),
    listSessions: () => bridge.sessions.list(),
    subscribeSessions: (handler) => bridge.sessions.subscribeChanges(handler),
    async delegationFeedback(references) {
      let sessions: Awaited<ReturnType<typeof bridge.sessions.list>> = [];
      try {
        sessions = await bridge.sessions.list();
      } catch {
        // Exact target reads below may still prove terminal state and result.
      }
      const sessionById = new Map(sessions.map((session) => [session.id, session]));
      const grouped = new Map<string, WorkHubDelegationReference[]>();
      for (const reference of references) {
        const group = grouped.get(reference.targetSessionId) ?? [];
        group.push(reference);
        grouped.set(reference.targetSessionId, group);
      }
      const feedback = await Promise.all([...grouped.entries()].map(async ([sessionId, group]) => {
        const executionQuery = async () => {
          const messageIds = [...new Set(group.map((reference) => reference.targetMessageId))];
          const resolutions: TurnMessageExecutionResolution[] = [];
          for (let from = 0; from < messageIds.length; from += MESSAGE_QUEUE_MAX_ENTRIES) {
            const result = await bridge.sessions.queryMessageExecutions(
              sessionId,
              messageIds.slice(from, from + MESSAGE_QUEUE_MAX_ENTRIES),
            );
            resolutions.push(...result.resolutions);
          }
          return resolutions;
        };
        const [turnRead, executionRead] = await Promise.allSettled([
          bridge.sessions.listTurns(sessionId),
          executionQuery(),
        ]);
        const turns = turnRead.status === 'fulfilled' ? turnRead.value : [];
        const resolutions = executionRead.status === 'fulfilled'
          ? executionRead.value
          : [];
        const turnById = new Map(turns.map((turn) => [turn.turnId, turn]));
        const resolutionByMessageId = new Map(
          resolutions.map((resolution) => [resolution.messageId, resolution]),
        );
        return Promise.all(group.map(async (reference) => {
          const resolution = resolutionByMessageId.get(reference.targetMessageId);
          const turn = resolution?.state === 'owned' ? turnById.get(resolution.turnId) : undefined;
          const state = projectWorkHubDelegationState({
            resolution,
            session: sessionById.get(sessionId),
            turn,
            turnReadFailed: turnRead.status === 'rejected',
            executionReadFailed: executionRead.status === 'rejected',
          });
          let resultPreview: string | undefined;
          if (state === 'completed' && turn) {
            const cacheKey = JSON.stringify([sessionId, turn.turnId]);
            resultPreview = delegatedResultCache.get(cacheKey);
            if (!resultPreview) {
              try {
                resultPreview = await readDelegatedTurnResult(bridge, sessionId, turn);
                if (resultPreview) {
                  delegatedResultCache.set(cacheKey, resultPreview);
                  if (delegatedResultCache.size > 100) {
                    delegatedResultCache.delete(delegatedResultCache.keys().next().value!);
                  }
                }
              } catch {
                // Completion remains authoritative even when its bounded result
                // projection is temporarily unavailable.
              }
            }
          }
          return { id: reference.id, state, ...(resultPreview ? { resultPreview } : {}) };
        }));
      }));
      return feedback.flat();
    },
    modelChoices: async (sessionId) =>
      (await bridge.connections.getSnapshot(sessionId)).chatModelChoices,
    attachments: bridge.attachments,
    readAttachmentBytes: bridge.attachments.readBytes,
    prepareAttachments: (sessionId, items) => bridge.workHub.prepareAttachments(sessionId, items),
    answer: (sessionId, input) => bridge.workHub.answer(sessionId, input),
    enqueueMessage: async (sessionId, messageId, text, attachments, placement) => {
      const result = await bridge.sessions.submitMessage(sessionId, placement, {
        messageId, text, retainedAttachments: attachments,
      }, { waitForHostAdmission: true });
      if (result.ok) return result.disposition === (placement === 'current_turn' ? 'steering' : 'followup') ? 'admitted' : 'rejected';
      return result.reason === 'outcome_unknown' ? 'unknown' : 'rejected';
    },
    retractQueueEntry: (sessionId, entryId) => bridge.sessions.retractQueueEntry(sessionId, entryId),
    promoteQueueEntry: (sessionId, entryId) => bridge.sessions.promoteQueueEntry(sessionId, entryId),
    updateQueueEntry: (sessionId, entryId, revision, text) => bridge.sessions.updateQueueEntry(sessionId, entryId, revision, text),
    reorderQueueEntries: (sessionId, entryIds) => bridge.sessions.reorderQueueEntries(sessionId, entryIds),
    configureModel: (sessionId, input) => bridge.workHub.configureModel(sessionId, input),
    observe: (sessionId, handler, onError, onPhase, onExecution) =>
      bridge.sessions.subscribeEvents(sessionId, handler, onPhase, onError, onExecution),
    stop: async (sessionId, turnId) => {
      const result = await bridge.sessions.stop(sessionId, {
        source: 'stop_button',
        expectedTurnId: turnId,
      });
      return result?.kind === 'interrupted' ? result.retractedMessageIds
        : result?.kind === 'retracted' ? [result.messageId] : undefined;
    },
    async openTranscript(sessionId, handler, cancellation, onError) {
      const store = new DesktopTranscriptRangeStore(sessionId);
      // Every window change commits through the store, a trim included, so
      // this is the whole of what the surface hears.
      const unsubscribe = store.subscribe(() => handler(store.snapshot()));
      const controller = createRecoveringDesktopTranscriptRangeController(store, (signal) =>
        bridge.transcripts.open(
          sessionId,
          (batch) => {
            if (signal.aborted) return;
            store.accept(batch);
          },
          (cancel) => {
            if (signal.aborted) cancel();
            else signal.addEventListener('abort', cancel, { once: true });
          },
        ),
        { onError },
      );
      const cancel = () => { unsubscribe(); void controller.close(); };
      cancellation.addEventListener('abort', cancel, { once: true });
      if (cancellation.aborted) cancel();
      return {
        observationChanged: controller.observationChanged,
        prefetchHistory: (edge) =>
          edge === 'older' ? controller.loadBefore() : controller.loadAfter(),
        retain: ({ firstTurnId, lastTurnId }) => {
          // A Turn the band named but the window no longer holds yields null,
          // which leaves that side of the window unbounded rather than empty.
          controller.store.retain(
            controller.store.sequenceForTurn(firstTurnId, 'first'),
            controller.store.sequenceForTurn(lastTurnId, 'last'),
          );
        },
        loadLatest: () => controller.loadLatest(),
        close: () => {
          cancellation.removeEventListener('abort', cancel);
          unsubscribe();
          return controller.close();
        },
      };
    },
  };
}
