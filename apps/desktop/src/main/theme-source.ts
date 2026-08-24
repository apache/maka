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
