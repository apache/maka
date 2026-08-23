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

import type { AppSettings } from '@maka/core/settings';
import type { SettingsStore } from '@maka/storage';

export interface ClientSettingsEffects {
  apply(settings: AppSettings, notifyRenderer: boolean): Promise<boolean>;
  refresh(notifyRenderer: boolean): Promise<boolean>;
}

interface ClientSettingsEffectDependencies {
  readonly settingsStore: Pick<SettingsStore, 'get'>;
  readonly applyKeepSystemAwake: (enabled: boolean) => Promise<void>;
  readonly applyBotSettings: (settings: AppSettings['botChat']) => Promise<void>;
  readonly observeLocale: (settings: AppSettings) => void;
  readonly emitExternalChanged: () => void;
}

export function createClientSettingsEffects(
  dependencies: ClientSettingsEffectDependencies,
): ClientSettingsEffects {
  let rendererFingerprint: string | undefined;
  let botFingerprint: string | undefined;
  let keepSystemAwake: boolean | undefined;
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
      dependencies.observeLocale(settings);
      if (keepAwakeChanged) {
        await dependencies.applyKeepSystemAwake(settings.system.keepSystemAwake);
        keepSystemAwake = settings.system.keepSystemAwake;
      }
      if (botChanged) {
        await dependencies.applyBotSettings(settings.botChat);
        botFingerprint = nextBotFingerprint;
      }
      rendererFingerprint = nextRendererFingerprint;
      if (notifyRenderer && rendererChanged) dependencies.emitExternalChanged();
      return rendererChanged || keepAwakeChanged || botChanged;
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
