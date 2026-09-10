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

import { normalizeUiFontSize, type ThemePalette } from '@maka/core/settings';

// Shared by generated type tokens and document scaling. The default UI size
// must equal this design base; font-size-type-scale.test.ts checks that contract.
export const TYPE_SCALE_BASE_PX = 14;
const BROWSER_ROOT_FONT_SIZE_PX = 16;

/** Applies content appearance without changing native window chrome. */
export function applyDocumentThemeMode(isDark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle('dark', isDark);
  // Palette light-dark() values and Astryx's .dark mode must switch together.
  root.style.colorScheme = isDark ? 'dark' : 'light';
}

export function applyDocumentThemePalette(palette: ThemePalette): void {
  const root = document.documentElement;
  if (palette === 'default') root.removeAttribute('data-maka-theme');
  else root.setAttribute('data-maka-theme', palette);
}

export function applyDocumentUiFontSize(size: number): number {
  const next = normalizeUiFontSize(size);
  document.documentElement.style.fontSize = `${BROWSER_ROOT_FONT_SIZE_PX * next / TYPE_SCALE_BASE_PX}px`;
  return next;
}
