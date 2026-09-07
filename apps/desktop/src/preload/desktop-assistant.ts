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
import type { DesktopAssistantBridge, DesktopAssistantSnapshot } from '../shared/desktop-assistant.js';

const command = (name: string, payload?: unknown) => ipcRenderer.invoke('desktop-assistant:command', name, payload);
export const desktopAssistantBridge: DesktopAssistantBridge = {
  getSnapshot: () => command('snapshot'),
  open: () => command('open'),
  close: () => command('close'),
  expand: () => command('expand'),
  submit: (text) => command('submit', text),
  selectModel: (connectionId, model) => command('model', { connectionId, model }),
  stop: () => command('stop'),
  undo: () => command('undo'),
  subscribe: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: DesktopAssistantSnapshot) => handler(snapshot);
    ipcRenderer.on('desktop-assistant:changed', listener);
    return () => ipcRenderer.removeListener('desktop-assistant:changed', listener);
  },
};
