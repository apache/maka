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
import { host as shell, setColorScheme, signal, Storage } from 'nsh';
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
type StorageKey = typeof THEME | typeof TEXT_SIZE | typeof PALETTE | typeof CUSTOM_PALETTE;
type Initialization =
  | { kind: 'uninitialized'; pending: Set<StorageKey> }
  | { kind: 'loading'; pending: Set<StorageKey> }
  | { kind: 'ready' };
type Persistence =
  | { kind: 'idle' }
  | { kind: 'saving'; pending: Map<StorageKey, string>; completion: Promise<void> };

const validRecipe = (value: unknown): value is PaletteRecipe => {
  const recipe = value as PaletteRecipe | null;
  return (
    typeof recipe?.hue === 'number' &&
    typeof recipe.tint === 'number' &&
    typeof recipe.accent === 'string' &&
    parseHex(recipe.accent) !== null
  );
};

function createAppearanceOwner() {
  const ready = signal(!ownTitleBar);
  const theme = signal<ColorTheme>('system');
  const textSize = signal(1);
  const palette = signal<PaletteId>('default');
  const custom = signal<PaletteRecipe>(presetRecipes.mist);
  let initialization: Initialization = {
    kind: 'uninitialized',
    pending: new Set([THEME, TEXT_SIZE, PALETTE, CUSTOM_PALETTE]),
  };
  let persistence: Persistence = { kind: 'idle' };
  const selected = (key: StorageKey) => {
    if (initialization.kind !== 'ready') initialization.pending.delete(key);
  };
  const persist = (key: StorageKey, value: string) => {
    if (persistence.kind === 'saving') {
      persistence.pending.set(key, value);
      return;
    }
    const pending = new Map<StorageKey, string>([[key, value]]);
    const completion = Promise.resolve().then(async () => {
      // Only the latest write to each of the four settings waits behind the active write.
      for (;;) {
        const next = pending.entries().next();
        if (next.done) break;
        const [key, value] = next.value;
        pending.delete(key);
        try {
          await Storage.setItem(key, value);
        } catch {
          continue;
        }
      }
      persistence = { kind: 'idle' };
    });
    persistence = { kind: 'saving', pending, completion };
  };
  const applyTextSize = (scale: number) =>
    shell.call('appearance.textSize', { scale }).catch(() => undefined);
  const chooseTextSize = (scale: number) => {
    selected(TEXT_SIZE);
    textSize.set(scale);
    void applyTextSize(scale);
    persist(TEXT_SIZE, String(scale));
  };
  const restore = (key: StorageKey, apply: (value: string | null) => void) => {
    if (initialization.kind === 'ready' || !initialization.pending.has(key))
      return Promise.resolve();
    return Storage.getItem(key)
      .then((value) => {
        if (initialization.kind === 'loading' && initialization.pending.delete(key)) apply(value);
      })
      .catch(() => undefined);
  };
  return {
    supported: ownTitleBar,
    ready,
    sync(value: { theme: ColorTheme; textSize: number; palette: PaletteId; custom: PaletteRecipe }) {
      theme.set(value.theme);
      setColorScheme(value.theme);
      textSize.set(value.textSize);
      palette.set(value.palette);
      custom.set(value.custom);
    },
    theme: () => theme(),
    textSize: () => textSize(),
    palette: () => palette(),
    custom: () => custom(),
    chooseTheme(value: ColorTheme) {
      selected(THEME);
      theme.set(value);
      setColorScheme(value);
      persist(THEME, value);
    },
    chooseTextSize,
    /** The recipe in effect, or null for the default palette. */
    recipe(): PaletteRecipe | null {
      const id = palette();
      return id === 'default' ? null : id === 'custom' ? custom() : presetRecipes[id];
    },
    choosePalette(value: PaletteId) {
      selected(PALETTE);
      palette.set(value);
      persist(PALETTE, value);
    },
    /** Changes the custom palette; `save` once the change ends (a slider let go). */
    changeCustom(change: Partial<PaletteRecipe>, save: boolean) {
      const next = { ...custom(), ...change };
      if (!validRecipe(next)) return;
      selected(CUSTOM_PALETTE);
      custom.set(next);
      if (save) persist(CUSTOM_PALETTE, JSON.stringify(next));
    },
    /** The next text size up (1) or down (-1), or the default (0): the View menu's. */
    stepTextSize(step: number) {
      const at = textSizes.indexOf(textSize());
      const next = step === 0 ? 1 : textSizes[at + step];
      if (next !== undefined && next !== textSize()) chooseTextSize(next);
    },
    saving: () => persistence.kind === 'saving',
    whenIdle: () => (persistence.kind === 'saving' ? persistence.completion : Promise.resolve()),
    initialize() {
      if (initialization.kind !== 'uninitialized' || !ownTitleBar) return;
      initialization = { kind: 'loading', pending: initialization.pending };
      void Promise.all([
        restore(THEME, (value) => {
          if (value === 'light' || value === 'dark' || value === 'system') {
            theme.set(value);
            setColorScheme(value);
          }
        }),
        restore(CUSTOM_PALETTE, (value) => {
          const recipe: unknown = value === null ? null : JSON.parse(value);
          if (validRecipe(recipe)) custom.set(recipe);
        }),
        restore(PALETTE, (value) => {
          if (paletteIds.includes(value as PaletteId)) palette.set(value as PaletteId);
        }),
        restore(TEXT_SIZE, (value) => {
          const scale = Number(value);
          if (value !== null && textSizes.includes(scale)) {
            textSize.set(scale);
            void applyTextSize(scale);
          }
        }),
      ]).then(() => {
        initialization = { kind: 'ready' };
        ready.set(true);
      });
    },
  };
}

// Independent UI bundles share the window owner, including its in-flight reads and writes.
const OWNER = Symbol.for('maka.appearance');
const shared = globalThis as { [OWNER]?: ReturnType<typeof createAppearanceOwner> };
export const appearance = (shared[OWNER] ??= createAppearanceOwner());
export const initializeAppearance = appearance.initialize;
