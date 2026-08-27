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
import {
  appIconForTheme,
  startupAppIcon,
  type AppIconChoice,
  type AppSettings,
} from '@maka/core/settings';
import { isDarkAppearance } from './theme-source.js';
import type { SettingsStore } from '@maka/storage/settings-store';

export interface ClientSettingsEffects {
  apply(settings: AppSettings, notifyRenderer: boolean): Promise<boolean>;
  refresh(notifyRenderer: boolean): Promise<boolean>;
}

interface ClientSettingsEffectDependencies {
  readonly settingsStore: Pick<SettingsStore, 'get'>;
  readonly applyKeepSystemAwake: (enabled: boolean) => Promise<void>;
  readonly applyBotSettings: (settings: AppSettings['botChat']) => Promise<void>;
  readonly applyAppIcon: (icon: AppIconChoice) => Promise<void>;
  /**
   * What the OS currently reports, read fresh on every pass. Injected
   * rather than imported so this module stays free of electron and keeps
   * its unit tests runnable outside a desktop session.
   */
  readonly systemPrefersDark: () => boolean;
  readonly observeLocale: (settings: AppSettings) => void;
  readonly emitExternalChanged: () => void;
}

export function createClientSettingsEffects(
  dependencies: ClientSettingsEffectDependencies,
): ClientSettingsEffects {
  let rendererFingerprint: string | undefined;
  let botFingerprint: string | undefined;
  let keepSystemAwake: boolean | undefined;
  // Seeded rather than left undefined: the startup path has already put an
  // icon on the dock synchronously, so treating it as unapplied would cost a
  // 1024px PNG decode on every launch. Seeded lazily because the value depends
  // on the OS appearance, which is read fresh rather than captured here.
  let appIcon: AppIconChoice | undefined;
  let tail = Promise.resolve();

  const schedule = (
    load: () => AppSettings | Promise<AppSettings>,
    notifyRenderer: boolean,
  ): Promise<boolean> => {
    const run = tail.then(async () => {
      const settings = await load();
      const nextRendererFingerprint = JSON.stringify(settings);
      const nextBotFingerprint = JSON.stringify(settings.botChat);
      const rendererChanged = nextRendererFingerprint !== rendererFingerprint;
      const keepAwakeChanged = settings.system.keepSystemAwake !== keepSystemAwake;
      const botChanged = nextBotFingerprint !== botFingerprint;
      // Normalized settings always carry an id; the fallback covers a
      // snapshot handed straight to apply() by a caller that built it from a
      // partial patch rather than from a store read.
      // Same reason as `appIconPath`: this snapshot did not come through
      // `normalizeSettings`, so the value is untrusted until coerced.
      // Resolved against the current appearance, so this also re-runs when the
      // OS flips light/dark under an `auto` preference — the settings object
      // is unchanged then, and the icon is the only thing that moves.
      const systemPrefersDark = dependencies.systemPrefersDark();
      appIcon ??= startupAppIcon(systemPrefersDark);
      const nextAppIcon = appIconForTheme(
        settings.appearance,
        isDarkAppearance(settings.appearance.theme, systemPrefersDark),
      );
      const appIconChanged = nextAppIcon !== appIcon;
      dependencies.observeLocale(settings);
      if (keepAwakeChanged) {
        await dependencies.applyKeepSystemAwake(settings.system.keepSystemAwake);
        keepSystemAwake = settings.system.keepSystemAwake;
      }
      if (botChanged) {
        await dependencies.applyBotSettings(settings.botChat);
        botFingerprint = nextBotFingerprint;
      }
      if (appIconChanged) {
        await dependencies.applyAppIcon(nextAppIcon);
        appIcon = nextAppIcon;
      }
      rendererFingerprint = nextRendererFingerprint;
      if (notifyRenderer && rendererChanged) dependencies.emitExternalChanged();
      return rendererChanged || keepAwakeChanged || botChanged || appIconChanged;
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    apply: (settings, notifyRenderer) => schedule(() => settings, notifyRenderer),
    refresh: (notifyRenderer) => schedule(() => dependencies.settingsStore.get(), notifyRenderer),
  };
}
