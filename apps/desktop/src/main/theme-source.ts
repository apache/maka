import type { ThemePreference } from '@maka/core/settings';

export type NativeThemeSource = 'system' | 'light' | 'dark';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'auto' || value === 'light' || value === 'dark';
}

/**
 * The renderer's `.dark` class flip (renderer/theme.ts) only repaints the
 * DOM. `nativeTheme.themeSource` is the separate Electron/OS-level switch
 * that drives native chrome -- on macOS this is what the window's
 * `vibrancy: 'sidebar'` material (main-window.ts createWindow) reads its
 * light/dark tint from. Without keeping the two in sync, an in-app theme
 * that disagrees with the OS appearance leaves the vibrancy-backed sidebar
 * showing the *system* theme's tint while the rest of the (opaque) UI
 * repaints to the chosen one. Single conversion point for both the
 * createWindow() startup sync and the setThemeSource() IPC handler in
 * main-window.ts, so the two call sites can't drift out of sync with
 * each other.
 */
export function toNativeThemeSource(pref: ThemePreference): NativeThemeSource {
  return pref === 'auto' ? 'system' : pref;
}
