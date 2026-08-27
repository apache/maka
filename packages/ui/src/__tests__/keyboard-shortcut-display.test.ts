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
 * A shortcut is one binding and three spellings.
 *
 * `mod+n` has always created a task on every platform — Astryx resolves `mod`
 * to Command on macOS and Control elsewhere — but the labels were written once,
 * in macOS glyphs, so a Windows user was told to press ⌘ N for a shortcut that
 * answered to Ctrl N (#3876). These cover all three platforms because the whole
 * bug was that only one of them had ever been checked.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatShortcut,
  formatShortcutKey,
  orderShortcutKeys,
  parseShortcutKeys,
  shortcutLabel,
  usesAppleShortcutGlyphs,
} from '../keyboard-shortcut-display.js';

test('macOS keeps the glyphs, Windows and Linux spell the modifiers', () => {
  const shortcuts = [
    ['mod', 'n'],
    ['mod', 'k'],
    ['mod', ','],
    ['mod', 'shift', 'd'],
    ['mod', 'alt', 's'],
  ];
  assert.deepEqual(
    shortcuts.map((keys) => formatShortcut(keys, 'darwin')),
    ['⌘N', '⌘K', '⌘,', '⇧⌘D', '⌥⌘S'],
  );
  assert.deepEqual(
    shortcuts.map((keys) => formatShortcut(keys, 'win32')),
    ['Ctrl+N', 'Ctrl+K', 'Ctrl+,', 'Ctrl+Shift+D', 'Ctrl+Alt+S'],
  );
  // Linux is not a third spelling. It shares Windows' keyboard conventions,
  // and the point of asserting it separately is that `darwin` must be the
  // exception rather than every other platform having to opt in.
  assert.deepEqual(
    shortcuts.map((keys) => formatShortcut(keys, 'linux')),
    ['Ctrl+N', 'Ctrl+K', 'Ctrl+,', 'Ctrl+Shift+D', 'Ctrl+Alt+S'],
  );
});

test('the rail keeps its single space on every platform', () => {
  // `⌘ N` is what the new-task row has always shown, and a 32px row has no
  // space for `Ctrl+N`'s extra character either. The separator is the caller's
  // to choose; which modifier it separates is not.
  assert.equal(formatShortcut(['mod', 'n'], 'darwin', { separator: ' ' }), '⌘ N');
  assert.equal(formatShortcut(['mod', 'n'], 'win32', { separator: ' ' }), 'Ctrl N');
  assert.equal(formatShortcut(['mod', 'n'], 'linux', { separator: ' ' }), 'Ctrl N');
});

test('modifiers lead in the order the platform prints them', () => {
  // Not a glyph substitution: Apple puts Command last so it sits against the
  // character (`⇧⌘D`), and Windows leads with Control (`Ctrl+Shift+D`).
  // Swapping glyphs alone would have spelled `Shift+Ctrl+D`, which no Windows
  // app writes.
  assert.deepEqual(orderShortcutKeys(['mod', 'shift', 'd'], 'darwin'), ['shift', 'mod', 'd']);
  assert.deepEqual(orderShortcutKeys(['mod', 'shift', 'd'], 'win32'), ['mod', 'shift', 'd']);
  // Authored order survives among non-modifiers: ← and → are two alternatives
  // for one row, not a chord to be sorted.
  assert.deepEqual(orderShortcutKeys(['shift', 'left', 'right'], 'win32'), [
    'shift',
    'left',
    'right',
  ]);
});

test('ctrl is Control on both, and never the Command glyph', () => {
  // A binding that names `ctrl` rather than `mod` means the physical Control
  // key, including on macOS, where it is ⌃ and NOT ⌘.
  assert.equal(formatShortcutKey('ctrl', 'darwin'), '⌃');
  assert.equal(formatShortcutKey('ctrl', 'win32'), 'Ctrl');
  // Off macOS `mod` IS Control, so both tokens land on the same word rather
  // than one of them announcing a key the keyboard does not have.
  assert.equal(formatShortcutKey('mod', 'win32'), 'Ctrl');
});

test('keys that are the same everywhere are spelled once', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(formatShortcutKey('up', platform), '↑');
    assert.equal(formatShortcutKey('enter', platform), '↵');
    assert.equal(formatShortcutKey('tab', platform), '⇥');
    assert.equal(formatShortcutKey('escape', platform), 'Esc');
    // A bare character reads as it does on the keycap, and punctuation is left
    // alone by the same rule.
    assert.equal(formatShortcutKey('n', platform), 'N');
    assert.equal(formatShortcutKey(',', platform), ',');
    assert.equal(formatShortcutKey('?', platform), '?');
  }
});

test('a screen reader hears words, never glyphs', () => {
  assert.equal(shortcutLabel(['mod', 'shift', 'd'], 'darwin'), 'Shift + Command + D');
  assert.equal(shortcutLabel(['mod', 'shift', 'd'], 'win32'), 'Control + Shift + D');
  assert.equal(shortcutLabel(['alt', 'enter'], 'linux'), 'Alt + Enter');
});

test('an Astryx-style spec parses into the same tokens', () => {
  assert.deepEqual(parseShortcutKeys('mod+shift+d'), ['mod', 'shift', 'd']);
  assert.deepEqual(parseShortcutKeys('Ctrl+`'), ['ctrl', '`']);
  // `plus` is the word for the `+` key, so splitting on `+` cannot lose it.
  assert.deepEqual(parseShortcutKeys('shift+plus'), ['shift', 'plus']);
  assert.equal(formatShortcut(parseShortcutKeys('shift+plus'), 'win32'), 'Shift++');
});

test('an unresolved platform is answered by the browser, not defaulted', () => {
  // The authoritative platform arrives over async IPC and the first paint
  // happens before it does. Reading `navigator` in the meantime is what keeps
  // a Mac from showing `Ctrl N` for a frame and then flipping to `⌘ N`.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const stubNavigator = (platform: string) => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform },
      configurable: true,
    });
  };
  try {
    stubNavigator('MacIntel');
    assert.equal(usesAppleShortcutGlyphs(undefined), true);
    assert.equal(formatShortcut(['mod', 'n'], undefined, { separator: ' ' }), '⌘ N');

    stubNavigator('Win32');
    assert.equal(usesAppleShortcutGlyphs(undefined), false);
    assert.equal(formatShortcut(['mod', 'n'], undefined, { separator: ' ' }), 'Ctrl N');
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('an explicit platform wins over whatever the browser claims', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'MacIntel' },
    configurable: true,
  });
  try {
    // Electron reports the real host; a rewritten user agent does not get to
    // overrule it.
    assert.equal(usesAppleShortcutGlyphs('win32'), false);
    assert.equal(formatShortcut(['mod', 'n'], 'win32', { separator: ' ' }), 'Ctrl N');
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
