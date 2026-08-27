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

/**
 * What the shell's two shortcut surfaces SAY, on all three platforms.
 *
 * The palette hints and the shortcuts sheet used to be written into both locale
 * catalogs as macOS glyphs, so a Windows user was told to press ⌥⌘S for a side
 * chat that answers to Ctrl+Alt+S (#3876). These read the real catalogs through
 * the real formatter — the same call the panel and the palette make — so a glyph
 * reintroduced into either catalog fails here rather than shipping.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { formatShortcut } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import { buildCommandList } from '../../renderer/command-palette-commands.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';

const PLATFORMS = ['darwin', 'win32', 'linux'] as const;
const LOCALES: readonly UiLocale[] = ['en', 'zh'];
const APPLE_GLYPHS = /[\u2318\u2325\u21E7\u2303]/u;

function hints(locale: UiLocale, platform: string): Map<string, string | undefined> {
  const commands = buildCommandList({
    locale,
    platform,
    activeSessionId: 'session-1',
    themePref: 'auto',
    connections: [],
    defaultSlug: null,
    onNewChat: () => {},
    onOpenSideChat: () => {},
    onOpenSettings: () => {},
    onOpenSettingsSection: () => {},
    onOpenShortcuts: () => {},
    onSetTheme: () => {},
    // The diagnostics rows only register when the shell wires their action, and
    // two of them are what this file is about.
    onCopyDiagnostics: () => {},
    onOpenWorkspace: () => {},
  });
  return new Map(commands.map((command) => [command.id, command.hint]));
}

test('palette hints lead with the shortcut this platform answers to', () => {
  const mac = hints('en', 'darwin');
  assert.equal(mac.get('action:open-settings'), '⌘,');
  assert.equal(mac.get('action:side-chat'), '⌥⌘S');

  for (const platform of ['win32', 'linux']) {
    const pc = hints('en', platform);
    assert.equal(pc.get('action:open-settings'), 'Ctrl+,');
    assert.equal(pc.get('action:side-chat'), 'Ctrl+Alt+S');
  }
});

test('a hint that also carries prose keeps the prose, in its own locale', () => {
  // `⇧⌘D · Redacted logs · clipboard only` was one hard-coded string. The keys
  // are now derived and the sentence after them is still the catalog's.
  assert.equal(
    hints('en', 'darwin').get('diag:copy-diagnostics'),
    '⇧⌘D · Redacted logs · clipboard only',
  );
  assert.equal(
    hints('en', 'win32').get('diag:copy-diagnostics'),
    'Ctrl+Shift+D · Redacted logs · clipboard only',
  );
  assert.equal(
    hints('zh', 'win32').get('diag:copy-diagnostics'),
    'Ctrl+Shift+D · 脱敏日志 · 仅写入剪贴板',
  );
});

test('a command without a shortcut keeps the hint the catalog wrote', () => {
  // Positive control: the derivation must not reach commands it was never
  // about, or every hint in the palette would grow a shortcut it does not have.
  assert.equal(hints('en', 'win32').get('action:new-chat'), 'Start a new task');
  assert.equal(hints('en', 'win32').get('action:keyboard-help'), '?');
  assert.equal(hints('zh', 'darwin').get('diag:open-workspace'), 'Finder');
});

test('no palette hint spells a modifier with an Apple glyph off macOS', () => {
  for (const locale of LOCALES) {
    for (const platform of ['win32', 'linux']) {
      for (const [id, hint] of hints(locale, platform)) {
        assert.ok(
          !hint || !APPLE_GLYPHS.test(hint),
          `${locale}/${platform} hint for ${id} still reads ${hint}`,
        );
      }
    }
  }
});

test('the shortcuts sheet reads Ctrl off macOS and ⌘ on it', () => {
  for (const locale of LOCALES) {
    const rows = getShellCopy(locale).keyboardHelp.sections.flatMap((section) => section.rows);
    const general = new Map(
      rows.map((row) => [row.keys.join('+'), row.keys] as const),
    );
    const newTask = general.get('mod+n');
    const palette = general.get('mod+k');
    const diagnostics = general.get('mod+shift+d');
    const lineBreak = general.get('alt+enter');
    assert.ok(newTask && palette && diagnostics && lineBreak, `${locale} sheet lost a row`);

    assert.equal(formatShortcut(newTask, 'darwin'), '⌘N');
    assert.equal(formatShortcut(palette, 'darwin'), '⌘K');
    assert.equal(formatShortcut(diagnostics, 'darwin'), '⇧⌘D');
    assert.equal(formatShortcut(lineBreak, 'darwin'), '⌥↵');

    for (const platform of ['win32', 'linux']) {
      assert.equal(formatShortcut(newTask, platform), 'Ctrl+N');
      assert.equal(formatShortcut(palette, platform), 'Ctrl+K');
      assert.equal(formatShortcut(diagnostics, platform), 'Ctrl+Shift+D');
      assert.equal(formatShortcut(lineBreak, platform), 'Alt+↵');
    }
  }
});

test('the sheet is authored in tokens, so no row can be macOS-only', () => {
  // The bug was a glyph in the copy, not in the renderer. A row that reaches
  // the panel already spelled has no platform left to answer to.
  for (const locale of LOCALES) {
    for (const section of getShellCopy(locale).keyboardHelp.sections) {
      for (const row of section.rows) {
        for (const key of row.keys) {
          assert.ok(
            !APPLE_GLYPHS.test(key),
            `${locale} sheet row "${row.description}" hard-codes ${key}`,
          );
        }
      }
    }
  }
});

test('every sheet row renders something on every platform', () => {
  for (const locale of LOCALES) {
    for (const platform of PLATFORMS) {
      for (const section of getShellCopy(locale).keyboardHelp.sections) {
        for (const row of section.rows) {
          const rendered = formatShortcut(row.keys, platform);
          assert.ok(
            rendered.trim().length > 0,
            `${locale}/${platform} row "${row.description}" rendered nothing`,
          );
        }
      }
    }
  }
});
