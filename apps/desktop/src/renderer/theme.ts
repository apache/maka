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

// apps/desktop/src/renderer/theme.ts
//
// Tiny client-side helper that resolves a ThemePreference ('light' | 'dark' |
// 'auto') to an actual mode and toggles `.dark` on <html>. When the preference
// is `auto`, the helper subscribes to the system `prefers-color-scheme` media
// query so the app follows OS-level Light/Dark switches in real time.
//
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  normalizeTerminalFontSize,
  normalizeUiFontSize,
  type ThemePalette,
  type ThemePreference,
} from '@maka/core/settings';
import { TYPE_SCALE_BASE_PX } from './astryx-theme/type-scale.js';
import { safeLocalStorageGet, safeLocalStorageSet } from './browser-storage';
import { compositeScrimOverBackground, parseCssRgbColor } from './titlebar-dim-color.js';

const DARK_CLASS = 'dark';

// Persisted alongside the theme/palette caches so the pre-React paint
// (cached-theme-bootstrap.ts) can restore a non-default size before the first
// frame, same rationale as `maka-theme-v1`.
const UI_FONT_SIZE_STORAGE_KEY = 'maka-ui-font-size-v1';
const TERMINAL_FONT_SIZE_STORAGE_KEY = 'maka-terminal-font-size-v1';
// The renderer type scale is generated from TYPE_SCALE_BASE_PX (the same
// constant makaTheme.ts feeds into expandTypeScale) and every --font-size-*
// token is rem, so the root font-size that reproduces a chosen base px is
// `16 * px / base`. At the base that is the 16px browser default (no change);
// other values scale what is rem-derived — text and Astryx's rem icon atoms —
// while px-literal spacing and widths stay fixed.
const BROWSER_ROOT_FONT_SIZE_PX = 16;

let currentUiFontSize: number = DEFAULT_UI_FONT_SIZE;
let currentTerminalFontSize: number = DEFAULT_TERMINAL_FONT_SIZE;
const terminalFontSizeListeners = new Set<(size: number) => void>();

export function getUiFontSize(): number {
  return currentUiFontSize;
}

/**
 * Apply the UI base font size by writing the proportional document-root
 * font-size, then persist so the pre-React paint can restore it next launch.
 * Clamps out-of-range / wrong-typed input to a sane value.
 */
export function applyUiFontSize(size: number): void {
  const next = normalizeUiFontSize(size);
  currentUiFontSize = next;
  document.documentElement.style.fontSize = `${(BROWSER_ROOT_FONT_SIZE_PX * next) / TYPE_SCALE_BASE_PX}px`;
  safeLocalStorageSet(UI_FONT_SIZE_STORAGE_KEY, String(next));
}

export function getTerminalFontSize(): number {
  return currentTerminalFontSize;
}

/**
 * Set the xterm font size. There is no DOM to touch here — live terminals
 * subscribe via `subscribeTerminalFontSize` and re-fit themselves; a terminal
 * opened later reads `getTerminalFontSize()` at creation.
 */
export function applyTerminalFontSize(size: number): void {
  const next = normalizeTerminalFontSize(size);
  currentTerminalFontSize = next;
  safeLocalStorageSet(TERMINAL_FONT_SIZE_STORAGE_KEY, String(next));
  for (const listener of terminalFontSizeListeners) listener(next);
}

/** Subscribe to live terminal font-size changes. Returns an unsubscribe fn. */
export function subscribeTerminalFontSize(listener: (size: number) => void): () => void {
  terminalFontSizeListeners.add(listener);
  return () => {
    terminalFontSizeListeners.delete(listener);
  };
}

/**
 * Restore the cached UI font size before React mounts, so a non-default size
 * does not paint at the default and snap once settings.json loads. Mirrors the
 * cached theme/palette restore in cached-theme-bootstrap.ts. Also seeds the
 * terminal size cache so an early terminal open uses the right size.
 */
export function applyCachedFontAppearanceBeforeMount(): void {
  const cachedUi = Number.parseInt(safeLocalStorageGet(UI_FONT_SIZE_STORAGE_KEY) ?? '', 10);
  if (Number.isFinite(cachedUi)) applyUiFontSize(cachedUi);
  const cachedTerminal = Number.parseInt(safeLocalStorageGet(TERMINAL_FONT_SIZE_STORAGE_KEY) ?? '', 10);
  if (Number.isFinite(cachedTerminal)) currentTerminalFontSize = normalizeTerminalFontSize(cachedTerminal);
}

let unsubscribeMediaQuery: (() => void) | null = null;

/**
 * Apply a theme preference to <html>. Returns an unsubscribe function for the
 * caller; we also memoize the active subscription internally so re-applying a
 * different preference cleanly tears down the previous listener.
 *
 * Also persists the preference to `maka-theme-v1` in localStorage so the
 * pre-React paint in `main.tsx` can apply `.dark` synchronously on next
 * launch, eliminating the brief light-mode flash for dark-theme users.
 */
export function applyTheme(pref: ThemePreference): () => void {
  unsubscribeMediaQuery?.();
  unsubscribeMediaQuery = null;

  // Cache the user-facing preference (not the resolved light/dark). The
  // pre-React paint reapplies the auto → system-matchMedia branch itself.
  safeLocalStorageSet('maka-theme-v1', pref);

  // Also syncs Electron's own native chrome (nativeTheme.themeSource) --
  // see toNativeThemeSource() in main-window.ts for why this DOM-only flip
  // isn't enough on its own.
  void window.maka.appWindow.setThemeSource(pref).catch(() => {});

  if (pref === 'auto') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setDarkClass(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setDarkClass(event.matches);
    mq.addEventListener('change', onChange);
    unsubscribeMediaQuery = () => mq.removeEventListener('change', onChange);
  } else {
    setDarkClass(pref === 'dark');
  }

  return () => {
    unsubscribeMediaQuery?.();
    unsubscribeMediaQuery = null;
  };
}

function setDarkClass(isDark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle(DARK_CLASS, isDark);
  // This is what picks the mode, not just what tells native form controls and
  // scrollbars about it: every palette colour is a `light-dark()` pair that
  // resolves against color-scheme (maka-tokens.css, DESIGN.md §8). It must stay
  // in lockstep with the class — which also carries the mode to Astryx — and it
  // must keep being set before the first paint (cached-theme-bootstrap.ts).
  //
  // Inside the app, Astryx's <Theme> re-declares color-scheme on its own
  // wrapper from the class (astryx-theme-mode.ts), so the subtree turns over on
  // that React commit rather than on this line. That is one repaint later and
  // it is the whole switch, not half of it — which is the point: the palette
  // and Astryx's own tokens can no longer disagree for a frame.
  root.style.colorScheme = isDark ? 'dark' : 'light';
  syncTitleBarOverlay(root);
}

/**
 * A modal dialog's ::backdrop dims every pixel of the page — except the
 * OS-drawn window-controls strip (the Windows titleBarOverlay box, the macOS
 * traffic lights), which is composited above web content and stays bright.
 * While any native `<dialog>` is modal-open, `titlebar-modal-sync.ts` sets
 * this flag so the overlay color below folds the backdrop scrim in and the
 * strip reads as part of the dimmed window; macOS additionally hides its
 * traffic lights outright via the same signal.
 */
let titlebarModalDimmed = false;

export function setTitlebarModalDimmed(dimmed: boolean): void {
  if (titlebarModalDimmed === dimmed) return;
  titlebarModalDimmed = dimmed;
  // No-ops outside darwin (main-process gate); Windows has no hide API, so
  // the dimmed overlay color below is the whole fix there.
  void window.maka?.appWindow?.setTitlebarControlsVisible?.(!dimmed).catch(() => {});
  syncTitleBarOverlay(document.documentElement);
}

/**
 * PR-UI-2 (@yuejing 2026-05-22): apply a base46 palette by writing
 * `data-maka-theme="<palette>"` on `<html>`. CSS variable overrides
 * live in `maka-tokens.css`. `default` removes the attribute so the
 * original Maka palette renders.
 *
 * A palette carries both of its modes inside each value, so the light/dark
 * variants follow `color-scheme` (set on <html> beside the class by
 * setDarkClass) with no separate IPC and no second block per palette. Flipping
 * the class alone no longer switches anything.
 */
export function applyThemePalette(palette: ThemePalette): void {
  const root = document.documentElement;
  if (palette === 'default') {
    root.removeAttribute('data-maka-theme');
  } else {
    root.setAttribute('data-maka-theme', palette);
  }
  safeLocalStorageSet('maka-theme-palette-v1', palette);
  // Palette variants override --background independently of light/dark mode.
  // Re-sync after changing the attribute so the native Windows controls never
  // retain the previous palette's titlebar color.
  syncTitleBarOverlay(root);
}

function syncTitleBarOverlay(root: HTMLElement): void {
  // The native Windows overlay sits on top of the renderer's content surface.
  // Sample the actual painted --background color instead of approximating it
  // with one hard-coded light and dark pair; this also follows every palette.
  const isDark = root.classList.contains(DARK_CLASS);
  const backgroundColor = paintedBackgroundToHex(root, isDark ? '#1c1d21' : '#ffffff');
  void window.maka?.appWindow
    ?.setTitleBarOverlayTheme?.({
      isDark,
      backgroundColor: titlebarModalDimmed
        ? dimmedTitlebarColor(backgroundColor, isDark)
        : backgroundColor,
    })
    .catch(() => {});
}

/**
 * The color the titlebar strip appears under an open modal: the dialog
 * backdrop scrim composited over `--background`. The scrim is sampled from
 * the open modal's own ::backdrop, so the dim tracks theme and palette
 * automatically.
 */
function dimmedTitlebarColor(backgroundHex: string, isDark: boolean): string {
  // The app's theme pins the scrim to black@50%/80% (astryx-theme/maka.css);
  // mirror that as the fallback if no modal backdrop can be sampled.
  const scrim = readModalBackdropColor() ?? { r: 0, g: 0, b: 0, a: isDark ? 0.8 : 0.5 };
  return compositeScrimOverBackground(scrim, backgroundHex);
}

/**
 * The computed color of the open modal's ::backdrop. Callers only dim while a
 * `dialog:modal` exists, so a null here means something unusual happened —
 * fall back rather than dimming wrong.
 */
function readModalBackdropColor(): { r: number; g: number; b: number; a: number } | null {
  const dialog = document.querySelector('dialog:modal');
  if (!dialog) return null;
  return parseCssRgbColor(getComputedStyle(dialog, '::backdrop').backgroundColor);
}

/**
 * The opaque color an element is painted, as hex. Takes the element rather
 * than a color string because a palette token's declared value is not a
 * color: `--background` is a `light-dark()` pair that only becomes one where
 * it is used (DESIGN.md §8), and a canvas cannot resolve that — nor anything
 * else that needs an element's context. Reading `background-color` off the
 * element that paints it (`html`, maka-tokens.css) hands the canvas an
 * already-resolved color.
 */
function paintedBackgroundToHex(element: Element, fallback: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return fallback;

  // A fillStyle the canvas cannot parse is ignored, leaving the previous value
  // in place — so start transparent. Anything unparseable then reads back at
  // alpha 0 and takes the fallback, rather than sampling the opaque black that
  // fillStyle defaults to.
  context.fillStyle = 'rgba(0, 0, 0, 0)';
  context.fillStyle = getComputedStyle(element).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha !== 255) return fallback;
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}
