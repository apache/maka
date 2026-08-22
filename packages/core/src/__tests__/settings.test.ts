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

import { describe, test } from 'node:test';
import { expect } from './test-helpers.js';
import {
  createDefaultSettings,
  mergeSettings,
  normalizeSettings,
  toAppIconChoice,
} from '../settings.js';

test('normalizes user-approved subagent presets without widening the catalog', () => {
  const normalized = normalizeSettings({
    subagents: {
      presets: [
        {
          id: 'fast-reader',
          name: ' Fast reader ',
          description: ' Cheap repository scans ',
          profile: 'local_read',
          connectionSlug: 'openai-main',
          model: 'gpt-5-mini',
          thinkingLevel: 'low',
          enabled: true,
        },
        {
          id: 'fast-reader',
          name: 'duplicate',
          description: '',
          profile: 'implementation',
          connectionSlug: 'other',
          model: 'other',
          enabled: true,
        },
        {
          id: 'unsafe id',
          name: 'unsafe',
          profile: 'root',
          connectionSlug: 'other',
          model: 'other',
          enabled: true,
        },
      ],
    },
  });

  expect(normalized.subagents.presets).toEqual([
    {
      id: 'fast-reader',
      name: 'Fast reader',
      description: 'Cheap repository scans',
      profile: 'local_read',
      connectionSlug: 'openai-main',
      model: 'gpt-5-mini',
      thinkingLevel: 'low',
      enabled: true,
    },
  ]);
});

describe('custom pet selection settings', () => {
  test('fails closed for missing, unsafe, or malformed persisted selections', () => {
    for (const selectedPetId of [undefined, '../maodie', 42]) {
      const normalized = normalizeSettings({
        personalization: {
          displayName: '',
          assistantTone: '',
          uiLocale: 'auto',
          selectedPetId,
        },
      });
      expect(normalized.personalization.selectedPetId).toBe(null);
    }
  });
});

test('shell settings default, normalize, and merge through their shared boundary', () => {
  const defaults = createDefaultSettings();
  expect(defaults.shell).toEqual({ preference: 'auto', executable: '' });

  expect(
    normalizeSettings({
      shell: { preference: 'git_bash', executable: ' C:\\Program Files\\Git\\bin\\bash.exe ' },
    }).shell,
  ).toEqual({
    preference: 'git_bash',
    executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
  });
  expect(normalizeSettings({ shell: { preference: 'fish', executable: 42 } }).shell).toEqual({
    preference: 'auto',
    executable: '',
  });
  expect(
    mergeSettings(defaults, {
      shell: { preference: 'git_bash', executable: 'C:\\Git\\bin\\bash.exe' },
    }).shell,
  ).toEqual({ preference: 'git_bash', executable: 'C:\\Git\\bin\\bash.exe' });
});

test('a chat-default thinking level the app does not recognize drops to no preference', () => {
  const normalized = normalizeSettings({
    chatDefaults: { thinkingLevel: 'ultra' as unknown as undefined },
  });
  expect(normalized.chatDefaults.thinkingLevel).toBe(undefined);
});

test('an app icon the build does not ship falls back without disturbing the theme', () => {
  expect(createDefaultSettings().appearance.appIcon).toBe('default');

  for (const appIcon of [undefined, 'holiday-2019', 42, null]) {
    const normalized = normalizeSettings({
      appearance: { theme: 'dark', palette: 'nord', appIcon } as never,
    });
    expect(normalized.appearance.appIcon).toBe('default');
    // The fallback is scoped to the field that failed the guard: a stray icon
    // id must not silently reset the theme the user is actually looking at.
    expect(normalized.appearance.theme).toBe('dark');
    expect(normalized.appearance.palette).toBe('nord');
  }

  expect(
    normalizeSettings({ appearance: { theme: 'auto', appIcon: 'mono' } }).appearance.appIcon,
  ).toBe('mono');
});

test('imported app icons normalize by id shape, never by path', () => {
  const custom = `custom:${'a'.repeat(32)}`;
  expect(
    normalizeSettings({ appearance: { theme: 'auto', appIcon: custom } }).appearance.appIcon,
  ).toBe(custom);
  // Anything that is not a shipped id or a well-formed reference falls back to
  // the brand mark: the main process turns this value into a file path, so a
  // hand-edited settings file must not be able to name one.
  for (const bad of ['custom:../../etc/passwd', 'custom:', 'custom:zzzz', '/tmp/evil.png']) {
    expect(
      normalizeSettings({ appearance: { theme: 'auto', appIcon: bad } }).appearance.appIcon,
    ).toBe('default');
  }
});

test('an app icon that never passed normalization still coerces to the brand mark', () => {
  // `SettingsStore.update` merges and writes without normalizing, so the
  // object the main process acts on can carry anything a patch put there. The
  // main process turns that value into a file path.
  for (const escape of [
    '../../../../tmp/owned',
    'custom:../../etc/passwd',
    'assets/app-icons/../../../etc/passwd',
    '',
    42,
    null,
    undefined,
  ]) {
    expect(toAppIconChoice(escape)).toBe('default');
  }
  expect(toAppIconChoice('sky')).toBe('sky');
  expect(toAppIconChoice(`custom:${'a'.repeat(32)}`)).toBe(`custom:${'a'.repeat(32)}`);
});
