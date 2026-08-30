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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultSettings } from '@maka/core/settings';
import { createClientSettingsEffects } from '../client-settings-effects.js';

test('applies each client settings snapshot once across local writes and file watcher echoes', async () => {
  let current = createDefaultSettings();
  const keepAwake: boolean[] = [];
  let botApplications = 0;
  let rendererEvents = 0;
  const appIcons: string[] = [];
  const effects = createClientSettingsEffects({
    settingsStore: { get: async () => current },
    applyKeepSystemAwake: async (enabled) => {
      keepAwake.push(enabled);
    },
    applyBotSettings: async () => {
      botApplications += 1;
    },
    applyAppIcon: async (icon) => {
      appIcons.push(icon);
    },
    systemPrefersDark: () => false,
    observeLocale: () => undefined,
    emitExternalChanged: () => {
      rendererEvents += 1;
    },
  });

  assert.equal(await effects.refresh(false), true);
  assert.equal(await effects.refresh(true), false);

  current = {
    ...current,
    system: { keepSystemAwake: true },
  };
  assert.equal(await effects.apply(current, true), true);
  assert.equal(await effects.refresh(true), false);

  assert.deepEqual(keepAwake, [false, true]);
  assert.equal(botApplications, 1);
  assert.equal(rendererEvents, 1);
  // The shipped default is already on screen before the first snapshot is
  // read, so a run that never leaves it must not touch the OS icon at all.
  assert.deepEqual(appIcons, []);
});

test('applies a chosen app icon once, and again only when the choice changes', async () => {
  let current = createDefaultSettings();
  const appIcons: string[] = [];
  const effects = createClientSettingsEffects({
    settingsStore: { get: async () => current },
    applyKeepSystemAwake: async () => undefined,
    applyBotSettings: async () => undefined,
    applyAppIcon: async (icon) => {
      appIcons.push(icon);
    },
    systemPrefersDark: () => false,
    observeLocale: () => undefined,
    emitExternalChanged: () => undefined,
  });

  await effects.refresh(false);
  current = { ...current, appearance: { ...current.appearance, appIcon: 'mono' } };
  assert.equal(await effects.apply(current, false), true);
  // The file watcher echoes the same write back; the OS call must not repeat.
  assert.equal(await effects.refresh(false), false);

  current = { ...current, appearance: { ...current.appearance, appIcon: 'default' } };
  assert.equal(await effects.apply(current, false), true);

  assert.deepEqual(appIcons, ['mono', 'default']);
});


test('an OS appearance flip re-applies the icon without any setting changing', async () => {
  // The whole reason `refresh` is wired to nativeTheme: nothing in the
  // settings object moves when the OS flips, so the fingerprint comparison
  // that guards every other effect would report "no change" and the dock
  // would keep the light tile.
  let systemDark = false;
  const current = createDefaultSettings();
  current.appearance.theme = 'auto';
  current.appearance.appIcon = 'sky';
  current.appearance.appIconDark = 'midnight';
  const applied: string[] = [];
  const effects = createClientSettingsEffects({
    settingsStore: { get: async () => current },
    applyKeepSystemAwake: async () => undefined,
    applyBotSettings: async () => undefined,
    applyAppIcon: async (icon) => {
      applied.push(icon);
    },
    systemPrefersDark: () => systemDark,
    observeLocale: () => undefined,
    emitExternalChanged: () => undefined,
  });

  await effects.refresh(false);
  assert.deepEqual(applied, [], 'the light tile is already up from startup');

  systemDark = true;
  assert.equal(await effects.refresh(false), true);
  assert.deepEqual(applied, ['midnight']);

  // Idempotent: a second notification for the same appearance must not cost
  // another 1024px decode.
  assert.equal(await effects.refresh(false), false);
  assert.deepEqual(applied, ['midnight']);

  systemDark = false;
  await effects.refresh(false);
  assert.deepEqual(applied, ['midnight', 'sky']);
});

test('with one icon for both appearances a theme flip changes nothing', async () => {
  let systemDark = false;
  const current = createDefaultSettings();
  current.appearance.theme = 'auto';
  current.appearance.appIcon = 'forest';
  delete current.appearance.appIconDark;
  const applied: string[] = [];
  const effects = createClientSettingsEffects({
    settingsStore: { get: async () => current },
    applyKeepSystemAwake: async () => undefined,
    applyBotSettings: async () => undefined,
    applyAppIcon: async (icon) => {
      applied.push(icon);
    },
    systemPrefersDark: () => systemDark,
    observeLocale: () => undefined,
    emitExternalChanged: () => undefined,
  });

  await effects.refresh(false);
  assert.deepEqual(applied, ['forest']);
  systemDark = true;
  assert.equal(await effects.refresh(false), false);
  assert.deepEqual(applied, ['forest'], 'no second tile was ever chosen');
});

test('an explicit dark preference ignores what the OS reports', async () => {
  const current = createDefaultSettings();
  current.appearance.theme = 'dark';
  current.appearance.appIcon = 'sky';
  current.appearance.appIconDark = 'ink';
  const applied: string[] = [];
  const effects = createClientSettingsEffects({
    settingsStore: { get: async () => current },
    applyKeepSystemAwake: async () => undefined,
    applyBotSettings: async () => undefined,
    applyAppIcon: async (icon) => {
      applied.push(icon);
    },
    systemPrefersDark: () => false,
    observeLocale: () => undefined,
    emitExternalChanged: () => undefined,
  });
  await effects.refresh(false);
  assert.deepEqual(applied, ['ink']);
});
