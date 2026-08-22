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
 * permission mode state, plus the `refreshShellSettings` IPC pull. Desktop
 * appearance and locale are hydrated independently from the default Host's
 * chat defaults, so an offline Host cannot block the local UI preferences.
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
    const runtimeHostHydration = window.maka.settings.get().then(
      (settings) => ({ ok: true as const, settings }),
      () => ({ ok: false as const }),
    );
    const [clientResult, fixtureState] = await Promise.all([
      window.maka.settings.getClient().then(
        (settings) => ({ ok: true as const, settings }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      window.maka.e2eFixture.getState().catch(() => null),
    ]);

    if (clientResult.ok) {
      const next = clientResult.settings;
      const pref = fixtureState?.theme ?? next.appearance.theme ?? 'auto';
      const palette = next.appearance.palette ?? 'default';
      const localePreference = next.personalization.uiLocale ?? 'auto';
      setUiLocaleOverride(fixtureState?.locale ?? null);
      uiLocaleUpdateGate.commitHydration(
        uiLocaleHydration,
        localePreference,
        (preference) => setUiLocalePreference(preference),
      );
      setThemePref(pref);
      setThemePalette(palette);
      applyTheme(pref);
      applyThemePalette(palette);
    } else {
      const copy = getShellCopy(uiLocale).app;
      toastApi.error(
        copy.appearanceLoadErrorTitle,
        localizedShellErrorMessage(
          clientResult.error,
          copy.appearanceLoadErrorFallback,
          uiLocale,
        ),
      );
    }

    const runtimeHostResult = await runtimeHostHydration;
    if (runtimeHostResult.ok) {
      const next = runtimeHostResult.settings;
      setUserLabel(next.personalization.displayName ?? '');
      setDefaultPermissionMode(next.chatDefaults.permissionMode ?? 'ask');
      setDefaultThinkingLevel(next.chatDefaults.thinkingLevel);
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
