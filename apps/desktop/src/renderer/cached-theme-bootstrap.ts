import { safeLocalStorageGet } from './browser-storage';

// Apply the cached theme before React mounts so dark-theme users don't get
// a brief light-mode flash while settings.json loads. We persist the resolved
// theme to localStorage on every change (theme.ts), and this entry point
// reads it synchronously before the first paint. This is the standard
// "FOUC prevention via inline-script" pattern, but here it runs in the same
// JS bundle as the rest of the renderer so we don't need to relax the CSP
// `script-src 'self'` rule.
export function applyCachedThemeBeforeMount(): void {
  const cachedThemePreference = safeLocalStorageGet('maka-theme-v1');
  const shouldApplyDarkTheme =
    cachedThemePreference === 'dark' ||
    (cachedThemePreference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.makaThemePreference =
    cachedThemePreference === 'light' || cachedThemePreference === 'dark'
      ? cachedThemePreference
      : 'auto';
  document.documentElement.dataset.makaColorScheme =
    shouldApplyDarkTheme ? 'dark' : 'light';
  if (shouldApplyDarkTheme) {
    document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = 'dark';
  } else {
    document.documentElement.style.colorScheme = 'light';
  }
  // PALETTE-LEAK-0: restore the cached palette too (persisted by
  // applyThemePalette), not just light/dark — otherwise non-default-palette
  // users get a first paint in the default zinc palette that visibly snaps
  // once app-shell applies settings. An unknown/stale value is harmless
  // (no [data-maka-theme=…] block matches → default palette), but keep the
  // attribute within the safe charset anyway.
  const cachedPalette = safeLocalStorageGet('maka-theme-palette-v1');
  if (cachedPalette && cachedPalette !== 'default' && /^[a-z0-9-]{1,32}$/.test(cachedPalette)) {
    document.documentElement.setAttribute('data-maka-theme', cachedPalette);
  }
}
