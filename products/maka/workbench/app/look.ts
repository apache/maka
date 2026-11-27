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

// The desktop window's look (Settings › General › Theme): the colors a person
// picks for each appearance, the font and the shape (corners, lines, shadow,
// letter spacing), kept in the shape of an NSH theme file (`cssVars`, shadcn's
// and tweakcn's names, lengths in points) so it can later be exported as one.
// The colors picked are used as they are; the ones derived from them (steps of
// the surfaces, the accent as text and the text on the accent) are made to
// stay readable.
import { paletteTokens, parseHex, toHex, type PaletteRecipe } from './colorPalette';

export type LookId =
  | 'default'
  | 'mono'
  | 'paper'
  | 'morandi'
  | 'terminal'
  | 'blueprint'
  | 'bauhaus'
  | 'brutalist';
export const lookIds: LookId[] = [
  'default',
  'mono',
  'paper',
  'morandi',
  'terminal',
  'blueprint',
  'bauhaus',
  'brutalist',
];

/** The colors picked for one appearance; the last three are derived while left out. */
export type LookColors = {
  background: string;
  foreground: string;
  primary: string;
  card?: string;
  border?: string;
  'muted-foreground'?: string;
  /** The shadow's color in this appearance, black while left out. */
  'shadow-color'?: string;
};
export type LookColor = Exclude<keyof LookColors, 'shadow-color'>;
export const pickedColors: LookColor[] = ['background', 'foreground', 'primary'];
export const derivedColors: LookColor[] = ['card', 'border', 'muted-foreground'];

/** The shape a look gives the window; each left out is the default's (`defaultShape`). */
export type LookShape = {
  /** A control's corner radius; the window's other corners scale with it. */
  radius?: number;
  /** The width of the line around a control, a field or a card. */
  'border-width'?: number;
  /** Space added between the letters of a conversation's text. */
  'letter-spacing'?: number;
  'shadow-x'?: number;
  'shadow-y'?: number;
  'shadow-blur'?: number;
  'shadow-spread'?: number;
  /** 0: no shadow. */
  'shadow-opacity'?: number;
};
export type ShapeKey = keyof LookShape;
export const defaultShape: Required<LookShape> = {
  radius: 8,
  'border-width': 1,
  'letter-spacing': 0,
  'shadow-x': 0,
  'shadow-y': 0,
  'shadow-blur': 0,
  'shadow-spread': 0,
  'shadow-opacity': 0,
};
const shapeKeys = Object.keys(defaultShape) as ShapeKey[];
/** The range of each shape value a look may hold. */
export const shapeLimits: Record<ShapeKey, [min: number, max: number]> = {
  radius: [0, 20],
  'border-width': [1, 3],
  'letter-spacing': [-0.5, 1.5],
  'shadow-x': [-12, 12],
  'shadow-y': [-12, 12],
  'shadow-blur': [0, 32],
  'shadow-spread': [-8, 8],
  'shadow-opacity': [0, 1],
};
/** A look's value of `key`, the default's where it has none. */
export const shapeValue = (look: Look, key: ShapeKey) =>
  look.cssVars.theme[key] ?? defaultShape[key];

export type Look = {
  /** The preset it started from. */
  base: LookId;
  cssVars: {
    light: LookColors;
    dark: LookColors;
    theme: { 'font-sans'?: string } & LookShape;
  };
};

export type FontChoice = 'system' | 'serif' | 'mono' | 'geometric';
export const fontChoices: FontChoice[] = ['system', 'serif', 'mono', 'geometric'];
// Lists as CSS writes them: each platform draws with the first family it has.
export const fontFamilies: Record<Exclude<FontChoice, 'system'>, string> = {
  serif: 'Georgia, "Songti SC", "Noto Serif CJK SC", serif',
  mono: 'Menlo, Consolas, "PingFang SC", monospace',
  geometric: 'Futura, "Century Gothic", "PingFang SC", sans-serif',
};
/** The choice a font family is, or null for one typed by name. */
export const fontChoice = (family: string | undefined): FontChoice | null =>
  family === undefined
    ? 'system'
    : ((Object.entries(fontFamilies).find(([, value]) => value === family)?.[0] as FontChoice) ??
      null);

const look = (
  base: LookId,
  light: LookColors,
  dark: LookColors,
  font?: Exclude<FontChoice, 'system'>,
  shape: LookShape = {},
): Look => ({
  base,
  cssVars: {
    light,
    dark,
    theme: { ...(font ? { 'font-sans': fontFamilies[font] } : {}), ...shape },
  },
});
/** The shadow starting points the editor offers, by name. */
export const shadowPresets = {
  soft: { 'shadow-y': 2, 'shadow-blur': 12, 'shadow-opacity': 0.08 },
  hard: { 'shadow-x': 4, 'shadow-y': 4, 'shadow-opacity': 1 },
} satisfies Record<string, LookShape>;

/** Each preset's look; the default is the window's own colors, which `defaultLook` names. */
export const presetLooks: Record<LookId, Look> = {
  default: look(
    'default',
    {
      background: '#ffffff',
      foreground: '#1c1d1f',
      primary: '#2f6bd8',
      card: '#f5f5f6',
      border: '#dcdde0',
      'muted-foreground': '#6c7079',
    },
    {
      background: '#202123',
      foreground: '#f0f1f3',
      primary: '#8ab8f8',
      card: '#161719',
      border: '#37393e',
      'muted-foreground': '#969ba4',
    },
  ),
  mono: look(
    'mono',
    { background: '#ffffff', foreground: '#0a0a0a', primary: '#0a0a0a', border: '#e5e5e5' },
    { background: '#0a0a0a', foreground: '#ededed', primary: '#ededed', border: '#2a2a2a' },
    undefined,
    { radius: 6 },
  ),
  paper: look(
    'paper',
    { background: '#f6f1e5', foreground: '#23201c', primary: '#b5392a', border: '#d9d0bc' },
    { background: '#1d1b18', foreground: '#e9e2d2', primary: '#d4574a', border: '#3a362f' },
    'serif',
    { radius: 2, 'letter-spacing': 0.5 },
  ),
  morandi: look(
    'morandi',
    { background: '#f1efec', foreground: '#3f3d3b', primary: '#7d8f8a', border: '#ddd9d4' },
    { background: '#2b2a2c', foreground: '#e4e0dc', primary: '#a9bab5', border: '#454347' },
    undefined,
    { radius: 12, ...shadowPresets.soft },
  ),
  terminal: look(
    'terminal',
    {
      background: '#efebdd',
      foreground: '#1f3a22',
      primary: '#a85a00',
      border: '#c9c3ae',
      'shadow-color': '#7ce38b',
    },
    {
      background: '#0c0f0a',
      foreground: '#b8f5b0',
      primary: '#ffb000',
      border: '#1f3a22',
      'shadow-color': '#7ce38b',
    },
    'mono',
    { radius: 0, 'shadow-blur': 8, 'shadow-opacity': 0.25 },
  ),
  blueprint: look(
    'blueprint',
    { background: '#f7fafd', foreground: '#123a6b', primary: '#1f5fa8', border: '#9db7d6' },
    { background: '#123a6b', foreground: '#eaf2fb', primary: '#9fd3ff', border: '#5c86b8' },
    'mono',
    { radius: 2, 'letter-spacing': 0.5 },
  ),
  bauhaus: look(
    'bauhaus',
    { background: '#f4f1ea', foreground: '#111111', primary: '#d62b1f', border: '#111111' },
    { background: '#141414', foreground: '#f2efe8', primary: '#f2c12e', border: '#5a5a5a' },
    'geometric',
    { radius: 0, 'border-width': 2, 'letter-spacing': 0.3 },
  ),
  brutalist: look(
    'brutalist',
    {
      background: '#fff8e7',
      foreground: '#000000',
      primary: '#ffd60a',
      border: '#000000',
      'shadow-color': '#000000',
    },
    // On a dark background a light shadow reads as a glow: the lines are a light gray and
    // the shadow a dark one, only a little lighter than the background.
    {
      background: '#16161a',
      foreground: '#ffffff',
      primary: '#ffd60a',
      border: '#b9b9c0',
      'shadow-color': '#55555e',
    },
    undefined,
    { radius: 6, 'border-width': 2, ...shadowPresets.hard },
  ),
};

const colorKeys: LookColor[] = [...pickedColors, ...derivedColors];
const sameColors = (a: LookColors, b: LookColors) => colorKeys.every((key) => a[key] === b[key]);
const outlineKeys = shapeKeys.filter((key) => !key.startsWith('shadow-'));
/** Whether two looks draw alike: the same colors, font, corners, lines and shadow, from whichever
 * preset. Shadows compare as drawn, so one at no opacity is none. */
export const sameAppearance = (a: Look, b: Look) =>
  sameColors(a.cssVars.light, b.cssVars.light) &&
  sameColors(a.cssVars.dark, b.cssVars.dark) &&
  a.cssVars.theme['font-sans'] === b.cssVars.theme['font-sans'] &&
  outlineKeys.every((key) => shapeValue(a, key) === shapeValue(b, key)) &&
  lookShadow(a, false) === lookShadow(b, false) &&
  lookShadow(a, true) === lookShadow(b, true);
/** Whether two looks, or the absence of one, are the same. */
export const sameLook = (a: Look | null, b: Look | null) =>
  a === b || (!!a && !!b && a.base === b.base && sameAppearance(a, b));
/** Whether a look is its preset unchanged. */
export const unchanged = (value: Look) => sameAppearance(value, presetLooks[value.base]);

const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value);
const validColors = (value: unknown): value is LookColors => {
  const colors = value as Record<string, unknown> | null;
  return (
    !!colors &&
    typeof colors === 'object' &&
    pickedColors.every((key) => hex(colors[key])) &&
    [...derivedColors, 'shadow-color'].every((key) => colors[key] === undefined || hex(colors[key]))
  );
};
/** The shape values among `theme` that are numbers in their range. */
const readShape = (theme: Record<string, unknown> | undefined): LookShape =>
  Object.fromEntries(
    shapeKeys.flatMap((key) => {
      const value = theme?.[key];
      const [min, max] = shapeLimits[key];
      return typeof value === 'number' && value >= min && value <= max ? [[key, value]] : [];
    }),
  );
/** A saved look, or null when it is not one. */
export function readLook(value: unknown): Look | null {
  const saved = value as Look | null;
  if (
    !saved ||
    typeof saved !== 'object' ||
    !lookIds.includes(saved.base) ||
    !validColors(saved.cssVars?.light) ||
    !validColors(saved.cssVars?.dark)
  )
    return null;
  const font = saved.cssVars.theme?.['font-sans'];
  return {
    base: saved.base,
    cssVars: {
      light: { ...saved.cssVars.light },
      dark: { ...saved.cssVars.dark },
      theme: {
        ...(typeof font === 'string' && font.trim() ? { 'font-sans': font } : {}),
        ...readShape(saved.cssVars.theme),
      },
    },
  };
}

/** What a theme block, written by Maka in a reply or pasted, describes: its preset with the
 * block's values over it, the values that are not valid left out and counted. */
export type ThemeBlock = { look: Look; name: string | null; ignored: number };
const blockName = 40;
/** The theme `value` describes, or null when it is not an object naming a preset. */
export function readThemeBlock(value: unknown): ThemeBlock | null {
  const block = value as Record<string, unknown> | null;
  if (!block || typeof block !== 'object' || !lookIds.includes(block.base as LookId)) return null;
  const preset = presetLooks[block.base as LookId];
  const vars = (block.cssVars ?? {}) as Record<string, unknown>;
  const entries = (part: unknown) =>
    part && typeof part === 'object' ? Object.entries(part as Record<string, unknown>) : [];
  let ignored = 0;
  const colors = (mode: 'light' | 'dark'): LookColors => {
    const out: Record<string, string> = { ...preset.cssVars[mode] };
    for (const [key, color] of entries(vars[mode])) {
      const value = typeof color === 'string' ? color.toLowerCase() : color;
      if ([...colorKeys, 'shadow-color'].includes(key as LookColor) && hex(value)) out[key] = value;
      else ignored++;
    }
    return out as LookColors;
  };
  const theme: Record<string, unknown> = { ...preset.cssVars.theme };
  for (const [key, value] of entries(vars.theme)) {
    const limits = shapeLimits[key as ShapeKey];
    if (key === 'font-sans' && typeof value === 'string' && value.trim()) theme[key] = value;
    else if (limits && typeof value === 'number' && value >= limits[0] && value <= limits[1])
      theme[key] = value;
    else ignored++;
  }
  const name = typeof block.name === 'string' ? block.name.trim().slice(0, blockName) : '';
  return {
    look: {
      base: preset.base,
      cssVars: {
        light: colors('light'),
        dark: colors('dark'),
        theme: theme as Look['cssVars']['theme'],
      },
    },
    name: name || null,
    ignored,
  };
}
/** Whether a color picked in `look` reads below its minimum against the background, in either
 * appearance: what the editor warns of. */
export const hardToRead = (look: Look) =>
  (['light', 'dark'] as const).some((mode) => {
    const colors = look.cssVars[mode];
    return Object.entries(minimumContrast).some(([key, minimum]) => {
      const color = colors[key as LookColor];
      return color !== undefined && contrast(color, colors.background) < minimum!;
    });
  });

/** A corner of radius `n` at the default radius (8), as a look of radius `r` draws it: every
 * corner scales alike, a panel's no rounder than 24. */
export const scaledRadius = (n: number, r: number) =>
  Math.min(Math.round((n * r) / defaultShape.radius), Math.max(n, 24));

/** The look's shadow in one appearance as CSS, its offsets and blur times `scale`; null for none. */
export function lookShadow(value: Look, dark: boolean, scale = 1): string | null {
  const opacity = shapeValue(value, 'shadow-opacity');
  if (opacity <= 0) return null;
  const color = value.cssVars[dark ? 'dark' : 'light']['shadow-color'] ?? '#000000';
  const alpha = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, '0');
  const at = (key: ShapeKey) => shapeValue(value, key) * scale;
  return `${at('shadow-x')}px ${at('shadow-y')}px ${at('shadow-blur')}px ${shapeValue(value, 'shadow-spread')}px ${color}${alpha}`;
}

/** The look a palette of the earlier Settings made, with the colors it showed. */
export function lookFromRecipe(recipe: PaletteRecipe): Look {
  const colors = (dark: boolean): LookColors => {
    const tokens = paletteTokens(recipe, dark);
    // The dark window's content sits on `surface` and its sidebar on `background`.
    return {
      background: dark ? tokens.surface : tokens.background,
      foreground: tokens.text,
      primary: tokens.accent,
      card: dark ? tokens.background : tokens.surface,
      border: tokens.line,
      'muted-foreground': tokens.muted,
    };
  };
  return { base: 'morandi', cssVars: { light: colors(false), dark: colors(true), theme: {} } };
}

type Lab = [number, number, number];
const lab = (color: string): Lab => {
  const [L, C, h] = parseHex(color) ?? [0, 0, 0];
  return [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
};
const fromLab = ([L, a, b]: Lab) =>
  toHex([
    Math.min(1, Math.max(0, L)),
    Math.hypot(a, b),
    ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360,
  ]);
/** `from` moved toward `to` by `t` in OKLab. */
export const mix = (from: string, to: string, t: number) => {
  const [a, b] = [lab(from), lab(to)];
  return fromLab([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
};
const lighten = (color: string, by: number) => {
  const [L, a, b] = lab(color);
  return fromLab([L + by, a, b]);
};

const luminance = (color: string) => {
  const n = Number.parseInt(color.slice(1, 7), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
};
/** WCAG's contrast ratio of two `#rrggbb` colors, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
/** Whether text in the window reads as on a dark background. */
export const darkBackground = (color: string) => lab(color)[0] < 0.6;

/** `color` lightened or darkened as little as it takes to reach `ratio` against `against`. */
export function readable(color: string, against: string, ratio: number): string {
  if (contrast(color, against) >= ratio) return color;
  // Toward the pole farther from `against`: white or black reaches 4.58:1 on any color.
  const target =
    contrast('#ffffff', against) >= contrast('#000000', against) ? '#ffffff' : '#000000';
  let [low, high] = [0, 1];
  for (let i = 0; i < 16; i++) {
    const middle = (low + high) / 2;
    if (contrast(mix(color, target, middle), against) >= ratio) high = middle;
    else low = middle;
  }
  return mix(color, target, high);
}

/** The readable minimum of each picked text color against the background. The accent has
 * none: text in it (`accentText`) and on it (`onAccent`) is made readable from it. */
export const minimumContrast: Partial<Record<LookColor, number>> = {
  foreground: 4.5,
  'muted-foreground': 4.5,
};

/** The window's colors a look sets, made from what was picked for one appearance. */
export type LookTokens = {
  background: string;
  surface: string;
  raised: string;
  sidebar: string;
  line: string;
  pressed: string;
  text: string;
  secondary: string;
  muted: string;
  accent: string;
  accentHover: string;
  accentText: string;
  onAccent: string;
};

// A look's colors are never changed in place, so each set is derived once however many views
// read it: the window, the theme preview and the editor's rows during a drag.
const derived = new WeakMap<LookColors, LookTokens>();
/** The tokens of one appearance's colors. Regions follow whether its background is dark: the
 * content sits on `background` in a light window, on `surface` in a dark one. The sidebar is
 * the picked `card`, else the step below the content. */
export function lookTokens(colors: LookColors): LookTokens {
  let tokens = derived.get(colors);
  if (!tokens) derived.set(colors, (tokens = deriveTokens(colors)));
  return tokens;
}
function deriveTokens(colors: LookColors): LookTokens {
  const { background: content, foreground: text, primary: accent } = colors;
  const dark = darkBackground(content);
  const muted =
    colors['muted-foreground'] ?? readable(mix(text, content, dark ? 0.38 : 0.42), content, 4.5);
  // A picked border may be as strong as the text; the fills a step up keep to the derived tone.
  const pressed = mix(content, text, dark ? 0.13 : 0.14);
  const below = dark ? mix(content, '#000000', 0.16) : mix(content, text, 0.04);
  const tones = dark
    ? { background: below, surface: content, raised: mix(content, text, 0.06) }
    : { background: content, surface: below, raised: mix(content, text, 0.08) };
  return {
    ...tones,
    sidebar: colors.card ?? below,
    line: colors.border ?? pressed,
    pressed,
    text,
    secondary: mix(text, muted, 0.5),
    muted,
    accent,
    accentHover: lighten(accent, dark ? 0.08 : -0.07),
    accentText: readable(accent, content, 4.5),
    onAccent: contrast('#ffffff', accent) >= contrast('#111111', accent) ? '#ffffff' : '#111111',
  };
}
