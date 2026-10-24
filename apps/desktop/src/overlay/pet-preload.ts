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

import { contextBridge, ipcRenderer } from "electron";
import type {
  PetDesktopState,
  PetPublication,
} from "../renderer/application/contracts/pet-desktop.js";
contextBridge.exposeInMainWorld("pet", {
  action: (action: string) => {
    if (
      [
        "ready",
        "drag-end",
        "toggle",
        "open",
        "compose-close",
        "interactive",
        "passthrough",
      ].includes(action)
    )
      ipcRenderer.send("pet-desktop:action", action);
  },
  layout: (height: number, petTop: number, below: boolean) => ipcRenderer.send('pet-desktop:layout', {height, petTop, below}),
  placement: (handler: (below: boolean) => void) => ipcRenderer.on('pet-desktop:placement', (_event, below) => handler(below)),
  move: (dx: number, dy: number) => ipcRenderer.send('pet-desktop:move', {dx,dy}),
  composeOpen: (): Promise<void> => ipcRenderer.invoke("pet-desktop:compose-open"),
  composeFocus: (handler: () => void) => ipcRenderer.on("pet-desktop:compose-focus", handler),
  chatTarget: (): Promise<string> => ipcRenderer.invoke("pet-desktop:chat-target"),
  send: (input: {target: string; id: string; text: string}): Promise<void> => ipcRenderer.invoke("pet-desktop:chat-send", input),
  state: (handler: (state: PetDesktopState) => void) =>
    ipcRenderer.on("pet-desktop:state", (_event, value) => handler(value)),
  messages: (
    handler: (batch: Extract<PetPublication, { kind: "messages" }>) => void,
  ) =>
    ipcRenderer.on("pet-desktop:messages", (_event, value) => handler(value)),
});
