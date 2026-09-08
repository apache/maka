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
import { DEFAULT_UI_FONT_SIZE, normalizeUiFontSize } from '@maka/core/settings';
import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { WorkHubServices } from '../../features/workhub/index.js';
import {
  DesktopTranscriptRangeStore,
  createDesktopTranscriptRangeController,
} from './desktop-transcript-range-store.js';

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
          const root = document.documentElement;
          root.classList.toggle('dark', dark);
          root.style.colorScheme = dark ? 'dark' : 'light';
          const palette = settings.appearance.palette ?? 'default';
          if (palette === 'default') root.removeAttribute('data-maka-theme'); else root.setAttribute('data-maka-theme', palette);
          root.style.fontSize = `${16 * normalizeUiFontSize(settings.appearance.uiFontSize ?? DEFAULT_UI_FONT_SIZE) / DEFAULT_UI_FONT_SIZE}px`;
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
    modelChoices: async (sessionId) =>
      (await bridge.connections.getSnapshot(sessionId)).chatModelChoices,
    attachments: bridge.attachments,
    readAttachmentBytes: bridge.attachments.readBytes,
    prepareAttachments: (sessionId, items) => bridge.workHub.prepareAttachments(sessionId, items),
    answer: (sessionId, input) => bridge.workHub.answer(sessionId, input),
    configureModel: (sessionId, input) => bridge.workHub.configureModel(sessionId, input),
    observe: (sessionId, handler, onError) =>
      bridge.sessions.subscribeEvents(sessionId, handler, undefined, undefined, onError),
    stop: (sessionId, turnId) =>
      bridge.sessions.stop(sessionId, {
        source: 'stop_button',
        expectedTurnId: turnId,
      }),
    async openTranscript(sessionId, handler, cancellation) {
      const store = new DesktopTranscriptRangeStore(sessionId);
      const controller = createDesktopTranscriptRangeController(store, (signal) =>
        bridge.transcripts.open(
          sessionId,
          (batch) => {
            if (signal.aborted) return;
            if (store.accept(batch) || batch.ready) handler(store.snapshot());
          },
          (cancel) => {
            if (signal.aborted) cancel();
            else signal.addEventListener('abort', cancel, { once: true });
          },
        ),
      );
      const cancel = () => { void controller.close(); };
      cancellation.addEventListener('abort', cancel, { once: true });
      if (cancellation.aborted) cancel();
      try {
        await controller.ready();
      } catch (error) {
        cancellation.removeEventListener('abort', cancel);
        await controller.close().catch(() => undefined);
        throw error;
      }
      return {
        loadOlder: () => controller.loadBefore(),
        loadLatest: () => controller.loadLatest(),
        close: () => { cancellation.removeEventListener('abort', cancel); return controller.close(); },
      };
    },
  };
}
