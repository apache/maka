import { useState, type Dispatch, type SetStateAction } from 'react';
import type { ChatDefaultPermissionMode, ThemePalette, ThemePreference } from '@maka/core/settings';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { UiLocale, UiLocalePreference } from '@maka/core/ui-locale';
import { createUiLocaleUpdateGate } from './settings/ui-locale-update-gate';
import { applyTheme, applyThemePalette } from './theme';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy';

type ToastApi = {
  error(title: string, description?: string): void;
};

/**
 * Owns the appearance / personalization / default-permission-mode slice
 * (issue #1043): the theme + palette + UI-locale + user-label + default
 * permission mode state, plus the `refreshShellSettings` IPC pull that
 * hydrates them from `window.maka.settings` / `e2eFixture` on mount and on
 * close-settings re-reads.
 *
 * `closeSettings` stays in AppShell: on close it calls `refreshShellSettings()`
 * so display mirrors (default permission mode) catch up without an app restart.
 * The full settings hydration lives here.
 */
export function useShellAppearance({
  toastApi,
  uiLocale,
  setUiLocaleOverride,
  setUiLocalePreference,
}: {
  toastApi: ToastApi;
  uiLocale: UiLocale;
  setUiLocaleOverride: Dispatch<SetStateAction<UiLocale | null>>;
  setUiLocalePreference: Dispatch<SetStateAction<UiLocalePreference>>;
}) {
  const [themePref, setThemePref] = useState<ThemePreference>('auto');
  const [themePalette, setThemePalette] = useState<ThemePalette>('default');
  const [uiLocaleUpdateGate] = useState(createUiLocaleUpdateGate);
  const [userLabel, setUserLabel] = useState<string>('');
  // Settings -> 通用 -> 默认权限模式 - DISPLAY-ONLY mirror. The composer's
  // picker shows it before the user makes a per-session choice; the actual
  // authority for a new session's mode is main.ts's sessions:create fallback
  // (the renderer omits permissionMode unless the user explicitly picked),
  // so a stale value here can briefly mislabel the chip but never changes
  // which mode a session is created with.
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<ChatDefaultPermissionMode>('ask');
  // undefined = the user expressed no preference, so each model uses its own.
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState<ThinkingLevel | undefined>(undefined);

  async function refreshShellSettings() {
    const uiLocaleHydration = uiLocaleUpdateGate.beginHydration();
    try {
      const next = await window.maka.settings.get();
      const fixtureState = await window.maka.e2eFixture.getState();
      const pref = fixtureState?.theme ?? next.appearance?.theme ?? 'auto';
      const palette = next.appearance?.palette ?? 'default';
      const name = next.personalization?.displayName ?? '';
      const uiLocale = next.personalization?.uiLocale ?? 'auto';
      setUiLocaleOverride(fixtureState?.locale ?? null);
      uiLocaleUpdateGate.commitHydration(
        uiLocaleHydration,
        uiLocale,
        (preference) => setUiLocalePreference(preference),
      );
      setThemePref(pref);
      setThemePalette(palette);
      setUserLabel(name);
      setDefaultPermissionMode(next.chatDefaults?.permissionMode ?? 'ask');
      setDefaultThinkingLevel(next.chatDefaults?.thinkingLevel);
      applyTheme(pref);
      applyThemePalette(palette);
    } catch (error) {
      const copy = getShellCopy(uiLocale).app;
      toastApi.error(
        copy.appearanceLoadErrorTitle,
        localizedShellErrorMessage(error, copy.appearanceLoadErrorFallback, uiLocale),
      );
    }
  }

  return {
    themePref,
    setThemePref,
    themePalette,
    setThemePalette,
    uiLocaleUpdateGate,
    userLabel,
    setUserLabel,
    defaultPermissionMode,
    defaultThinkingLevel,
    setDefaultPermissionMode,
    refreshShellSettings,
  };
}
