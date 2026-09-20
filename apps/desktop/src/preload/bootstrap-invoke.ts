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

// Handlers registered before the renderer starts loading (early-window.ts and
// main.ts); calls to them must never wait on the boot gate.
const EARLY_CHANNELS = new Set([
  'app:bootstrapReady',
  'window:notifyRendererReady',
  'diagnostics:takePreviousMainProcessInterruption',
  'diagnostics:copyPreviousMainProcessInterruption',
]);

// The renderer mounts while the Runtime Host module graph is still
// evaluating, so persistent IPC handlers do not exist yet. Holding invokes on
// this promise turns "called before registration" into "waits for
// registration" instead of "No handler registered". If the gate channel
// itself is missing or startup dies, calls fall through to the real handler
// state — the gate can only delay, never alter, a call's outcome.
const bootReady: Promise<void> = Promise.resolve(
  ipcRenderer.invoke('app:bootstrapReady'),
).then(
  () => undefined,
  () => undefined,
);

export const invokeWhenReady: typeof ipcRenderer.invoke = (channel, ...args) =>
  EARLY_CHANNELS.has(channel)
    ? ipcRenderer.invoke(channel, ...args)
    : bootReady.then(() => ipcRenderer.invoke(channel, ...args));

// Sends fired during preload evaluation would be dropped before the matching
// ipcMain.on listener is registered; deferring them to the same gate keeps
// fire-and-forget semantics once a listener exists.
export const sendWhenReady: typeof ipcRenderer.send = (channel, ...args) => {
  if (EARLY_CHANNELS.has(channel)) {
    ipcRenderer.send(channel, ...args);
    return;
  }
  void bootReady.then(() => ipcRenderer.send(channel, ...args));
};
