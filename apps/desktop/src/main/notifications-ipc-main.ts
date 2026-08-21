import { ipcMain, Notification } from 'electron';
import type { AppSettings } from '@maka/core/settings';
import type { createMainWindowController } from './main-window.js';
import type { DesktopLocaleAuthority } from './desktop-locale-authority.js';
import {
  isRunNotificationKind,
  resolveNotificationContent,
  shouldRaiseRunNotification,
  type RunNotificationInput,
} from './notifications-policy.js';

type MainWindowController = ReturnType<typeof createMainWindowController>;

export interface NotificationsIpcDeps {
  ipcMain?: Pick<typeof ipcMain, 'handle'>;
  settingsStore: { get(): Promise<AppSettings> };
  locale: Pick<DesktopLocaleAuthority, 'observe'>;
  mainWindowController: MainWindowController;
  e2e: boolean;
}

export type RunNotifier = (input: RunNotificationInput) => Promise<void>;

/** Shared notification authority used by both ordinary Sessions and WorkHub. */
export function createRunNotifier(deps: NotificationsIpcDeps): RunNotifier {
  return async (input) => {
    const supported = Notification.isSupported();
    const settings = await deps.settingsStore.get();
    const gate = {
      enabled: settings.notifications.runComplete,
      supported,
      windowFocused: deps.mainWindowController.isFocused(),
      incognito: settings.privacy.incognitoActive,
      e2e: deps.e2e,
    };
    if (!shouldRaiseRunNotification(gate)) return;

    const copy = resolveNotificationContent(input, deps.locale.observe(settings));
    const notification = new Notification({ title: copy.title, body: copy.body });
    notification.on('click', () => deps.mainWindowController.focus());
    notification.show();
  };
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
export function registerNotificationsIpc(
  deps: NotificationsIpcDeps,
  notify: RunNotifier = createRunNotifier(deps),
): void {
  const target = deps.ipcMain ?? ipcMain;
  target.handle('notifications:runEnded', async (_event, payload: unknown): Promise<void> => {
    const raw = (payload ?? {}) as { kind?: unknown; title?: unknown; body?: unknown };
    if (!isRunNotificationKind(raw.kind)) return;
    await notify({ kind: raw.kind, title: raw.title, body: raw.body });
  });
}
