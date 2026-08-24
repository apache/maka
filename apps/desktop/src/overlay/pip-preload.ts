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

// PiP preload. Frames and the cursor come down; pointer and controls go up.
//
// It was receive-only before this, because the mirror did nothing. Now it is
// draggable and carries two controls, and the page is the only thing that can
// see the pointer: the window is click-through with `forward: true`, so moves
// reach the page while clicks pass through to whatever is underneath, and the
// page is what tells main when to take the clicks back.
import { contextBridge, ipcRenderer } from 'electron';

// An allow-list rather than a pass-through. The bridge is the boundary, and a
// boundary that forwards whatever channel name it is handed is not one.
const SEND_CHANNELS = new Set([
  'pip:pointer-down',
  'pip:pointer-move',
  'pip:pointer-up',
  'pip:control',
  'pip:resize-begin',
  'pip:resize-move',
  'pip:resize-end',
]);

contextBridge.exposeInMainWorld('computerUsePip', {
  onFrame: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('pip:frame', (_e, payload) => cb(payload));
  },
  onCursor: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('pip:cursor', (_e, payload) => cb(payload));
  },
  onControls: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('pip:controls', (_e, payload) => cb(payload));
  },
  onLayout: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('pip:layout', (_e, payload) => cb(payload));
  },
  onCompleted: (cb: () => void): void => {
    ipcRenderer.on('pip:completed', () => cb());
  },
  send: (channel: string, payload?: unknown): void => {
    if (!SEND_CHANNELS.has(channel)) return;
    ipcRenderer.send(channel, payload);
  },
});
