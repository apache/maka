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

// Overlay preload. Main owns all coordinates and actions. Renderer may send only
// a fixed presentation-phase acknowledgement keyed by the action id.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cursorOverlay', {
  onMove: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:move', (_e, payload) => cb(payload));
  },
  onReset: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:reset', (_e, payload) => cb(payload));
  },
  onComplete: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:complete', (_e, payload) => cb(payload));
  },
  onCancel: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:cancel', (_e, payload) => cb(payload));
  },
  reportPresentationPhase: (
    sessionId: string,
    generation: number,
    actionId: string,
    phase: 'readyForInteraction' | 'finished',
  ): void => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (!Number.isInteger(generation) || generation < 1) return;
    if (typeof actionId !== 'string' || actionId.length === 0) return;
    if (phase !== 'readyForInteraction' && phase !== 'finished') return;
    ipcRenderer.send('overlay:presentation-phase', {
      sessionId,
      generation,
      actionId,
      phase,
    });
  },
});
