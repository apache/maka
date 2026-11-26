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

// The desktop window's look (Settings › General › Look): the colors a person
// picks for each appearance and the font, kept in the shape of an NSH theme
// file (`cssVars`, shadcn's names) so it can later be exported as one. The
// colors picked are used as they are; the ones derived from them (steps of
// the surfaces, the accent as text and the text on the accent) are made to
// stay readable.
import { paletteTokens, parseHex, toHex, type PaletteRecipe } from './colorPalette';

export type LookId = 'default' | 'mono' | 'paper' | 'morandi' | 'terminal' | 'blueprint';
export const lookIds: LookId[] = ['default', 'mono', 'paper', 'morandi', 'terminal', 'blueprint'];

/** The colors picked for one appearance; the last three are derived while left out. */
export type LookColors = {
  background: string;
  foreground: string;
  primary: string;
  card?: string;
  border?: string;
  'muted-foreground'?: string;
};
export type LookColor = keyof LookColors;
export const pickedColors: LookColor[] = ['background', 'foreground', 'primary'];
export const derivedColors: LookColor[] = ['card', 'border', 'muted-foreground'];

export type Look = {
  /** The preset it started from. */
  base: LookId;
  cssVars: {
    light: LookColors;
    dark: LookColors;
    theme: { 'font-sans'?: string };
  };
};

export type FontChoice = 'system' | 'serif' | 'mono' | 'geometric';
export const fontChoices: FontChoice[] = ['system', 'serif', 'mono', 'geometric'];
// Lists as CSS writes them: each platform draws with the first family it has.
export const fontFamilies: Record<Exclude<FontChoice, 'system'>, string> = {
  serif: '"Songti SC", Georgia, "Noto Serif CJK SC", serif',
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
): Look => ({
  base,
  cssVars: { light, dark, theme: font ? { 'font-sans': fontFamilies[font] } : {} },
});

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
  ),
  paper: look(
    'paper',
    { background: '#f6f1e5', foreground: '#23201c', primary: '#b5392a', border: '#d9d0bc' },
    { background: '#1d1b18', foreground: '#e9e2d2', primary: '#d4574a', border: '#3a362f' },
    'serif',
  ),
  morandi: look(
    'morandi',
    { background: '#f1efec', foreground: '#3f3d3b', primary: '#7d8f8a', border: '#ddd9d4' },
    { background: '#2b2a2c', foreground: '#e4e0dc', primary: '#a9bab5', border: '#454347' },
  ),
  terminal: look(
    'terminal',
    { background: '#efebdd', foreground: '#1f3a22', primary: '#a85a00', border: '#c9c3ae' },
    { background: '#0c0f0a', foreground: '#b8f5b0', primary: '#ffb000', border: '#1f3a22' },
    'mono',
  ),
  blueprint: look(
    'blueprint',
    { background: '#f7fafd', foreground: '#123a6b', primary: '#1f5fa8', border: '#9db7d6' },
    { background: '#123a6b', foreground: '#eaf2fb', primary: '#9fd3ff', border: '#5c86b8' },
    'mono',
  ),
};

const sameColors = (a: LookColors, b: LookColors) =>
  pickedColors.concat(derivedColors).every((key) => a[key] === b[key]);
/** Whether two looks draw alike: the same colors and font, from whichever preset. */
export const sameAppearance = (a: Look, b: Look) =>
  sameColors(a.cssVars.light, b.cssVars.light) &&
  sameColors(a.cssVars.dark, b.cssVars.dark) &&
  a.cssVars.theme['font-sans'] === b.cssVars.theme['font-sans'];
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
    derivedColors.every((key) => colors[key] === undefined || hex(colors[key]))
  );
};
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
      theme: typeof font === 'string' && font.trim() ? { 'font-sans': font } : {},
    },
  };
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

/** The tokens of one appearance's colors. Regions follow whether its background is dark: the
 * content sits on `background` in a light window, on `surface` in a dark one. The sidebar is
 * the picked `card`, else the step below the content. */
export function lookTokens(colors: LookColors): LookTokens {
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
