// apps/desktop/src/renderer/theme.ts
//
// Tiny client-side helper that resolves a ThemePreference ('light' | 'dark' |
// 'auto') to an actual mode and toggles `.dark` on <html>. When the preference
// is `auto`, the helper subscribes to the system `prefers-color-scheme` media
// query so the app follows OS-level Light/Dark switches in real time.
//
import type { ThemePalette, ThemePreference } from '@maka/core';
import { safeLocalStorageSet } from './browser-storage';

const DARK_CLASS = 'dark';
const APPEARANCE_EVENT = 'maka:appearance';

let unsubscribeMediaQuery: (() => void) | null = null;
let appearanceObserver: MutationObserver | null = null;
let activeThemePreference: ThemePreference = 'auto';
let activeThemePalette: ThemePalette = 'default';

export interface MakaAppearanceSnapshot {
  preference: ThemePreference;
  resolvedTheme: 'light' | 'dark';
  palette: ThemePalette;
  colorScheme: 'light' | 'dark';
  forcedColors: boolean;
  prefersContrast: boolean;
  reducedMotion: boolean;
  reducedTransparency: boolean;
}

export function readMakaAppearance(): MakaAppearanceSnapshot {
  const root = document.documentElement;
  const resolvedTheme = root.classList.contains(DARK_CLASS) ? 'dark' : 'light';
  return {
    preference: activeThemePreference,
    resolvedTheme,
    palette: activeThemePalette,
    colorScheme: resolvedTheme,
    forcedColors: window.matchMedia('(forced-colors: active)').matches,
    prefersContrast: window.matchMedia('(prefers-contrast: more)').matches,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    reducedTransparency: window.matchMedia('(prefers-reduced-transparency: reduce)').matches,
  };
}

function publishAppearance(): void {
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, {
    detail: readMakaAppearance(),
  }));
}

function ensureAppearanceObserver(): void {
  if (appearanceObserver) return;
  const root = document.documentElement;
  appearanceObserver = new MutationObserver(() => {
    syncTitleBarOverlay(root);
    publishAppearance();
  });
  appearanceObserver.observe(root, {
    attributes: true,
    attributeFilter: [
      'class',
      'style',
      'data-maka-theme',
      'data-maka-skin',
      'data-maka-skin-appearance-revision',
    ],
  });
}

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
  activeThemePreference = pref;
  document.documentElement.dataset.makaThemePreference = pref;
  ensureAppearanceObserver();

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
  root.dataset.makaColorScheme = isDark ? 'dark' : 'light';
  // Lets native form controls and scrollbars pick up the right base colors per
  // the Vercel Web Interface Guidelines dark-mode rule.
  root.style.colorScheme = isDark ? 'dark' : 'light';
  syncTitleBarOverlay(root);
  publishAppearance();
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
  activeThemePalette = palette;
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
  publishAppearance();
}

function syncTitleBarOverlay(root: HTMLElement): void {
  // The native Windows overlay sits on top of the renderer's content surface.
  // Sample the actual resolved --background color instead of approximating it
  // with one hard-coded light and dark pair; this also follows every palette.
  const backgroundColor = cssColorToHex(
    getComputedStyle(root).getPropertyValue('--background'),
    root.classList.contains(DARK_CLASS) ? '#1c1d21' : '#ffffff',
  );
  void window.maka?.appWindow
    ?.setTitleBarOverlayTheme?.({
      isDark: root.classList.contains(DARK_CLASS),
      backgroundColor,
    })
    .catch(() => {});
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
