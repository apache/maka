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
import { describe, test } from 'node:test';
import {
  appIconForTheme,
  createDefaultSettings,
  DEFAULT_APP_ICON,
  DEFAULT_APP_ICON_DARK,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  mergeSettings,
  normalizeSettings,
  startupAppIcon,
  TERMINAL_FONT_SIZE_MAX,
  toAppIconChoice,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
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

  assert.deepStrictEqual(normalized.subagents.presets, [
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
      assert.strictEqual(normalized.personalization.selectedPetId, null);
    }
  });
});

describe('UI locale preferences', () => {
  test('preserves every supported preference and migrates the former generic zh value', () => {
    for (const uiLocale of ['auto', 'zh-CN', 'zh-TW', 'en'] as const) {
      const normalized = normalizeSettings({
        personalization: {
          displayName: '',
          assistantTone: '',
          uiLocale,
          selectedPetId: null,
        },
      });
      assert.strictEqual(normalized.personalization.uiLocale, uiLocale);
    }

    const normalizedLegacy = normalizeSettings({
      personalization: {
        displayName: '',
        assistantTone: '',
        uiLocale: 'zh',
        selectedPetId: null,
      },
    });
    assert.strictEqual(normalizedLegacy.personalization.uiLocale, 'zh-CN');
  });
});

test('shell settings default, normalize, and merge through their shared boundary', () => {
  const defaults = createDefaultSettings();
  assert.deepStrictEqual(defaults.shell, { preference: 'auto', executable: '' });

  assert.deepStrictEqual(
    normalizeSettings({
      shell: { preference: 'git_bash', executable: ' C:\\Program Files\\Git\\bin\\bash.exe ' },
    }).shell,
    {
      preference: 'git_bash',
      executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
    },
  );
  assert.deepStrictEqual(
    normalizeSettings({ shell: { preference: 'fish', executable: 42 } }).shell,
    {
      preference: 'auto',
      executable: '',
    },
  );
  assert.deepStrictEqual(
    mergeSettings(defaults, {
      shell: { preference: 'git_bash', executable: 'C:\\Git\\bin\\bash.exe' },
    }).shell,
    { preference: 'git_bash', executable: 'C:\\Git\\bin\\bash.exe' },
  );
});

test('a chat-default thinking level the app does not recognize drops to no preference', () => {
  const normalized = normalizeSettings({
    chatDefaults: { thinkingLevel: 'ultra' as unknown as undefined },
  });
  assert.strictEqual(normalized.chatDefaults.thinkingLevel, undefined);
});

test('an app icon the build does not ship falls back without disturbing the theme', () => {
  // The fallback is the shipped default, which is no longer the id literally
  // named `default` — that id is now one selectable icon among many (the
  // original mascot mark), while the default a fresh install gets is a
  // separate decision. Asserted through the constant so changing the default
  // again does not mean editing this test.
  assert.strictEqual(createDefaultSettings().appearance.appIcon, DEFAULT_APP_ICON);

  for (const appIcon of [undefined, 'holiday-2019', 42, null]) {
    const normalized = normalizeSettings({
      appearance: { theme: 'dark', palette: 'nord', appIcon } as never,
    });
    assert.strictEqual(normalized.appearance.appIcon, DEFAULT_APP_ICON);
    // The fallback is scoped to the field that failed the guard: a stray icon
    // id must not silently reset the theme the user is actually looking at.
    assert.strictEqual(normalized.appearance.theme, 'dark');
    assert.strictEqual(normalized.appearance.palette, 'nord');
  }

  assert.strictEqual(
    normalizeSettings({ appearance: { theme: 'auto', appIcon: 'mono' } }).appearance.appIcon,
    'mono',
  );
});

test('font-size appearance defaults, with wrong types failing closed and out-of-range clamped', () => {
  assert.strictEqual(createDefaultSettings().appearance.uiFontSize, DEFAULT_UI_FONT_SIZE);
  assert.strictEqual(
    createDefaultSettings().appearance.terminalFontSize,
    DEFAULT_TERMINAL_FONT_SIZE,
  );

  // A wrong-typed value must not reach the renderer as an arbitrary root /
  // xterm size — it drops to the default, and, like the app-icon guard above,
  // does not disturb the theme.
  for (const bad of [undefined, '14', null, Number.NaN, {}]) {
    const normalized = normalizeSettings({
      appearance: { theme: 'dark', uiFontSize: bad, terminalFontSize: bad } as never,
    });
    assert.strictEqual(normalized.appearance.uiFontSize, DEFAULT_UI_FONT_SIZE);
    assert.strictEqual(normalized.appearance.terminalFontSize, DEFAULT_TERMINAL_FONT_SIZE);
    assert.strictEqual(normalized.appearance.theme, 'dark');
  }

  // Out-of-range numbers clamp to the nearest bound rather than resetting, so a
  // large persisted value is honored up to the cap instead of snapping back.
  assert.strictEqual(
    normalizeSettings({ appearance: { theme: 'auto', uiFontSize: 999 } as never }).appearance
      .uiFontSize,
    UI_FONT_SIZE_MAX,
  );
  assert.strictEqual(
    normalizeSettings({ appearance: { theme: 'auto', uiFontSize: 1 } as never }).appearance
      .uiFontSize,
    UI_FONT_SIZE_MIN,
  );
  assert.strictEqual(
    normalizeSettings({ appearance: { theme: 'auto', terminalFontSize: 999 } as never }).appearance
      .terminalFontSize,
    TERMINAL_FONT_SIZE_MAX,
  );

  // A value in range survives, rounded to an integer px.
  const kept = normalizeSettings({
    appearance: { theme: 'auto', uiFontSize: 16, terminalFontSize: 15 } as never,
  });
  assert.strictEqual(kept.appearance.uiFontSize, 16);
  assert.strictEqual(kept.appearance.terminalFontSize, 15);
});

test('imported app icons normalize by id shape, never by path', () => {
  const custom = `custom:${'a'.repeat(32)}`;
  assert.strictEqual(
    normalizeSettings({ appearance: { theme: 'auto', appIcon: custom } }).appearance.appIcon,
    custom,
  );
  // Anything that is not a shipped id or a well-formed reference falls back to
  // the shipped default: the main process turns this value into a file path,
  // so a hand-edited settings file must not be able to name one.
  for (const bad of ['custom:../../etc/passwd', 'custom:', 'custom:zzzz', '/tmp/evil.png']) {
    assert.strictEqual(
      normalizeSettings({ appearance: { theme: 'auto', appIcon: bad } }).appearance.appIcon,
      DEFAULT_APP_ICON,
    );
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
    assert.strictEqual(toAppIconChoice(escape), 'default');
  }
  assert.strictEqual(toAppIconChoice('sky'), 'sky');
  assert.strictEqual(toAppIconChoice(`custom:${'a'.repeat(32)}`), `custom:${'a'.repeat(32)}`);
});

test('WorkHub stays opt-in and malformed persisted values fail closed', () => {
  const defaults = createDefaultSettings();
  assert.deepStrictEqual(defaults.workHub, { enabled: false });
  assert.deepStrictEqual(normalizeSettings({ workHub: { enabled: true } }).workHub, {
    enabled: true,
  });
  assert.deepStrictEqual(normalizeSettings({ workHub: { enabled: 'yes' } }).workHub, {
    enabled: false,
  });
  assert.deepStrictEqual(mergeSettings(defaults, { workHub: { enabled: true } }).workHub, {
    enabled: true,
  });
});

describe('app icon per appearance', () => {
  test('one icon serves both appearances until a dark one is chosen', () => {
    const appearance = { appIcon: 'forest' } as const;
    assert.strictEqual(appIconForTheme(appearance, false), 'forest');
    assert.strictEqual(appIconForTheme(appearance, true), 'forest');
  });

  test('a dark choice applies only to dark', () => {
    const appearance = { appIcon: 'sky', appIconDark: 'midnight' } as const;
    assert.strictEqual(appIconForTheme(appearance, false), 'sky');
    assert.strictEqual(appIconForTheme(appearance, true), 'midnight');
  });

  test('a settings file written before the dark slot existed keeps its icon in both', () => {
    // The upgrade case: absent must not silently become the shipped dark
    // default, or everyone who ever picked an icon gains a second one they
    // never chose the first time they launch in dark mode.
    const normalized = normalizeSettings({ appearance: { appIcon: 'paper' } });
    assert.strictEqual(normalized.appearance.appIconDark, undefined);
    assert.strictEqual(appIconForTheme(normalized.appearance, true), 'paper');
  });

  test('clearing the dark slot survives normalization as absent, not as a default', () => {
    const cleared = mergeSettings(createDefaultSettings(), {
      appearance: { appIcon: 'ink', appIconDark: undefined },
    });
    assert.strictEqual(normalizeSettings(cleared).appearance.appIconDark, undefined);
  });

  test('a present-but-invalid dark id falls back instead of reaching the main process', () => {
    const normalized = normalizeSettings({
      appearance: { appIcon: 'sky', appIconDark: '../../etc/passwd' },
    });
    assert.strictEqual(normalized.appearance.appIconDark, DEFAULT_APP_ICON_DARK);
  });

  test('a fresh install uses one icon in both appearances', () => {
    // The split ships OFF. DEFAULT_APP_ICON_DARK is what the dark slot is
    // seeded with when the user turns it on, not something applied for them.
    const fresh = createDefaultSettings().appearance;
    assert.strictEqual(fresh.appIconDark, undefined);
    assert.strictEqual(appIconForTheme(fresh, false), DEFAULT_APP_ICON);
    assert.strictEqual(appIconForTheme(fresh, true), DEFAULT_APP_ICON);
  });

  test('the shipped dark recommendation is a real icon that can be seeded', () => {
    // It is not in the defaults, so nothing else would catch it going stale.
    assert.strictEqual(
      appIconForTheme({ appIcon: DEFAULT_APP_ICON, appIconDark: DEFAULT_APP_ICON_DARK }, true),
      DEFAULT_APP_ICON_DARK,
    );
  });

  test('the startup icon matches what a fresh install resolves to', () => {
    // These two are applied by different code paths — one before settings are
    // read, one after — and a mismatch is a visible flash on every launch.
    assert.strictEqual(
      startupAppIcon(false),
      appIconForTheme(createDefaultSettings().appearance, false),
    );
    assert.strictEqual(
      startupAppIcon(true),
      appIconForTheme(createDefaultSettings().appearance, true),
    );
  });

  test('a malformed choice cannot survive as a path fragment', () => {
    assert.strictEqual(toAppIconChoice('../../evil'), 'default');
  });
});

describe('app icon on upgrade', () => {
  test('a settings file that recorded a choice keeps it', () => {
    // Anyone who ever opened the icon picker has an id on disk, and changing
    // the shipped default must not move it.
    const kept = normalizeSettings({ appearance: { theme: 'auto', appIcon: 'default' } });
    assert.strictEqual(kept.appearance.appIcon, 'default');
  });

  test('a settings file that never recorded one takes the new default', () => {
    // This is deliberate, and it is how a default actually changes: a file
    // with no `appIcon` key predates the picker, so its owner never chose the
    // old mark — they were shown it. `readOrCreate` does not rewrite existing
    // files, so this resolves on every read rather than migrating once.
    const migrated = normalizeSettings({ appearance: { theme: 'auto' } });
    assert.strictEqual(migrated.appearance.appIcon, DEFAULT_APP_ICON);
    assert.strictEqual(migrated.appearance.appIconDark, undefined);
  });
});

test('proxy credentials never enter persisted settings', () => {
  const defaults = createDefaultSettings();
  assert.strictEqual('password' in defaults.network.proxy, false);
  assert.strictEqual('passwordConfigured' in defaults.network.proxy, false);

  const merged = mergeSettings(defaults, {
    network: {
      proxy: {
        host: '10.0.0.2',
        credential: { kind: 'replace', secret: 'complete-secret' },
        password: 'legacy-secret',
        passwordConfigured: true,
      },
    },
  } as never);

  assert.strictEqual(merged.network.proxy.host, '10.0.0.2');
  assert.strictEqual('credential' in merged.network.proxy, false);
  assert.strictEqual('password' in merged.network.proxy, false);
  assert.strictEqual('passwordConfigured' in merged.network.proxy, false);

  const normalized = normalizeSettings({
    network: {
      proxy: {
        password: 'legacy-secret',
        passwordConfigured: true,
        credential: { kind: 'delete' },
      },
    },
  });
  assert.strictEqual('credential' in normalized.network.proxy, false);
  assert.strictEqual('password' in normalized.network.proxy, false);
  assert.strictEqual('passwordConfigured' in normalized.network.proxy, false);
});
