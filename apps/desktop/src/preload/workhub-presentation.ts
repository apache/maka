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

import { ipcRenderer } from 'electron';
import { invokeWhenReady } from './bootstrap-invoke.js';
import type { WorkHubPresentationBridge } from '../shared/workhub-presentation.js';

function subscribe<T>(channel: string, handler: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

export const workHubPresentationBridge: WorkHubPresentationBridge = {
  ready: () => invokeWhenReady('workhub-presentation:command', 'ready'),
  getSnapshot: () => invokeWhenReady('workhub-presentation:command', 'snapshot'),
  setHost: (host) => invokeWhenReady('workhub-presentation:command', 'host', host),
  setConversationLayout: (layout) => invokeWhenReady('workhub-presentation:command', 'conversation-layout', layout),
  progressReady: (request) => invokeWhenReady('workhub-presentation:command', 'progress-ready', request),
  resizeProgress: (request, height) => invokeWhenReady('workhub-presentation:command', 'progress-layout', { request, height }),
  expandProgress: (request) => invokeWhenReady('workhub-presentation:command', 'show-conversation', request),
  detach: () => invokeWhenReady('workhub-presentation:command', 'detach'),
  dock: () => invokeWhenReady('workhub-presentation:command', 'dock'),
  hide: () => invokeWhenReady('workhub-presentation:command', 'hide'),
  openUsage: () => invokeWhenReady('workhub-presentation:command', 'usage'),
  toggleWorkbar: () => invokeWhenReady('workhub-presentation:command', 'toggle-workbar'),
  openSession: (sessionKey) => invokeWhenReady('workhub-presentation:command', 'session', sessionKey),
  openSettings: (section) => invokeWhenReady('workhub-presentation:command', 'settings', section),
  subscribe: (handler) => subscribe('workhub-presentation:changed', handler),
  onViewportInset: (handler) => subscribe('workhub-presentation:viewport-inset', handler),
  onFocusComposer: (handler) => subscribe('workhub-presentation:focus-composer', handler),
  onOpenMain: (handler) => {
    const unsubscribe = subscribe('workhub-presentation:open-main', handler);
    void invokeWhenReady('workhub-presentation:command', 'ready').catch(() => undefined);
    return unsubscribe;
  },
};
