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
// look and its text size, kept in the app's storage. Terminals keep their own.
import { host as shell, platform, setColorScheme, setTheme, signal, Storage } from 'nsh';
import { ownTitleBar } from './chrome';
import { parseHex, presetRecipes, type PaletteRecipe } from './colorPalette';
import {
  lookFromRecipe,
  presetLooks,
  readLook,
  sameLook,
  unchanged,
  type Look,
  type LookId,
} from './look';

export type ColorTheme = 'system' | 'light' | 'dark';
export const colorThemes: ColorTheme[] = ['system', 'light', 'dark'];
// The text size is chosen as the size of the conversation's text and kept as
// its ratio to the default, which scales every text of the window alike.
export const defaultTextSize = 14;
export const minTextSize = 12;
export const maxTextSize = 18;
const textScale = (size: number) => size / defaultTextSize;
// The largest ratio also admits 1.3, saved when sizes were four named steps.
const validTextScale = (scale: number) =>
  Number.isFinite(scale) && scale >= textScale(minTextSize) - 1e-6 && scale <= 1.3 + 1e-6;

export type TrayIcon = 'line' | 'bold' | 'tile' | 'none';
// Without its icon the window that was closed comes back from the Dock, which only macOS has.
export const trayIcons: TrayIcon[] =
  platform.os === 'macos' ? ['line', 'bold', 'tile', 'none'] : ['line', 'bold', 'tile'];

const THEME = 'appearance-theme';
const TEXT_SIZE = 'appearance-text-size';
const LOOK = 'appearance-look';
// The palette and custom recipe Settings kept before looks: read once into a look.
const PALETTE = 'appearance-palette';
const CUSTOM_PALETTE = 'appearance-custom-palette';
const TRAY_ICON = 'appearance-tray-icon';
type StorageKey = typeof THEME | typeof TEXT_SIZE | typeof LOOK | typeof TRAY_ICON;
// Steps a look's edits can be undone.
const UNDO_LIMIT = 50;
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
  const theme = signal<ColorTheme>('system');
  const textSize = signal(1);
  // Null: the default look unchanged, which the window's own colors draw.
  const look = signal<Look | null>(null);
  // The looks before each saved change, latest last.
  const history = signal<(Look | null)[]>([]);
  const trayIcon = signal<TrayIcon>('bold');
  // Only macOS can hide the icon, and must not show it before the saved choice is read.
  const trayIconKnown = signal(platform.os !== 'macos' || !ownTitleBar);
  let initialization: Initialization = {
    kind: 'uninitialized',
    pending: new Set([THEME, TEXT_SIZE, LOOK, TRAY_ICON]),
  };
  let persistence: Persistence = { kind: 'idle' };
  // The look last saved, which an undo step goes back to.
  let committed: Look | null = null;
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
      // Only the latest write to each setting waits behind the active write.
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
  const applyFont = (value: Look | null) => {
    const font = value?.cssVars.theme['font-sans'];
    try {
      setTheme(font ? { cssVars: { theme: { 'font-sans': font } } } : null);
    } catch {
      setTheme(null);
    }
  };
  const showLook = (value: Look | null) => {
    const shown = value && value.base === 'default' && unchanged(value) ? null : value;
    const font = look()?.cssVars.theme['font-sans'];
    look.set(shown);
    if (shown?.cssVars.theme['font-sans'] !== font) applyFont(shown);
  };
  const saveLook = () => persist(LOOK, JSON.stringify(look()));
  /** Shows `next`; `save` once the change ends (a picker let go), which can be undone. */
  const changeLook = (next: Look, save: boolean) => {
    selected(LOOK);
    if (!save) return showLook(next);
    const before = committed;
    showLook(next);
    committed = look();
    if (sameLook(before, committed)) return;
    history.set([...history(), before].slice(-UNDO_LIMIT));
    saveLook();
  };
  /** The palette Settings kept before looks, as the look it showed; null for none. */
  const legacyLook = async (): Promise<Look | null> => {
    const id = await Storage.getItem(PALETTE);
    if (id === null) return null;
    if (id !== 'custom') {
      const recipe = presetRecipes[id as keyof typeof presetRecipes];
      return recipe ? lookFromRecipe(recipe) : null;
    }
    const saved = await Storage.getItem(CUSTOM_PALETTE);
    let custom: unknown = null;
    try {
      custom = saved === null ? null : JSON.parse(saved);
    } catch {}
    return validRecipe(custom) ? lookFromRecipe(custom) : null;
  };
  /** The saved look; without one, the earlier palette's, saved as the look before the palette's
   * keys go. A look chosen meanwhile wins. */
  const restoreLook = async () => {
    if (initialization.kind !== 'loading' || !initialization.pending.has(LOOK)) return;
    try {
      const saved = await Storage.getItem(LOOK);
      const value = saved === null ? await legacyLook() : readLook(JSON.parse(saved));
      if (initialization.kind !== 'loading' || !initialization.pending.delete(LOOK)) return;
      showLook(value);
      committed = look();
      if (saved !== null) return;
      // Written once, so later starts read no palette keys; `null` is the default look.
      const migrated = look();
      await Storage.setItem(LOOK, JSON.stringify(migrated));
      // A look chosen during that write may have been saved before it.
      if (!sameLook(look(), migrated)) saveLook();
      await Promise.all([Storage.removeItem(PALETTE), Storage.removeItem(CUSTOM_PALETTE)]);
    } catch {}
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
    theme: () => theme(),
    textSize: () => textSize(),
    /** The size of the conversation's text at this ratio, in points. */
    fontSize: () => Math.round(textSize() * defaultTextSize),
    /** The look in effect, or null for the default one unchanged. */
    look: () => look(),
    trayIcon: () => trayIcon(),
    /** The tray icon is the saved choice, or the default where none is saved. */
    trayIconKnown: () => trayIconKnown(),
    chooseTheme(value: ColorTheme) {
      selected(THEME);
      theme.set(value);
      setColorScheme(value);
      persist(THEME, value);
    },
    chooseTextSize,
    /** The look shown, the default's when none is set. */
    shown: (): Look => look() ?? presetLooks.default,
    /** Starts over from a preset. */
    choosePreset: (id: LookId) => changeLook(presetLooks[id], true),
    changeLook,
    canUndo: () => history().length > 0,
    undo() {
      const steps = history();
      if (!steps.length) return;
      selected(LOOK);
      history.set(steps.slice(0, -1));
      showLook(steps.at(-1)!);
      committed = look();
      saveLook();
    },
    /** Back to the default look: the View menu's, which a look cannot hide. */
    resetLook() {
      if (look() !== null) changeLook(presetLooks.default, true);
    },
    chooseTrayIcon(value: TrayIcon) {
      selected(TRAY_ICON);
      trayIcon.set(value);
      trayIconKnown.set(true);
      persist(TRAY_ICON, value);
    },
    /** The next text size up (1) or down (-1), or the default (0): the View menu's. */
    stepTextSize(step: number) {
      const size = Math.round(textSize() * defaultTextSize);
      // A saved ratio between two sizes becomes the size it is shown as.
      const next =
        step === 0 ? defaultTextSize : Math.min(maxTextSize, Math.max(minTextSize, size + step));
      const scale = textScale(next);
      if (scale !== textSize()) chooseTextSize(scale);
    },
    saving: () => persistence.kind === 'saving',
    whenIdle: () => (persistence.kind === 'saving' ? persistence.completion : Promise.resolve()),
    /** Reads the saved choices; settles once they are applied. */
    initialize(): Promise<void> {
      if (initialization.kind !== 'uninitialized' || !ownTitleBar) return Promise.resolve();
      initialization = { kind: 'loading', pending: initialization.pending };
      return Promise.all([
        restore(THEME, (value) => {
          if (value === 'light' || value === 'dark' || value === 'system') {
            theme.set(value);
            setColorScheme(value);
          }
        }),
        restoreLook(),
        restore(TRAY_ICON, (value) => {
          if (trayIcons.includes(value as TrayIcon)) trayIcon.set(value as TrayIcon);
        }).then(() => trayIconKnown.set(true)),
        restore(TEXT_SIZE, (value) => {
          const scale = Number(value);
          if (value !== null && validTextScale(scale)) {
            textSize.set(scale);
            void applyTextSize(scale);
          }
        }),
      ]).then(() => {
        initialization = { kind: 'ready' };
      });
    },
  };
}

// Independent UI bundles share the window owner, including its in-flight reads and writes.
const OWNER = Symbol.for('maka.appearance');
const shared = globalThis as { [OWNER]?: ReturnType<typeof createAppearanceOwner> };
export const appearance = (shared[OWNER] ??= createAppearanceOwner());
export const initializeAppearance = appearance.initialize;
