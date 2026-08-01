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

let unsubscribeMediaQuery: (() => void) | null = null;
let titleBarOverlayObserver: MutationObserver | null = null;
let titleBarOverlayFrame: number | null = null;

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
  observeModalBackdrops(root);
  // The native Windows overlay sits on top of the renderer's content surface.
  // Sample the actual resolved --background color instead of approximating it
  // with one hard-coded light and dark pair; this also follows every palette.
  const baseColor = cssColorToHex(
    getComputedStyle(root).getPropertyValue('--background'),
    root.classList.contains(DARK_CLASS) ? '#1c1d21' : '#ffffff',
  );
  const backgroundColor = compositeActiveModalBackdrop(baseColor);
  void window.maka?.appWindow
    ?.setTitleBarOverlayTheme?.({
      isDark: root.classList.contains(DARK_CLASS),
      backgroundColor,
    })
    .catch(() => {});
}

/**
 * Native Windows caption controls live above Chromium, so a dialog's
 * `::backdrop` cannot dim their titlebar strip. Watch the native dialog open
 * state and re-sync that strip to the same composited backdrop color.
 */
function observeModalBackdrops(root: HTMLElement): void {
  if (titleBarOverlayObserver || typeof MutationObserver === 'undefined') return;

  titleBarOverlayObserver = new MutationObserver((mutations) => {
    const modalStateChanged = mutations.some((mutation) => {
      if (mutation.type === 'attributes') return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(
        (node) =>
          node instanceof Element &&
          (node.matches('dialog[open]') || node.querySelector('dialog[open]')),
      );
    });
    if (!modalStateChanged || titleBarOverlayFrame !== null) return;
    titleBarOverlayFrame = window.requestAnimationFrame(() => {
      titleBarOverlayFrame = null;
      syncTitleBarOverlay(root);
    });
  });
  titleBarOverlayObserver.observe(root, {
    attributes: true,
    attributeFilter: ['open'],
    childList: true,
    subtree: true,
  });
}

function compositeActiveModalBackdrop(baseColor: string): string {
  const openDialogs = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
  const activeDialog = openDialogs.item(openDialogs.length - 1);
  if (!activeDialog) return baseColor;

  const backdropStyle = getComputedStyle(activeDialog, '::backdrop');
  const backdrop = cssColorToRgba(backdropStyle.backgroundColor);
  const base = cssColorToRgba(baseColor);
  if (!backdrop || !base) return baseColor;

  const backdropOpacity = Number.parseFloat(backdropStyle.opacity);
  const alpha = backdrop.alpha *
    (Number.isFinite(backdropOpacity) ? backdropOpacity : 1);
  return rgbaToHex({
    red: backdrop.red * alpha + base.red * (1 - alpha),
    green: backdrop.green * alpha + base.green * (1 - alpha),
    blue: backdrop.blue * alpha + base.blue * (1 - alpha),
    alpha: 1,
  });
}

type RgbaColor = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

function cssColorToHex(value: string, fallback: string): string {
  const rgba = cssColorToRgba(value);
  if (!rgba || rgba.alpha !== 1) return fallback;
  return rgbaToHex(rgba);
}

function cssColorToRgba(value: string): RgbaColor | null {
  const color = value.trim();
  if (!color || !CSS.supports('color', color)) return null;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  return { red, green, blue, alpha: alpha / 255 };
}

function rgbaToHex(color: RgbaColor): string {
  return `#${[color.red, color.green, color.blue]
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}
