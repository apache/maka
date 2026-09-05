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

import { ipcMain, Notification } from 'electron';
import type { AppSettings } from '@maka/core/settings';
import type { createMainWindowController } from './main-window.js';
import type { DesktopLocaleAuthority } from './desktop-locale-authority.js';
import {
  isRunNotificationKind,
  resolveNotificationContent,
  shouldRaiseRunNotification,
} from './notifications-policy.js';

type MainWindowController = ReturnType<typeof createMainWindowController>;

interface NotificationsIpcDeps {
  ipcMain?: Pick<typeof ipcMain, 'handle'>;
  settingsStore: { get(): Promise<AppSettings> };
  locale: Pick<DesktopLocaleAuthority, 'observe'>;
  mainWindowController: MainWindowController;
  e2e: boolean;
}

/**
 * Wires the renderer's "a turn just ended" signal to a native OS
 * notification. The renderer fires on every terminal turn event; the
 * gating (product toggle + platform support + window-focus) lives here
 * in the main process, which is the only place that authoritatively
 * knows whether the window is focused and can raise/focus it on click.
 *
 * Fire-and-forget from the renderer's perspective: it does not await the
 * result, so we resolve `void` and never surface main-side failures to
 * the chat UI — a missed banner must never break a completed turn.
 */
export function registerNotificationsIpc(deps: NotificationsIpcDeps): void {
  const target = deps.ipcMain ?? ipcMain;
  target.handle('notifications:runEnded', async (_event, payload: unknown): Promise<void> => {
    const raw = (payload ?? {}) as { kind?: unknown; title?: unknown; body?: unknown };
    if (!isRunNotificationKind(raw.kind)) return;

    const supported = Notification.isSupported();
    // Read the toggle lazily so a mid-session settings change takes
    // effect on the very next turn without any cache invalidation.
    const settings = await deps.settingsStore.get();
    const gate = {
      enabled: settings.notifications.runComplete,
      supported,
      windowFocused: deps.mainWindowController.isFocused(),
      incognito: settings.privacy.incognitoActive,
      e2e: deps.e2e,
    };
    if (!shouldRaiseRunNotification(gate)) return;

    // Prefer the renderer's session name + reply preview; policy applies
    // per-field fallbacks + sanitization for blank/oversize/non-strings.
    const copy = resolveNotificationContent(
      { kind: raw.kind, title: raw.title, body: raw.body },
      deps.locale.observe(settings),
    );
    const notification = new Notification({ title: copy.title, body: copy.body });
    // Clicking the banner should pull the (unfocused/minimized) window
    // back to the foreground — `focus()` already restores + shows.
    notification.on('click', () => deps.mainWindowController.focus());
    notification.show();
  });
}
