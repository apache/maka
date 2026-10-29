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

// The desktop window's appearance (Settings › General): its colors, its
// palette and its text size, kept in the app's storage. Terminals keep their own.
import { host as shell, setColorScheme, signal, Storage, type Signal } from 'nsh';
import { ownTitleBar } from './chrome';
import { parseHex, presetRecipes, type PaletteId, type PaletteRecipe } from './colorPalette';

export type ColorTheme = 'system' | 'light' | 'dark';
export const colorThemes: ColorTheme[] = ['system', 'light', 'dark'];
export const textSizes = [0.9, 1, 1.15, 1.3];

export const paletteIds: PaletteId[] = [
  'default',
  'mist',
  'sage',
  'sand',
  'burgundy',
  'graphite',
  'custom',
];

const THEME = 'appearance-theme';
const TEXT_SIZE = 'appearance-text-size';
const PALETTE = 'appearance-palette';
const CUSTOM_PALETTE = 'appearance-custom-palette';
// The root, Settings and each other UI package bundle their own copy of this
// module. They share one state, kept on the global object, so a choice made in
// Settings recolors every package's view, and the first to start loads it.
const STATE = Symbol.for('maka.appearance');
type State = {
  theme: Signal<ColorTheme>;
  textSize: Signal<number>;
  palette: Signal<PaletteId>;
  custom: Signal<PaletteRecipe>;
  initialized: boolean;
};
const shared = globalThis as { [STATE]?: State };
const state = (shared[STATE] ??= {
  theme: signal<ColorTheme>('system'),
  textSize: signal(1),
  palette: signal<PaletteId>('default'),
  // The custom palette starts from the first preset.
  custom: signal<PaletteRecipe>(presetRecipes.mist),
  initialized: false,
});
const { theme, textSize, palette, custom } = state;

const validRecipe = (value: unknown): value is PaletteRecipe => {
  const recipe = value as PaletteRecipe | null;
  return (
    typeof recipe?.hue === 'number' &&
    typeof recipe.tint === 'number' &&
    typeof recipe.accent === 'string' &&
    parseHex(recipe.accent) !== null
  );
};

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
  palette,
  custom,
  /** The recipe in effect, or null for the default palette. */
  recipe(): PaletteRecipe | null {
    const id = palette();
    return id === 'default' ? null : id === 'custom' ? custom() : presetRecipes[id];
  },
  choosePalette(value: PaletteId) {
    palette.set(value);
    void Storage.setItem(PALETTE, value).catch(() => undefined);
  },
  /** Changes the custom palette; `save` once the change ends (a slider let go). */
  changeCustom(change: Partial<PaletteRecipe>, save: boolean) {
    const next = { ...custom(), ...change };
    if (!validRecipe(next)) return;
    custom.set(next);
    if (save) void Storage.setItem(CUSTOM_PALETTE, JSON.stringify(next)).catch(() => undefined);
  },
  /** The next text size up (1) or down (-1), or the default (0): the View menu's. */
  stepTextSize(step: number) {
    const at = textSizes.indexOf(textSize());
    const next = step === 0 ? 1 : textSizes[at + step];
    if (next !== undefined && next !== textSize()) appearance.chooseTextSize(next);
  },
};

export function initializeAppearance() {
  if (state.initialized || !appearance.supported) return;
  state.initialized = true;
  void Storage.getItem(THEME)
    .then((value) => {
      if (value === 'light' || value === 'dark' || value === 'system') {
        theme.set(value);
        setColorScheme(value);
      }
    })
    .catch(() => undefined);
  void Storage.getItem(CUSTOM_PALETTE)
    .then((value) => {
      const recipe: unknown = value === null ? null : JSON.parse(value);
      if (validRecipe(recipe)) custom.set(recipe);
    })
    .catch(() => undefined);
  void Storage.getItem(PALETTE)
    .then((value) => {
      if (paletteIds.includes(value as PaletteId)) palette.set(value as PaletteId);
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
