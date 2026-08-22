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
