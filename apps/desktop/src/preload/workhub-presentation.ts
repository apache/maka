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
import type { WorkHubPresentationBridge } from '../shared/workhub-presentation.js';

function subscribe<T>(channel: string, handler: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

export const workHubPresentationBridge: WorkHubPresentationBridge = {
  ready: () => ipcRenderer.invoke('workhub-presentation:command', 'ready'),
  getSnapshot: () => ipcRenderer.invoke('workhub-presentation:command', 'snapshot'),
  setHost: (host) => ipcRenderer.invoke('workhub-presentation:command', 'host', host),
  setConversationLayout: (layout) => ipcRenderer.invoke('workhub-presentation:command', 'conversation-layout', layout),
  detach: () => ipcRenderer.invoke('workhub-presentation:command', 'detach'),
  dock: () => ipcRenderer.invoke('workhub-presentation:command', 'dock'),
  hide: () => ipcRenderer.invoke('workhub-presentation:command', 'hide'),
  openSession: (sessionKey) => ipcRenderer.invoke('workhub-presentation:command', 'session', sessionKey),
  subscribe: (handler) => subscribe('workhub-presentation:changed', handler),
  onFocusComposer: (handler) => subscribe('workhub-presentation:focus-composer', handler),
  onOpenMain: (handler) => {
    const unsubscribe = subscribe('workhub-presentation:open-main', handler);
    void ipcRenderer.invoke('workhub-presentation:command', 'ready').catch(() => undefined);
    return unsubscribe;
  },
};
