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

/**
 * Permission-overlay preload.
 *
 * Narrower than it looks: the card may only announce three fixed
 * intentions (the user grabbed the row, dismissed the card, or asked to
 * be shown the bundle), and may only receive two. It never passes a file
 * path — main resolves the `.app` itself, so a compromised overlay page
 * cannot talk main into dragging an arbitrary file into a TCC list.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('permissionOverlay', {
  onShow: (cb: (payload: unknown) => void): void => {
    ipcRenderer.on('permission-overlay:show', (_e, payload) => cb(payload));
  },
  onGranted: (cb: (payload: unknown) => void): void => {
    ipcRenderer.on('permission-overlay:granted', (_e, payload) => cb(payload));
  },
  /** `iconDataUrl` is only ever a drag image; the dragged file is main's. */
  startDrag: (iconDataUrl: string | null): void => {
    ipcRenderer.send('permission-overlay:start-drag', {
      iconDataUrl: typeof iconDataUrl === 'string' ? iconDataUrl : null,
    });
  },
  dismiss: (): void => {
    ipcRenderer.send('permission-overlay:dismiss');
  },
  revealBundle: (): void => {
    ipcRenderer.send('permission-overlay:reveal-bundle');
  },
});
