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

import type { BrowserWindow, WebContents } from 'electron';
import type { WorkspaceWindowController } from './main-window.js';

export interface WorkspaceWindowEntry {
  readonly window: BrowserWindow;
  readonly controller: WorkspaceWindowController;
  readonly context: { readonly kind: 'main' | 'session'; readonly windowId: string };
}

/** Only trusted workspace surfaces participate; auxiliary windows remain separate. */
export function createWorkspaceWindowRegistry() {
  const windows = new Map<string, WorkspaceWindowEntry>();
  let lastFocusedId: string | undefined;
  return {
    register(entry: WorkspaceWindowEntry): void {
      if (entry.window.isDestroyed()) throw new Error('Cannot register a destroyed workspace window');
      if (entry.context.kind === 'main' && [...windows.values()].some((item) => item.context.kind === 'main')) {
        throw new Error('The main workspace window already exists');
      }
      windows.set(entry.context.windowId, entry);
      entry.window.on('focus', () => { lastFocusedId = entry.context.windowId; });
      entry.window.once('closed', () => {
        windows.delete(entry.context.windowId);
        if (lastFocusedId === entry.context.windowId) lastFocusedId = undefined;
      });
    },
    entries(): WorkspaceWindowEntry[] {
      return [...windows.values()].filter((entry) => !entry.window.isDestroyed());
    },
    forSender(sender: WebContents): WorkspaceWindowEntry | undefined {
      if (sender.isDestroyed()) return undefined;
      return this.entries().find((entry) => entry.window.webContents === sender);
    },
    get(windowId: string): WorkspaceWindowEntry | undefined {
      const entry = windows.get(windowId);
      return entry && !entry.window.isDestroyed() ? entry : undefined;
    },
    main(): WorkspaceWindowEntry | undefined {
      return this.entries().find((entry) => entry.context.kind === 'main');
    },
    focused(): WorkspaceWindowEntry | undefined {
      return this.entries().find((entry) => entry.window.isFocused());
    },
    active(): WorkspaceWindowEntry | undefined {
      return this.focused() ?? (lastFocusedId === undefined ? undefined : this.get(lastFocusedId)) ?? this.main();
    },
    sendCommand(channel: string, ...args: unknown[]): boolean {
      const target = this.active();
      if (!target || target.window.webContents.isDestroyed()) return false;
      target.window.webContents.send(channel, ...args);
      return true;
    },
  };
}

export const workspaceWindowRegistry = createWorkspaceWindowRegistry();
