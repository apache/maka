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
import type { ThemePalette, ThemePreference } from '@maka/core/settings';
import { safeLocalStorageSet } from './browser-storage';
import { compositeScrimOverBackground, parseCssRgbColor } from './titlebar-dim-color.js';

const DARK_CLASS = 'dark';

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
  // Lets native form controls and scrollbars pick up the right base colors per
  // the Vercel Web Interface Guidelines dark-mode rule.
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
 * Light/dark variants of each palette switch automatically with the
 * existing `.dark` class — no separate IPC needed.
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
  // Sample the actual resolved --background color instead of approximating it
  // with one hard-coded light and dark pair; this also follows every palette.
  const isDark = root.classList.contains(DARK_CLASS);
  const backgroundColor = cssColorToHex(
    getComputedStyle(root).getPropertyValue('--background'),
    isDark ? '#1c1d21' : '#ffffff',
  );
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
 * the open modal's own ::backdrop — the engine has already resolved its
 * `var()` indirection and `light-dark()` branch, which neither a token read
 * nor a canvas fillStyle can do — so the dim tracks theme and palette
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

function cssColorToHex(value: string, fallback: string): string {
  const color = value.trim();
  if (!color || !CSS.supports('color', color)) return fallback;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return fallback;

  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha !== 255) return fallback;
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}
