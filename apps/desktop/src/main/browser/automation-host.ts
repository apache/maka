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

import type { BrowserViewHost } from './browser-host.js';
import type { BrowserViewController } from './controller.js';
import { browserActionAllowed } from './logic.js';
import type { BrowserViewManager } from './view-manager.js';

/**
 * The desktop's implementation of the BrowserViewHost seam (browser-host.ts):
 * with views owned by conversations, session → endpoint resolution is the
 * identity mapping — ensure the conversation's view and attach the CDP bridge to
 * it. An action always lands in its OWN session's view, but that view may be
 * hidden (the user switched conversations), so canDrive enforces the visible
 * lease: read/navigate/mutate only on the session currently on screen. The
 * endpoint and its secret stay same-process values, never crossing renderer IPC
 * or preload.
 *
 * `shownSessionId` reads main's live record of the conversation the window shows
 * (browser:active-session). Call
 * provideBrowserViewHost(createBrowserViewHost(manager, () => shownBrowserSessionId))
 * once in main.ts.
 */
// Ceiling on how long a mutate waits for the renderer to restore the strip
// viewport after a permission modal closes. The restore is normally sub-100ms;
// this is the safety net before the action is declared genuinely undrivable.
const VIEWPORT_RESTORE_WAIT_MS = 1000;

export function createBrowserViewHost(
  manager: BrowserViewManager<BrowserViewController>,
  shownSessionId: () => string | null,
): BrowserViewHost {
  return {
    canDrive(sessionId, kind, opts) {
      const shown = sessionId === shownSessionId();
      const controller = manager.get(sessionId);
      if (browserActionAllowed(kind, { shown, hasViewport: controller?.hasLiveViewport() ?? false })) {
        return true;
      }
      // The one recoverable miss: a mutate on the conversation that IS on screen
      // but whose viewport is briefly gone because a permission modal just closed
      // (it hid the native view) and the renderer has not re-reported the strip
      // yet. Wait for that restore, then re-check, so the first approved
      // click/type lands without a retry. A backgrounded conversation (!shown) is
      // never drivable — reject it immediately, no wait.
      if (kind === 'mutate' && shown && controller) {
        return controller
          .waitForLiveViewport(VIEWPORT_RESTORE_WAIT_MS, opts?.signal)
          .then(() =>
            browserActionAllowed('mutate', {
              shown: sessionId === shownSessionId(),
              hasViewport: controller.hasLiveViewport(),
            }),
          );
      }
      return false;
    },
    async resolveEndpoint(sessionId) {
      return manager.getOrCreate(sessionId).attachAutomation();
    },
    async releaseSession(sessionId) {
      await manager.get(sessionId)?.detachAutomation();
    },
    // The conversation was deleted or archived: its view dies with it (page,
    // history, automation, the WebContentsView itself).
    async disposeSession(sessionId) {
      await manager.dispose(sessionId);
    },
  };
}
