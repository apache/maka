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

// The desktop window's appearance (Settings › General): its colors and its
// text size, kept in the app's storage. Terminals keep their own.
import { host as shell, setColorScheme, signal, Storage } from 'nsh';
import { ownTitleBar } from './chrome';

export type ColorTheme = 'system' | 'light' | 'dark';
export const colorThemes: ColorTheme[] = ['system', 'light', 'dark'];
export const textSizes = [0.9, 1, 1.15, 1.3];

const THEME = 'appearance-theme';
const TEXT_SIZE = 'appearance-text-size';
const theme = signal<ColorTheme>('system');
const textSize = signal(1);
let initialized = false;

const applyTextSize = (scale: number) =>
  shell.call('appearance.textSize', { scale }).catch(() => undefined);

export const appearance = {
  supported: ownTitleBar,
  theme,
  textSize,
  chooseTheme(value: ColorTheme) {
    theme.set(value);
    setColorScheme(value);
    void Storage.setItem(THEME, value).catch(() => undefined);
  },
  chooseTextSize(scale: number) {
    textSize.set(scale);
    void applyTextSize(scale);
    void Storage.setItem(TEXT_SIZE, String(scale)).catch(() => undefined);
  },
  /** The next text size up (1) or down (-1), or the default (0): the View menu's. */
  stepTextSize(step: number) {
    const at = textSizes.indexOf(textSize());
    const next = step === 0 ? 1 : textSizes[at + step];
    if (next !== undefined && next !== textSize()) appearance.chooseTextSize(next);
  },
};

export function initializeAppearance() {
  if (initialized || !appearance.supported) return;
  initialized = true;
  void Storage.getItem(THEME)
    .then((value) => {
      if (value === 'light' || value === 'dark' || value === 'system') {
        theme.set(value);
        setColorScheme(value);
      }
    })
    .catch(() => undefined);
  void Storage.getItem(TEXT_SIZE)
    .then((value) => {
      const scale = Number(value);
      if (value !== null && textSizes.includes(scale)) {
        textSize.set(scale);
        void applyTextSize(scale);
      }
    })
    .catch(() => undefined);
}
