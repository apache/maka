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

// packages/ui/src/keyboard-shortcut-display.ts
//
// How a shortcut is SPELLED, for every surface that shows one. Bindings are a
// separate concern and stay where they are: `useHotkeys` already takes `mod`
// and resolves it to Command on macOS and Control everywhere else, so the keys
// a user presses were never platform-specific — only the labels were, and they
// were written once, in macOS glyphs, and shown to everyone (#3876).
//
// Shortcuts are not localized, so this lives outside the locale catalogs: `⌘,`
// and `Ctrl+,` are the same copy in Chinese and in English. What varies is the
// host, so the platform is the only argument.

/**
 * Host platform, spelled as Electron's `process.platform` spells it
 * (`darwin` / `win32` / `linux`), which is what `app.info()` reports and what
 * `data-os` carries.
 */
export type ShortcutPlatform = string;

/**
 * Modifiers in the order the platform prints them.
 *
 * Apple's own order is Control-Option-Shift-Command, so Command lands next to
 * the character it modifies (`⇧⌘D`). Windows and Linux lead with Control
 * instead (`Ctrl+Shift+D`), which is why this is a reordering and not a glyph
 * substitution: swapping ⇧⌘ for Shift+Ctrl would spell a real shortcut in an
 * order no Windows app uses.
 */
const APPLE_MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'mod'] as const;
const PC_MODIFIER_ORDER = ['mod', 'ctrl', 'alt', 'shift'] as const;

const APPLE_KEY_DISPLAY: Readonly<Record<string, string>> = {
  mod: '\u2318', // ⌘
  ctrl: '\u2303', // ⌃
  alt: '\u2325', // ⌥
  shift: '\u21E7', // ⇧
};

const PC_KEY_DISPLAY: Readonly<Record<string, string>> = {
  // `mod` IS Control off macOS — the same key, named twice, so both spell it
  // the way the platform prints it rather than one of them saying "Cmd".
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
};

/**
 * Keys that are neither modifiers nor single characters, and whose glyph is
 * the same on every platform: an arrow key is ↑ on a Mac and on a ThinkPad.
 */
const SHARED_KEY_DISPLAY: Readonly<Record<string, string>> = {
  up: '\u2191',
  down: '\u2193',
  left: '\u2190',
  right: '\u2192',
  enter: '\u21B5', // ↵
  tab: '\u21E5', // ⇥
  backspace: '\u232B', // ⌫
  escape: 'Esc',
  plus: '+',
};

/** Spoken names, for the accessible label a glyph cannot carry. */
const APPLE_KEY_LABEL: Readonly<Record<string, string>> = { mod: 'Command' };
const SHARED_KEY_LABEL: Readonly<Record<string, string>> = {
  mod: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  up: 'Up arrow',
  down: 'Down arrow',
  left: 'Left arrow',
  right: 'Right arrow',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  escape: 'Escape',
  plus: 'Plus',
};

const MODIFIERS = new Set<string>([...PC_MODIFIER_ORDER]);

/**
 * Whether this host prints Apple's modifier glyphs.
 *
 * A missing platform is answered from the browser rather than defaulted,
 * because the authoritative value arrives over async IPC (`app.info()`) and
 * the first paint happens before it does. `navigator` is available
 * synchronously and is the same signal Astryx's own `Kbd` reads, so a label is
 * right from the first frame instead of flipping from ⌘ to Ctrl once the main
 * process answers.
 */
export function usesAppleShortcutGlyphs(platform?: ShortcutPlatform | null): boolean {
  if (platform) return /^(darwin|mac)/i.test(platform);
  return detectApplePlatformFromNavigator();
}

function detectApplePlatformFromNavigator(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData: unknown = 'userAgentData' in navigator ? navigator.userAgentData : null;
  if (uaData && typeof uaData === 'object' && 'platform' in uaData) {
    const uaPlatform = (uaData as { platform?: unknown }).platform;
    // A blank platform is no answer, not a negative one — fall through to the
    // deprecated field rather than reading '' as "not Apple".
    if (typeof uaPlatform === 'string' && uaPlatform.trim() !== '') {
      return /mac/i.test(uaPlatform);
    }
  }
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? '');
}

/**
 * Splits an Astryx-style `keys` string (`'mod+shift+d'`) into tokens. `plus`
 * is the literal `+` key, which is why it is spelled as a word.
 */
export function parseShortcutKeys(keys: string): string[] {
  return keys
    .split('+')
    .map((key) => key.trim().toLowerCase())
    .filter((key) => key.length > 0);
}

/** One key, spelled for this platform. */
export function formatShortcutKey(key: string, platform?: ShortcutPlatform | null): string {
  const token = key.trim().toLowerCase();
  const apple = usesAppleShortcutGlyphs(platform);
  const modifier = apple ? APPLE_KEY_DISPLAY[token] : PC_KEY_DISPLAY[token];
  if (modifier) return modifier;
  const shared = SHARED_KEY_DISPLAY[token];
  if (shared) return shared;
  // A bare character is printed as it appears on the keycap: `N`, not `n`, and
  // `,` unchanged — uppercasing is what a keycap does to a letter and nothing
  // to punctuation.
  return token.toUpperCase();
}

/** One key, named for a screen reader. */
export function shortcutKeyLabel(key: string, platform?: ShortcutPlatform | null): string {
  const token = key.trim().toLowerCase();
  if (usesAppleShortcutGlyphs(platform)) {
    const apple = APPLE_KEY_LABEL[token];
    if (apple) return apple;
  }
  return SHARED_KEY_LABEL[token] ?? token.toUpperCase();
}

/**
 * Modifiers first, in the host's own order, then the rest as authored.
 *
 * Only modifiers move. `['shift', 'left', 'right']` keeps ← before → because
 * those are two alternatives for one row, not a chord to be sorted.
 */
export function orderShortcutKeys(
  keys: readonly string[],
  platform?: ShortcutPlatform | null,
): string[] {
  const tokens = keys.map((key) => key.trim().toLowerCase());
  const order = usesAppleShortcutGlyphs(platform) ? APPLE_MODIFIER_ORDER : PC_MODIFIER_ORDER;
  const modifiers = order.filter((modifier) => tokens.includes(modifier));
  return [...modifiers, ...tokens.filter((token) => !MODIFIERS.has(token))];
}

/**
 * A whole shortcut as one string.
 *
 * The default separator is the platform's: macOS runs its glyphs together
 * (`⇧⌘D`) where Windows and Linux spell the chord out (`Ctrl+Shift+D`).
 * Callers that sit in a tighter space pass their own — the rail's new-task
 * hint has always used a single space (`⌘ N`), and keeps it (`Ctrl N`).
 */
export function formatShortcut(
  keys: readonly string[],
  platform?: ShortcutPlatform | null,
  options?: { separator?: string },
): string {
  const separator = options?.separator ?? (usesAppleShortcutGlyphs(platform) ? '' : '+');
  return orderShortcutKeys(keys, platform)
    .map((key) => formatShortcutKey(key, platform))
    .join(separator);
}

/** A whole shortcut, named for a screen reader. */
export function shortcutLabel(
  keys: readonly string[],
  platform?: ShortcutPlatform | null,
): string {
  return orderShortcutKeys(keys, platform)
    .map((key) => shortcutKeyLabel(key, platform))
    .join(' + ');
}
